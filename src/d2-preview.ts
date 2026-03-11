/**
 * @module d2-preview
 * @description Standalone D2 file preview with pan & zoom.
 *
 * Opens a WebviewPanel to preview .d2 files directly,
 * without requiring a Markdown wrapper. Reuses the Diagram Viewer HTML
 * (pan & zoom) and renders via the D2 Wasm renderer.
 */
import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { generateViewerHtml, handleCopyResult } from './diagram-viewer.js';
import { renderD2ToSvg } from './d2-renderer.js';
import { LIGHT_THEME_KEYS, DARK_THEME_KEYS, getThemeBgColor } from './exporter.js';
import { getNonce, errorHtml, buildThemeItems } from './utils.js';
import { CONFIG_SECTION, D2_THEME_KEYS, D2_THEME_MAP, D2_LAYOUT_KEYS, type Config } from './config.js';
import { handleExportMessage } from './export-handler.js';

/** The singleton preview panel. */
let panel: vscode.WebviewPanel | null = null;

/** Absolute path of the currently previewed .d2 file. */
let currentFilePath: string | null = null;

/** Last known config snapshot. */
let lastConfig: Config | null = null;

/** Local preview theme (not synced to settings). */
let localPreviewTheme: string | null = null;

/** Local D2 theme (not synced to settings). */
let localD2Theme: string | null = null;

/** Local D2 layout (not synced to settings). */
let localD2Layout: string | null = null;

/** Debounce timer for text document changes. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Disposables tied to the current panel lifecycle. */
const panelDisposables: vscode.Disposable[] = [];

/** Monotonically increasing render sequence to discard stale results. */
let renderSeq = 0;

/** AbortController for the current in-flight render. */
let renderAbort: AbortController | null = null;

/** Get the effective preview theme (local override > config). */
function getPreviewTheme(): string {
    return localPreviewTheme ?? (lastConfig ? lastConfig.previewTheme : 'github-light');
}

/** Get the effective D2 theme (local override > config). */
function getD2Theme(): string {
    return localD2Theme ?? (lastConfig ? lastConfig.d2Theme : 'Neutral Default');
}

/** Get the effective D2 layout (local override > config). */
function getD2Layout(): string {
    return localD2Layout ?? (lastConfig ? lastConfig.d2Layout : 'dagre');
}

/** Get the background color for the current preview theme. */
function getCurrentBgColor(): string {
    return getThemeBgColor(getPreviewTheme());
}

/**
 * Open (or reveal) a preview panel for the given .d2 file.
 */
export async function openD2Preview(filePath: string, config: Config): Promise<void> {
    lastConfig = config;
    currentFilePath = filePath;

    if (panel) {
        panel.reveal(vscode.ViewColumn.Two, true);
        await renderCurrentFile();
        return;
    }

    // Render SVG before creating the panel so it opens with the actual diagram
    const initialSvg = await renderInitialSvg(filePath, config);
    if (!initialSvg) return;

    panel = vscode.window.createWebviewPanel(
        'plantumlD2Preview',
        makePanelTitle(filePath),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
            enableScripts: true,
            retainContextWhenHidden: vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('retainPreviewContext', true),
            localResourceRoots: []
        }
    );

    panel.webview.html = generateViewerHtml(initialSvg, getNonce(), getCurrentBgColor());

    panel.onDidDispose(() => {
        panel = null;
        currentFilePath = null;
        for (const d of panelDisposables) d.dispose();
        panelDisposables.length = 0;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (renderAbort) { renderAbort.abort(); renderAbort = null; }
    });

    panel.webview.onDidReceiveMessage((msg) => {
        void handleViewerMessage(msg);
    });

    // Watch text document changes for live preview
    panelDisposables.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!currentFilePath) return;
            if (e.document.uri.fsPath !== currentFilePath) return;
            scheduleRender();
        })
    );

    // Watch file saves for re-render (catches external changes)
    panelDisposables.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!currentFilePath) return;
            if (doc.uri.fsPath !== currentFilePath) return;
            scheduleRender();
        })
    );
}

/**
 * Update config reference. Called when settings change.
 */
export function updateD2Config(config: Config): void {
    const prevConfig = lastConfig;
    lastConfig = config;
    if (!panel || !prevConfig) return;

    // Re-render for global d2Theme/d2Layout changes when no local override
    if ((!localD2Theme && prevConfig.d2Theme !== config.d2Theme)
        || (!localD2Layout && prevConfig.d2Layout !== config.d2Layout)) {
        scheduleRender();
    }
}

