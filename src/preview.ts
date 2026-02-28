/**
 * @module preview
 * @description WebviewPanel-based Markdown preview manager.
 *
 * Responsibilities:
 * - Create / reuse a WebviewPanel and render Markdown with PlantUML inline SVG
 * - Two-stage debounce: no-PlantUML-change -> debounceNoPlantUmlMs,
 *   PlantUML-change -> debouncePlantUmlMs
 * - Immediate refresh on file save (cancels pending debounce)
 * - Bidirectional scroll sync between editor and preview (syncMaster state machine)
 * - Re-render on settings change via updateConfig()
 */
import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs';
import { renderHtml, renderHtmlAsync, getThemeCss, LIGHT_THEME_KEYS, DARK_THEME_KEYS } from './exporter.js';
import type { ExporterConfig } from './exporter.js';
import { listThemesAsync, prefetchThemes } from './plantuml.js';
import { buildScrollSyncScript } from './scroll-sync.js';
import { getNonce, resolveLocalImagePaths } from './utils.js';

/** Output channel for extension diagnostic messages. Created lazily on first use. */
let outputChannel: vscode.OutputChannel | null = null;

/** Get or create the shared output channel for this extension. */
function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('PlantUML Markdown Preview');
    }
    return outputChannel;
}

/** Full preview configuration extending ExporterConfig with debounce settings. */
export interface PreviewConfig extends ExporterConfig {
    /** Debounce delay (ms) when only non-PlantUML content changed. */
    debounceNoPlantUmlMs: number;
    /** Debounce delay (ms) when PlantUML content changed. */
    debouncePlantUmlMs: number;
    /** When true, resolve relative image paths in the preview via webview URIs. */
    allowLocalImages: boolean;
    /** When true, allow loading images over HTTP (unencrypted) in the preview CSP. */
    allowHttpImages: boolean;
    /** Hidden debug flag: simulate Java not found, even when installed. */
    debugSimulateNoJava?: boolean;
}

/** Scroll sync state: which side currently owns the scroll. */
type SyncMaster = 'none' | 'editor' | 'preview';

/** Extension context reference for registering disposables. */
let extensionContext: vscode.ExtensionContext | null = null;
/** The active WebviewPanel instance, or null when no preview is open. */
let panel: vscode.WebviewPanel | null = null;
/** Absolute path of the Markdown file currently displayed in the preview. */
let currentFilePath: string | null = null;
/** Most recently applied configuration snapshot (used for diff in updateConfig). */
let lastConfig: PreviewConfig | null = null;

/** Disposable for the onDidSaveTextDocument listener. */
let saveDisposable: vscode.Disposable | null = null;
/** Disposable for the onDidChangeTextDocument listener. */
let changeDisposable: vscode.Disposable | null = null;
/** Disposable for the onDidChangeTextEditorVisibleRanges listener. */
let scrollDisposable: vscode.Disposable | null = null;

/** Timer handle for the two-stage debounce on text changes. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Timer handle for the 50ms delay before synchronous render in renderPanelWithLoading. */
let loadingRenderTimer: ReturnType<typeof setTimeout> | null = null;
/** Resolve callback for the current withProgress Promise (dismisses the notification). */
let loadingResolve: (() => void) | null = null;

/** Regex to detect ```plantuml fenced code blocks (used for loading feedback decision). */
const PLANTUML_FENCE_RE = /^```plantuml/im;

/** Concatenated PlantUML block content from the last render (for change detection). */
let lastPlantUmlContent = '';
/** Last editor top line sent to Webview (-1 forces re-sync on next event). */
let lastScrollLine = -1;
/** Last editor maxTopLine sent to Webview (-1 forces re-sync on next event). */
let lastMaxTopLine = -1;
/** Monotonically increasing render sequence number for stale message detection. */
let renderSeq = 0;

/** Current scroll sync owner: 'none' allows both directions, others block the opposite. */
let syncMaster: SyncMaster = 'none';
/** Timer handle for the 300ms syncMaster auto-reset to 'none'. */
let syncMasterTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Extract and concatenate all ```plantuml block contents from Markdown text.
 *
 * Used by the two-stage debounce to detect whether PlantUML content has changed
 * since the last render, so the appropriate delay can be selected.
 *
 * @param {string} text - Full Markdown document text.
 * @returns {string} Concatenated PlantUML block bodies separated by '---', or empty string.
 */
