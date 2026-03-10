/**
 * @module puml-preview
 * @description Standalone PlantUML file preview with pan & zoom.
 *
 * Opens a WebviewPanel to preview .puml / .plantuml files directly,
 * without requiring a Markdown wrapper. Reuses the Diagram Viewer HTML
 * (pan & zoom) and renders via renderToSvgAsync / renderToSvgServer.
 */
import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { generateViewerHtml } from './diagram-viewer.js';
import { renderToSvgAsync, listThemesAsync, prefetchThemes } from './plantuml.js';
import { renderToSvgServer } from './plantuml-server.js';
import { LIGHT_THEME_KEYS, DARK_THEME_KEYS, getThemeBgColor } from './exporter.js';
import { getLocalServerUrl, waitForLocalServer } from './local-server.js';
import { getNonce, errorHtml, buildThemeItems } from './utils.js';
import { CONFIG_SECTION, type Config } from './config.js';
import { handleExportMessage } from './export-handler.js';

/** The singleton preview panel. */
let panel: vscode.WebviewPanel | null = null;

/** Absolute path of the currently previewed .puml file. */
let currentFilePath: string | null = null;

/** Last known config snapshot. */
let lastConfig: Config | null = null;

/** Local preview theme (not synced to settings). */
let localPreviewTheme: string | null = null;

/** Local PlantUML theme (not synced to settings). */
let localPlantumlTheme: string | null = null;

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

/** Get the effective PlantUML theme (local override > config). */
function getPlantumlTheme(): string {
    return localPlantumlTheme ?? (lastConfig ? lastConfig.plantumlTheme : 'default');
}

/** Get the background color for the current preview theme. */
function getCurrentBgColor(): string {
    return getThemeBgColor(getPreviewTheme());
}

/**
 * Open (or reveal) a preview panel for the given .puml file.
 */
export async function openPumlPreview(filePath: string, config: Config): Promise<void> {
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
        'plantumlPumlPreview',
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

    // Pre-fetch PlantUML theme list so the QuickPick menu is instant
    if (config.renderMode !== 'server') {
        prefetchThemes(config);
    }
}

/**
 * Update config reference. Called when settings change.
 *
 * @param config - The new extension configuration.
 */
export function updatePumlConfig(config: Config): void {
    const prevConfig = lastConfig;
    lastConfig = config;
    if (!panel || !prevConfig) return;

    // Only re-render for global plantumlTheme changes when no local override
    if (!localPlantumlTheme && prevConfig.plantumlTheme !== config.plantumlTheme) {
        scheduleRender();
    }
}

/**
 * Get the currently previewed .puml file path.
 *
 * @returns Absolute file path, or null if no preview is open.
 */
export function getCurrentPumlFilePath(): string | null {
    return currentFilePath;
}

/**
 * Get the preview panel (for save commands).
 *
 * @returns The active WebviewPanel, or null if no preview is open.
 */
export function getPumlPreviewPanel(): vscode.WebviewPanel | null {
    return panel;
}

/**
 * Dispose the preview panel and clean up.
 */
export function disposePumlPreview(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (renderAbort) { renderAbort.abort(); renderAbort = null; }
    if (panel) {
        panel.dispose();
        panel = null;
    }
    currentFilePath = null;
}

/** Render the initial SVG for a .puml file (before the panel exists). */
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
    const effectiveConfig = localPlantumlTheme
        ? { ...config, plantumlTheme: localPlantumlTheme }
        : config;
    return renderSvg(content, effectiveConfig);
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

/** Render the current .puml file and update the webview. */
async function renderCurrentFile(): Promise<void> {
    if (!panel || !currentFilePath || !lastConfig) return;

    // Cancel previous in-flight render
    if (renderAbort) renderAbort.abort();
    renderAbort = new AbortController();
    const signal = renderAbort.signal;
    const seq = ++renderSeq;

    // Update panel title
    panel.title = makePanelTitle(currentFilePath);

    // Read file content (prefer open editor buffer over disk)
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

    // Render SVG based on mode (use local PlantUML theme override if set)
    const effectiveConfig = localPlantumlTheme
        ? { ...lastConfig, plantumlTheme: localPlantumlTheme }
        : lastConfig;
    const svg = await renderSvg(content, effectiveConfig, signal);
    if (signal.aborted || seq !== renderSeq) return;

    // Update webview
    void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor: getCurrentBgColor() });
}

/** Render PlantUML content to SVG using the appropriate mode. */
async function renderSvg(content: string, config: Config, signal?: AbortSignal): Promise<string> {
    if (config.renderMode === 'local-server') {
        await waitForLocalServer();
        const localUrl = getLocalServerUrl();
        if (localUrl) {
            const serverConfig = { ...config, plantumlServerUrl: localUrl };
            return renderToSvgServer(content, serverConfig, signal);
        }
        return errorHtml(vscode.l10n.t('Local PlantUML server is not running. Check the output panel for details.'));
    }
    if (config.renderMode === 'server') {
        return renderToSvgServer(content, config, signal);
    }
    return renderToSvgAsync(content, config, signal);
}

/** Handle messages from the viewer webview (PNG/SVG export). */
async function handleViewerMessage(msg: { type: string; format?: string; data?: string }): Promise<void> {
    return handleExportMessage(msg, currentFilePath);
}

/**
 * Show a theme QuickPick for the .puml preview (no Mermaid section).
 * Theme selection is local to this preview and does not affect other previews.
 */
export async function changePumlTheme(): Promise<void> {
    if (!panel) return;

    const currentPreviewTheme = getPreviewTheme();
    const currentPlantumlTheme = getPlantumlTheme();

    // listThemesAsync caches internally; prefetchThemes is called on first open
    const plantumlThemes = await listThemesAsync(lastConfig || { plantumlJarPath: '', javaPath: 'java' });
    if (!panel) return;

    const items = [
        { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(LIGHT_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(DARK_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        { label: vscode.l10n.t('PlantUML Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(['default', ...plantumlThemes], 'plantuml' as const, currentPlantumlTheme),
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
    } else if (selected.category === 'plantuml') {
        if (selected.themeKey === currentPlantumlTheme) return;
        localPlantumlTheme = selected.themeKey;
        scheduleRender();
    }
}


/** Generate a panel title from the file path. */
function makePanelTitle(filePath: string): string {
    const name = filePath.split(/[/\\]/).pop() ?? 'PlantUML';
    return `${name} ${vscode.l10n.t('(Preview)')}`;
}