/**
 * Get the currently previewed .d2 file path.
 */
export function getCurrentD2FilePath(): string | null {
    return currentFilePath;
}

/**
 * Get the preview panel (for save commands).
 */
export function getD2PreviewPanel(): vscode.WebviewPanel | null {
    return panel;
}

/**
 * Dispose the preview panel and clean up.
 */
export function disposeD2Preview(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (renderAbort) { renderAbort.abort(); renderAbort = null; }
    if (panel) {
        panel.dispose();
        panel = null;
    }
    currentFilePath = null;
}

/** Render the initial SVG for a .d2 file (before the panel exists). */
async function renderInitialSvg(filePath: string, config: Config): Promise<string | null> {
    let content: string;
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (openDoc) {
        content = openDoc.getText();
    } else {
        try {
            content = await readFile(filePath, 'utf-8');
        } catch {
            return null;
        }
    }
    return renderSvg(content);
}

/** Schedule a debounced re-render. */
function scheduleRender(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    const delay = lastConfig?.debounceDiagramChangeMs ?? 300;
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void renderCurrentFile();
    }, delay);
}

/** Render the current .d2 file and update the webview. */
async function renderCurrentFile(): Promise<void> {
    if (!panel || !currentFilePath || !lastConfig) return;

    if (renderAbort) renderAbort.abort();
    renderAbort = new AbortController();
    const signal = renderAbort.signal;
    const seq = ++renderSeq;

    panel.title = makePanelTitle(currentFilePath);

    let content: string;
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === currentFilePath);
    if (openDoc) {
        content = openDoc.getText();
    } else {
        try {
            content = await readFile(currentFilePath, 'utf-8');
        } catch {
            panel.webview.html = generateViewerHtml(
                errorHtml(vscode.l10n.t('File not found: {0}', currentFilePath)),
                getNonce()
            );
            return;
        }
    }

    if (signal.aborted || seq !== renderSeq) return;

    const svg = await renderSvg(content);
    if (signal.aborted || seq !== renderSeq) return;

    void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor: getCurrentBgColor() });
}

/** Render D2 content to SVG. */
async function renderSvg(content: string): Promise<string> {
    const themeID = D2_THEME_MAP.get(getD2Theme()) ?? 0;
    const layout = getD2Layout();
    try {
        return await renderD2ToSvg(content, themeID, layout);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorHtml(msg);
    }
}

/** Handle messages from the viewer webview. */
async function handleViewerMessage(msg: { type: string; format?: string; data?: string; success?: boolean }): Promise<void> {
    if (msg.type === 'copyDiagramResult') {
        handleCopyResult(!!msg.success);
        return;
    }
    return handleExportMessage(msg, currentFilePath);
}

/**
 * Show a theme QuickPick for the .d2 preview.
 */
export async function changeD2Theme(): Promise<void> {
    if (!panel) return;

    const currentPreviewTheme = getPreviewTheme();
    const currentD2ThemeName = getD2Theme();
    const currentD2LayoutName = getD2Layout();

    const items = [
        { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(LIGHT_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(DARK_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        { label: vscode.l10n.t('D2 Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems([...D2_THEME_KEYS], 'd2' as const, currentD2ThemeName),
        { label: vscode.l10n.t('D2 Layout'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems([...D2_LAYOUT_KEYS], 'd2layout' as const, currentD2LayoutName),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select theme')
    });
    if (!panel) return;

    if (!selected || !('category' in selected)) return;

    if (selected.category === 'preview') {
        if (selected.themeKey === currentPreviewTheme) return;
        localPreviewTheme = selected.themeKey;
        await renderCurrentFile();
    } else if (selected.category === 'd2') {
        if (selected.themeKey === currentD2ThemeName) return;
        localD2Theme = selected.themeKey;
        scheduleRender();
    } else if (selected.category === 'd2layout') {
        if (selected.themeKey === currentD2LayoutName) return;
        localD2Layout = selected.themeKey;
        scheduleRender();
    }
}

/** Generate a panel title from the file path. */
function makePanelTitle(filePath: string): string {
    const name = filePath.split(/[/\\]/).pop() ?? 'D2';
    return `${name} ${vscode.l10n.t('(Preview)')}`;
}