function extractPlantUmlContent(text: string): string {
    const blocks: string[] = [];
    const regex = /^```plantuml[ \t]*\n([\s\S]*?)\n[ \t]*```/gim;
    let match;
    while ((match = regex.exec(text)) !== null) {
        blocks.push(match[1].trim());
    }
    return blocks.join('\n---\n');
}

/** Timeout (ms) for auto-resetting syncMaster to 'none'. Shared with scroll-sync.ts. */
const SYNC_MASTER_TIMEOUT_MS = 300;

/**
 * Set the syncMaster state and schedule auto-reset to 'none' after 300ms.
 *
 * Prevents feedback loops by marking which side initiated the scroll.
 *
 * @param {'editor' | 'preview'} who - Origin of the current scroll action.
 */
function setSyncMaster(who: 'editor' | 'preview'): void {
    syncMaster = who;
    if (syncMasterTimer) clearTimeout(syncMasterTimer);
    syncMasterTimer = setTimeout(() => { syncMaster = 'none'; syncMasterTimer = null; }, SYNC_MASTER_TIMEOUT_MS);
}

/**
 * Calculate the maximum top scroll line of the editor.
 *
 * This ensures the tail anchor maps editor-bottom to preview-bottom.
 *
 * @param {number} lineCount - Total number of lines in the document.
 * @param {number} visibleLineCount - Number of lines currently visible in the editor viewport.
 * @returns {number} Maximum value for the editor's top visible line (>= 0).
 */
function calcMaxTopLine(lineCount: number, visibleLineCount: number): number {
    const BOTTOM_OVERLAP_RATIO = 3 / 4;
    return Math.max(0, lineCount - Math.ceil(visibleLineCount * BOTTOM_OVERLAP_RATIO));
}

/**
 * Generate a preview panel title from the current file path.
 *
 * @returns {string} Title string in the format "filename (Preview)".
 */
function makeTitle(): string {
    const name = currentFilePath ? path.basename(currentFilePath, '.md') : 'Untitled';
    return name + ' ' + vscode.l10n.t('(Preview)');
}

/**
 * Build localResourceRoots for the webview based on the current file path.
 *
 * Includes the Markdown file's parent directory and, when available, the
 * workspace folder that contains the file.
 *
 * @param {string} filePath - Absolute path of the current Markdown file.
 * @returns {vscode.Uri[]} URIs to allow as local resource roots.
 */
function buildLocalResourceRoots(filePath: string): vscode.Uri[] {
    const roots: vscode.Uri[] = [vscode.Uri.file(path.dirname(filePath))];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (workspaceFolder) {
        roots.push(workspaceFolder.uri);
    }
    return roots;
}

/**
 * Update the webview's options (enableScripts, localResourceRoots).
 *
 * When allowLocalImages is true, sets localResourceRoots so the webview
 * can load images from the file's directory and workspace. When false,
 * sets localResourceRoots to an empty array to block all local file access.
 */
function applyWebviewOptions(): void {
    if (!panel || !lastConfig || !currentFilePath) return;
    if (lastConfig.allowLocalImages) {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: buildLocalResourceRoots(currentFilePath),
        };
    } else {
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    }
}

/**
 * Dispose all VS Code event listeners and cancel pending timers.
 *
 * Handles save/change/scroll disposables, debounce timer, loading timer,
 * loading resolve callback, and syncMaster timer. Each resource is null-checked
 * and set to null after disposal to allow safe re-entry.
 */
function disposeEventHandlers(): void {
    if (saveDisposable) { saveDisposable.dispose(); saveDisposable = null; }
    if (changeDisposable) { changeDisposable.dispose(); changeDisposable = null; }
    if (scrollDisposable) { scrollDisposable.dispose(); scrollDisposable = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (loadingRenderTimer) { clearTimeout(loadingRenderTimer); loadingRenderTimer = null; }
    if (loadingResolve) { loadingResolve(); loadingResolve = null; }
    if (syncMasterTimer) { clearTimeout(syncMasterTimer); syncMasterTimer = null; }
}

/**
 * Dispose the preview panel and all associated resources.
 *
 * Called from deactivate(). Triggers onDidDispose which calls resetState().
 * Safe to call when panel is already null (no-op).
 */
export function disposePreview(): void {
    if (panel) {
        panel.dispose(); // triggers onDidDispose -> resetState()
    }
    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = null;
    }
}

/**
 * Reset all module-level state to initial values.
 *
 * Called by panel.onDidDispose. Clears panel reference, file path, config,
 * scroll state, sync state, and disposes all event handlers.
 */
function resetState(): void {
    panel = null;
    extensionContext = null;
    currentFilePath = null;
    lastConfig = null;
    lastPlantUmlContent = '';
    lastScrollLine = -1;
    lastMaxTopLine = -1;
    syncMaster = 'none';
    disposeEventHandlers();
}

/**
 * Read the document text from an open editor or the filesystem.
 *
 * Tries open VS Code text documents first (synchronous). Falls back to
 * fs.promises.readFile (asynchronous) when the file is not currently open.
 * Guards against stale reads by checking currentFilePath after the async read.
 * Returns null when the file was switched while reading (stale read).
 *
 * @param {string} filePath - Absolute path to the .md file.
 * @returns {Promise<string | null>} File content, or null if the file was switched or an error occurred.
 */
async function readFileContent(filePath: string): Promise<string | null> {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (doc) {
        return doc.getText();
    }
    try {
        const text = await fs.promises.readFile(filePath, 'utf8');
        if (currentFilePath !== filePath) return null; // file switched while reading
        return text;
    } catch (err) {
        vscode.window.showErrorMessage(`[PlantUML Markdown Preview] ${(err as Error).message}`);
        return null;
    }
}

/**
 * Open or update the custom WebviewPanel preview.
 *
 * Reuses an existing panel if already open, otherwise creates a new one
 * with save/change/scroll event listeners. Registers onDidDispose for cleanup.
 * On file switch, resets scroll state and renders the new file.
 *
 * @param {vscode.ExtensionContext} context - Extension context for managing subscriptions.
 * @param {string} filePath - Absolute path to the .md file to preview.
 * @param {PreviewConfig} config - Current extension settings.
 * @param {boolean} [preserveFocus=false] - When true, keep focus on the editor (auto-follow mode).
 */
export function openPreview(context: vscode.ExtensionContext, filePath: string, config: PreviewConfig, preserveFocus = false): void {
    extensionContext = context;
    lastConfig = config;

    // Cancel any pending debounce since we are about to do a fresh render.
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

    // Reset scroll state on file switch
    if (currentFilePath !== filePath) {
        lastScrollLine = -1;
        lastMaxTopLine = -1;
    }
    currentFilePath = filePath;

    if (panel) {
        panel.title = makeTitle();
        applyWebviewOptions();
        panel.reveal(vscode.ViewColumn.Two, preserveFocus);
    } else {
        panel = vscode.window.createWebviewPanel(
            'plantumlMarkdownPreview',
            makeTitle(),
            vscode.ViewColumn.Two,
            {
                enableFindWidget: true,
                enableScripts: true,
                localResourceRoots: config.allowLocalImages ? buildLocalResourceRoots(filePath) : [],
            }
        );

        // Show loading placeholder until the first full render completes
        panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<div id="loading-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:var(--vscode-editor-background,#fff);display:flex;align-items:center;justify-content:center;z-index:9999;">
<div style="color:var(--vscode-editor-foreground,#333);font-size:14px;">${vscode.l10n.t('Rendering...')}</div>
</div></body></html>`;

        panel.onDidDispose(resetState, null, context.subscriptions);

        panel.webview.onDidReceiveMessage((message) => {
            if (message.type === 'revealLine' && typeof message.line === 'number') {
                if (syncMaster === 'editor') return;
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.fsPath === currentFilePath
                );
                if (!editor) return;

                setSyncMaster('preview');
                const line = Math.max(0, Math.round(message.line));
                const range = new vscode.Range(line, 0, line, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
                lastScrollLine = line;
            }
        }, null, context.subscriptions);

        saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!panel || !currentFilePath || doc.uri.fsPath !== currentFilePath) return;
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
            const text = doc.getText();
            lastPlantUmlContent = extractPlantUmlContent(text);
            void renderPanel(text).catch(err => getOutputChannel().appendLine(`[render error] ${err}`));
        });
        context.subscriptions.push(saveDisposable);

        changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
            if (!panel || !currentFilePath || !lastConfig || event.document.uri.fsPath !== currentFilePath) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            const text = event.document.getText();
            const currentPlantUml = extractPlantUmlContent(text);
            const { debounceNoPlantUmlMs, debouncePlantUmlMs } = lastConfig;
            const delay = currentPlantUml !== lastPlantUmlContent ? debouncePlantUmlMs : debounceNoPlantUmlMs;
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                lastPlantUmlContent = currentPlantUml;
                void renderPanel(text).catch(err => getOutputChannel().appendLine(`[render error] ${err}`));
            }, delay);
        });
        context.subscriptions.push(changeDisposable);

        scrollDisposable = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (!panel) return;
            if (event.textEditor.document.uri.fsPath !== currentFilePath) return;
            if (event.visibleRanges.length === 0) return;
            if (syncMaster === 'preview') return;

            const topLine = event.visibleRanges[0].start.line;
            const bottomLine = event.visibleRanges[0].end.line;
            const lineCount = event.textEditor.document.lineCount;
            const visibleLineCount = bottomLine - topLine + 1;
            const maxTopLine = calcMaxTopLine(lineCount, visibleLineCount);

            if (topLine === lastScrollLine && maxTopLine === lastMaxTopLine) return;
            setSyncMaster('editor');
            lastScrollLine = topLine;
            lastMaxTopLine = maxTopLine;
            panel.webview.postMessage({ type: 'scrollToLine', line: topLine, maxTopLine });
        });
        context.subscriptions.push(scrollDisposable);

    }

    // Initial display: capture the editor's current top line and maxTopLine
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.fsPath === filePath && activeEditor.visibleRanges.length > 0) {
        lastScrollLine = activeEditor.visibleRanges[0].start.line;
        const visibleLineCount = activeEditor.visibleRanges[0].end.line - activeEditor.visibleRanges[0].start.line + 1;
        lastMaxTopLine = calcMaxTopLine(activeEditor.document.lineCount, visibleLineCount);
    }

    // Pre-fetch PlantUML theme list in background so it's cached when menu opens
    prefetchThemes(config);

    void readFileContent(filePath).then((text) => {
        if (text === null) return;
        lastPlantUmlContent = extractPlantUmlContent(text);
        renderPanelWithLoading(text);
    });
}

/**
 * Render Markdown text and replace the panel's HTML content.
 *
 * In local mode: synchronous rendering via renderHtml().
 * In server mode: async rendering via renderHtmlAsync() with stale-render guard.
 *
 * Increments renderSeq, generates a fresh CSP nonce, and embeds the scroll
 * sync script. Resets lastScrollLine to -1 to force scroll sync on the next event.
 *
 * @param {string} text - Full Markdown document text to render.
 */
async function renderPanel(text: string): Promise<void> {
    if (!panel || !lastConfig) return;
    const mySeq = ++renderSeq;
    const nonce = getNonce();
    const renderOptions = {
        sourceMap: true,
        scriptHtml: buildScrollSyncScript(lastScrollLine, lastMaxTopLine, nonce, renderSeq, vscode.l10n.t('Rendering...'), SYNC_MASTER_TIMEOUT_MS),
        cspNonce: nonce,
        cspSource: panel.webview.cspSource,
        lang: vscode.env.language,
        allowHttpImages: lastConfig.allowHttpImages
    };

    let html: string;
    if (lastConfig.renderMode === 'server' && lastConfig.serverUrl) {
        html = await renderHtmlAsync(text, makeTitle(), lastConfig, renderOptions);
        // Guard against stale render (user may have typed while we awaited)
        if (!panel || !lastConfig || renderSeq !== mySeq) return;
    } else {
        html = renderHtml(text, makeTitle(), lastConfig, renderOptions);
    }

    if (lastConfig.allowLocalImages && currentFilePath) {
        const webview = panel.webview;
        html = resolveLocalImagePaths(
            html,
            path.dirname(currentFilePath),
            (absPath) => webview.asWebviewUri(vscode.Uri.file(absPath)).toString()
        );
    }
    panel.webview.html = html;
    // After re-render the scrollMap changes, so force sync on next scroll event
    lastScrollLine = -1;
    lastMaxTopLine = -1;
}

/**
 * Render with loading feedback when PlantUML blocks are present.
 *
 * If the text contains ```plantuml blocks, shows a Webview overlay and a
 * notification bar progress before delegating to renderPanel(). Uses a 50ms
 * setTimeout to yield the event loop so the overlay can render first.
 * For documents without PlantUML, delegates directly to renderPanel().
 *
 * @param {string} text - Full Markdown document text to render.
 */
function renderPanelWithLoading(text: string): void {
    if (!panel || !lastConfig) return;

    // Cancel any pending render from a previous invocation and dismiss its notification
    if (loadingRenderTimer) { clearTimeout(loadingRenderTimer); loadingRenderTimer = null; }
    if (loadingResolve) { loadingResolve(); loadingResolve = null; }

    const hasPlantUml = PLANTUML_FENCE_RE.test(text);
    if (!hasPlantUml) {
        try {
            renderPanel(text);
        } catch (err) {
            getOutputChannel().appendLine(`[render error] ${err}`);
        }
        return;
    }

    panel.webview.postMessage({ type: 'showLoading', seq: renderSeq });
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rendering PlantUML...') },
        () => new Promise<void>((resolve) => {
            loadingResolve = resolve;
            // Yield to event loop so overlay renders before blocking re-render
            loadingRenderTimer = setTimeout(() => {
                loadingRenderTimer = null;
                void renderPanel(text).catch(err => {
                    getOutputChannel().appendLine(`[render error] ${err}`);
                }).finally(() => {
                    resolve();
                    loadingResolve = null;
                });
            }, 50);
        })
    );
}

/** Property keys that affect rendering output (PlantUML paths and themes). */
const RENDER_KEYS = ['jarPath', 'javaPath', 'dotPath', 'plantumlTheme', 'previewTheme', 'allowLocalImages', 'allowHttpImages', 'renderMode', 'serverUrl'] as const;

/**
 * Check which rendering-related properties changed between two configs.
 *
 * @param {PreviewConfig} a - New configuration.
 * @param {PreviewConfig} b - Old configuration.
 * @returns {Set<string>} Set of property names that differ.
 */
function changedRenderKeys(a: PreviewConfig, b: PreviewConfig): Set<string> {
    const changed = new Set<string>();
    for (const key of RENDER_KEYS) {
        if (a[key] !== b[key]) changed.add(key);
    }
    return changed;
}

/**
 * Update the preview with new extension settings.
 *
 * Handles three cases in order:
 * 1. Preview theme only changed -> CSS-only swap (no re-render)
 * 2. Only debounce values changed -> update lastConfig, no re-render
 * 3. Other settings changed -> full re-render with loading feedback
 *
 * @param {PreviewConfig} config - New configuration from onDidChangeConfiguration.
 */
export function updateConfig(config: PreviewConfig): void {
    if (!panel || !currentFilePath) return;

    const oldConfig = lastConfig;
    lastConfig = config;

    if (!oldConfig) {
        // First config — full render
    } else {
        const changed = changedRenderKeys(config, oldConfig);

        // CSS-only swap when only previewTheme changed
        if (changed.size === 1 && changed.has('previewTheme')) {
            const css = getThemeCss(config.previewTheme || 'github-light');
            panel.webview.postMessage({ type: 'updateTheme', css });
            return;
        }

        // No rendering properties changed (only debounce values)
        if (changed.size === 0) return;

        // Update webview options when allowLocalImages toggled
        if (changed.has('allowLocalImages')) {
            applyWebviewOptions();
        }
    }

    void readFileContent(currentFilePath).then((text) => {
        if (text === null) return;
        renderPanelWithLoading(text);
    });
}

/**
 * Show a QuickPick with two sections (Preview Theme / PlantUML Theme).
 *
 * Fetches the PlantUML theme list asynchronously (with progress notification),
 * then presents both preview and PlantUML themes in a single QuickPick with
 * separator headers. Writes the selected theme to VS Code global settings,
 * which triggers onDidChangeConfiguration -> updateConfig().
 *
 * No-op when the panel is not open, user presses Escape, or selects the
 * already-active theme.
 *
 * @returns {Promise<void>} Resolves when the theme selection is complete or cancelled.
 */
export async function changeTheme(): Promise<void> {
    if (!panel) return;

    const currentPreviewTheme = lastConfig ? lastConfig.previewTheme : 'github-light';
    const currentPlantumlTheme = lastConfig ? lastConfig.plantumlTheme : 'default';

    // Helper to build QuickPick items for a set of theme keys
    const buildPreviewItems = (keys: readonly string[]) => keys.map(key => ({
        label: key === currentPreviewTheme ? `$(check) ${key}` : `      ${key}`,
        description: key === currentPreviewTheme ? vscode.l10n.t('(current)') : '',
        category: 'preview' as const,
        themeKey: key
    }));

    // PlantUML Theme section (async fetch; resolves instantly if cache is warm)
    const plantumlThemes = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Fetching PlantUML theme list...') },
        () => listThemesAsync(lastConfig || { jarPath: '', javaPath: 'java' })
    );
    if (!panel) return;
    const plantumlItems = [
        {
            label: currentPlantumlTheme === 'default' ? '$(check) default' : '      default',
            description: currentPlantumlTheme === 'default' ? vscode.l10n.t('(current)') : '',
            category: 'plantuml' as const,
            themeKey: 'default'
        },
        ...plantumlThemes.map(key => ({
            label: key === currentPlantumlTheme ? `$(check) ${key}` : `      ${key}`,
            description: key === currentPlantumlTheme ? vscode.l10n.t('(current)') : '',
            category: 'plantuml' as const,
            themeKey: key
        }))
    ];

    const items = [
        { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildPreviewItems(LIGHT_THEME_KEYS),
        { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildPreviewItems(DARK_THEME_KEYS),
        { label: vscode.l10n.t('PlantUML Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...plantumlItems
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select theme')
    });
    if (!panel) return;

    if (!selected || !('category' in selected)) return;

    const cfg = vscode.workspace.getConfiguration('plantumlMarkdownPreview');

    try {
        if (selected.category === 'preview') {
            if (selected.themeKey === currentPreviewTheme) return;
            await cfg.update('previewTheme', selected.themeKey, vscode.ConfigurationTarget.Global);
        } else if (selected.category === 'plantuml') {
            if (selected.themeKey === currentPlantumlTheme) return;
            await cfg.update('plantumlTheme', selected.themeKey, vscode.ConfigurationTarget.Global);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`[PlantUML Markdown Preview] ${(err as Error).message}`);
    }
}

/**
 * Return the file path currently being previewed.
 *
 * Used by extension.ts to check if the preview panel is active and to
 * determine the current file for editor auto-follow guard conditions.
 *
 * @returns {string | null} Absolute file path of the previewed .md file, or null if no preview is open.
 */
export function getCurrentFilePath(): string | null {
    return currentFilePath;
}
