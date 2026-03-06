/**
 * @module preview
 * @description WebviewPanel-based Markdown preview manager.
 *
 * Responsibilities:
 * - Create / reuse a WebviewPanel and render Markdown with PlantUML inline SVG
 * - Two-stage debounce: no-diagram-change -> debounceNoDiagramChangeMs,
 *   diagram-change -> debounceDiagramChangeMs
 * - Immediate refresh on file save (cancels pending debounce)
 * - Bidirectional scroll sync between editor and preview (syncMaster state machine)
 * - Re-render on settings change via updateConfig()
 */
import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs';
import { renderHtmlAsync, renderBodyAsync, getThemeCss, LIGHT_THEME_KEYS, DARK_THEME_KEYS } from './exporter.js';
import { listThemesAsync, prefetchThemes } from './plantuml.js';
import { getScrollSyncScriptTag } from './scroll-sync.js';
import { getNonce, resolveLocalImagePaths, extractPlantUmlBlocks, PLANTUML_FENCE_TEST_RE, extractMermaidBlocks, MERMAID_FENCE_TEST_RE, escapeHtml } from './utils.js';
import { CONFIG_SECTION, MERMAID_THEME_KEYS, type Config } from './config.js';
import { openDiagramViewer, updateDiagramViewer, closeStaleViewers, disposeAllViewers } from './diagram-viewer.js';

/** Config keys that affect &lt;head&gt; content and require a full HTML reload. */
const HEAD_KEYS = new Set(['allowLocalImages', 'allowHttpImages', 'mermaidScale', 'enableMath']);

/** Output channel for extension diagnostic messages. Injected by setOutputChannel(). */
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Set the shared output channel for this module.
 *
 * Called from activate() in extension.ts so the channel's lifecycle
 * is managed by context.subscriptions regardless of preview state.
 *
 * @param channel - Output channel for diagnostic messages.
 */
export function setOutputChannel(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

/**
 * Get the shared output channel.
 *
 * Creates a defensive fallback if not yet injected via setOutputChannel().
 * Normally setOutputChannel() is called from activate() before any event
 * listeners are registered, so this fallback should never be reached.
 *
 * @returns The shared output channel instance.
 */
function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        // setOutputChannel() is called from activate() before any event listeners
        // are registered. If this point is reached, it indicates a programming error.
        throw new Error('[PlantUML Markdown Preview] Output channel not initialised — setOutputChannel() was not called');
    }
    return outputChannel;
}


/** Scroll sync state: which side currently owns the scroll. */
type SyncMaster = 'none' | 'editor' | 'preview';

/** The active WebviewPanel instance, or null when no preview is open. */
let panel: vscode.WebviewPanel | null = null;
/** Absolute path of the Markdown file currently displayed in the preview. */
let currentFilePath: string | null = null;
/** Most recently applied configuration snapshot (used for diff in updateConfig). */
let lastConfig: Config | null = null;

/** Disposable for the webview.onDidReceiveMessage listener. */
let messageDisposable: vscode.Disposable | null = null;
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
/** Resolve function for the Promise returned by openPreview (settles after first render). */
let firstRenderResolve: (() => void) | null = null;
/** AbortController for cancelling in-flight local rendering processes. */
let renderAbortController: AbortController | null = null;
/** When true, renderPanelWithLoading skips the "Rendering diagrams..." notification (one-shot). */
let suppressLoadingNotification = false;

/** Concatenated diagram block content from the last render (for change detection). */
let lastDiagramContent = '';
/** Last editor top line sent to Webview (-1 forces re-sync on next event). */
let lastScrollLine = -1;
/** Last editor maxTopLine sent to Webview (-1 forces re-sync on next event). */
let lastMaxTopLine = -1;
/** Normal visible line count (when not scrolled past the end). Used to detect bottom snap. */
let normalVisibleLineCount = 0;
/** Whether the editor is currently scrolled past the end (bottom snap active). */
let lastAtBottom = false;
/** Monotonically increasing render sequence number for stale message detection. */
let renderSeq = 0;
/** Whether the initial full HTML has been set on the webview (enables incremental updates). */
let initialHtmlSet = false;
/** Whether the initial full HTML included the Mermaid script (mermaid.min.js). */
let initialHtmlHadMermaid = false;
/** True while a file switch is pending — suppresses scroll sync and triggers scroll restore after body update. */
let pendingScrollRestore = false;
/** True when the most recent renderPanel call failed (allows re-render on same file re-focus). */
let lastRenderFailed = false;
/** True after the panel was hidden — VSCode destroys webview DOM on hide, so a re-render is needed on show. */
let panelWasHidden = false;
/** Whether clicking a diagram opens the diagram viewer (read once at panel creation). */
let enableDiagramViewer = true;

/** Current scroll sync owner: 'none' allows both directions, others block the opposite. */
let syncMaster: SyncMaster = 'none';
/** Timer handle for the 300ms syncMaster auto-reset to 'none'. */
let syncMasterTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Extract and concatenate all diagram block contents (PlantUML + Mermaid) from Markdown text.
 *
 * Used by the two-stage debounce to detect whether diagram content has changed
 * since the last render, so the appropriate delay can be selected.
 *
 * @param text - Full Markdown document text.
 * @returns Concatenated diagram block bodies separated by '---', or empty string.
 */
function extractDiagramContent(text: string): string {
    const parts: string[] = [];
    const plantumlBlocks = extractPlantUmlBlocks(text);
    if (plantumlBlocks.length) {
        parts.push(...plantumlBlocks.map(b => b.trim()));
    }
    const mermaidBlocks = extractMermaidBlocks(text);
    if (mermaidBlocks.length) {
        parts.push(...mermaidBlocks.map(b => b.trim()));
    }
    return parts.join('\n---\n');
}

/** Timeout (ms) for auto-resetting syncMaster to 'none'. Shared with scroll-sync.ts. */
const SYNC_MASTER_TIMEOUT_MS = 300;

/**
 * Set the syncMaster state and schedule auto-reset to 'none' after 300ms.
 *
 * Prevents feedback loops by marking which side initiated the scroll.
 *
 * @param who - Origin of the current scroll action.
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
 * @param lineCount - Total number of lines in the document.
 * @param visibleLineCount - Number of lines currently visible in the editor viewport.
 * @returns Maximum value for the editor's top visible line (>= 0).
 */
function calcMaxTopLine(lineCount: number, visibleLineCount: number): number {
    const BOTTOM_OVERLAP_RATIO = 3 / 4;
    return Math.max(0, lineCount - Math.ceil(visibleLineCount * BOTTOM_OVERLAP_RATIO));
}

/**
 * Generate a preview panel title from the current file path.
 *
 * @returns Title string in the format "filename (Preview)".
 */
function makeTitle(): string {
    const name = currentFilePath ? path.basename(currentFilePath, '.md') : 'Untitled';
    return name + ' ' + vscode.l10n.t('(Preview)');
}

/**
 * Build localResourceRoots for the webview based on the current file path.
 *
 * Always includes the extension's dist/ directory (for mermaid.min.js),
 * the Markdown file's parent directory, and, when available, the
 * workspace folder that contains the file.
 *
 * @param filePath - Absolute path of the current Markdown file.
 * @returns URIs to allow as local resource roots.
 */
function buildLocalResourceRoots(filePath: string): vscode.Uri[] {
    const roots: vscode.Uri[] = [
        vscode.Uri.file(__dirname),  // dist/ — mermaid.min.js
        vscode.Uri.file(path.dirname(filePath)),
    ];
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
 * restricts localResourceRoots to the extension's dist/ directory only
 * (mermaid.min.js still needs to load).
 *
 * No-op when panel, lastConfig, or currentFilePath is null.
 */
function applyWebviewOptions(): boolean {
    if (!panel || !lastConfig || !currentFilePath) return false;
    const newRoots = lastConfig.allowLocalImages
        ? buildLocalResourceRoots(currentFilePath)
        : [vscode.Uri.file(__dirname)];
    // Skip if roots match to avoid triggering a webview reload
    const old = panel.webview.options.localResourceRoots;
    if (old && old.length === newRoots.length
        && old.every((u, i) => u.toString() === newRoots[i].toString())) {
        return false;
    }
    panel.webview.options = { enableScripts: true, localResourceRoots: newRoots };
    return true;
}

/**
 * Dispose all VS Code event listeners and cancel pending timers.
 *
 * Handles save/change/scroll disposables, debounce timer, loading timer,
 * loading resolve callback, and syncMaster timer. Each resource is null-checked
 * and set to null after disposal to allow safe re-entry.
 */
function disposeEventHandlers(): void {
    if (messageDisposable) { messageDisposable.dispose(); messageDisposable = null; }
    if (saveDisposable) { saveDisposable.dispose(); saveDisposable = null; }
    if (changeDisposable) { changeDisposable.dispose(); changeDisposable = null; }
    if (scrollDisposable) { scrollDisposable.dispose(); scrollDisposable = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (loadingRenderTimer) { clearTimeout(loadingRenderTimer); loadingRenderTimer = null; }
    if (loadingResolve) { loadingResolve(); loadingResolve = null; }
    if (syncMasterTimer) { clearTimeout(syncMasterTimer); syncMasterTimer = null; }
    if (renderAbortController) { renderAbortController.abort(); renderAbortController = null; }
}

/**
 * Register all VS Code event listeners for the preview panel.
 *
 * Sets up message handler (revealLine), save/change/scroll listeners.
 * Must be called after panel is created or when switching files on
 * an existing panel (after disposeEventHandlers()).
 */
function registerEventHandlers(): void {
    if (!panel) return;

    messageDisposable = panel.webview.onDidReceiveMessage((message) => {
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
        } else if (enableDiagramViewer && message.type === 'openDiagramViewer') {
            openDiagramViewer(message.svg, message.diagramIndex, message.bgColor);
        } else if (enableDiagramViewer && message.type === 'updateDiagramViewer') {
            updateDiagramViewer(message.diagramIndex, message.svg, message.bgColor);
        } else if (enableDiagramViewer && message.type === 'diagramCount') {
            closeStaleViewers(message.count);
        }
    });

    saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!panel || !currentFilePath || doc.uri.fsPath !== currentFilePath) return;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        const text = doc.getText();
        lastDiagramContent = extractDiagramContent(text);
        void renderPanel(text).catch(err => getOutputChannel().appendLine(`[render error] ${err}`));
    });

    changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        if (!panel || !currentFilePath || !lastConfig || event.document.uri.fsPath !== currentFilePath) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        const text = event.document.getText();
        const currentDiagramContent = extractDiagramContent(text);
        const { debounceNoDiagramChangeMs, debounceDiagramChangeMs } = lastConfig;
        const delay = currentDiagramContent !== lastDiagramContent ? debounceDiagramChangeMs : debounceNoDiagramChangeMs;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            lastDiagramContent = currentDiagramContent;
            void renderPanel(text).catch(err => getOutputChannel().appendLine(`[render error] ${err}`));
        }, delay);
    });

    scrollDisposable = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (!panel) return;
        if (event.textEditor.document.uri.fsPath !== currentFilePath) return;
        if (event.visibleRanges.length === 0) return;
        if (syncMaster === 'preview') return;
        // Skip scroll sync while a file switch is pending — the webview
        // still shows the previous file's content, so scrolling it would cause
        // a visible jump to the wrong position before the new content loads.
        // Note: for long renders this briefly disables editor→preview sync,
        // but the position self-corrects once rendering completes.
        if (pendingScrollRestore) return;

        const topLine = event.visibleRanges[0].start.line;
        const bottomLine = event.visibleRanges[0].end.line;
        const lineCount = event.textEditor.document.lineCount;
        const visibleLineCount = bottomLine - topLine + 1;
        const maxTopLine = calcMaxTopLine(lineCount, visibleLineCount);

        if (topLine === lastScrollLine && maxTopLine === lastMaxTopLine) return;
        setSyncMaster('editor');
        lastScrollLine = topLine;
        lastMaxTopLine = maxTopLine;
        if (bottomLine < lineCount - 1) {
            normalVisibleLineCount = visibleLineCount;
        }
        const atBottom = bottomLine >= lineCount - 1
            && topLine > 0
            && (normalVisibleLineCount > 0
                ? normalVisibleLineCount - visibleLineCount >= 10
                : visibleLineCount < lineCount);
        lastAtBottom = atBottom;
        void panel.webview.postMessage({ type: 'scrollToLine', line: topLine, maxTopLine, atBottom });
    });
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
    // outputChannel lifecycle is managed by context.subscriptions in extension.ts
}

/**
 * Reset all module-level state to initial values.
 *
 * Called by panel.onDidDispose. Clears panel reference, file path, config,
 * scroll state, sync state, and disposes all event handlers.
 */
function resetState(): void {
    panel = null;
    currentFilePath = null;
    lastConfig = null;
    lastDiagramContent = '';
    lastScrollLine = -1;
    lastMaxTopLine = -1;
    initialHtmlSet = false;
    initialHtmlHadMermaid = false;
    pendingScrollRestore = false;
    lastRenderFailed = false;
    panelWasHidden = false;
    syncMaster = 'none';
    if (firstRenderResolve) { firstRenderResolve(); firstRenderResolve = null; }
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
 * @param filePath - Absolute path to the .md file.
 * @returns File content, or null if the file was switched or an error occurred.
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
 * Returns a Promise that resolves after the first render completes.
 *
 * @param filePath - Absolute path to the .md file to preview.
 * @param config - Current extension settings.
 * @param [preserveFocus=false] - When true, keep focus on the editor (auto-follow mode).
 * @param [suppressNotification=false] - When true, skip the "Rendering diagrams..." notification
 *   (caller already shows its own progress notification).
 */
export function openPreview(filePath: string, config: Config, preserveFocus = false, suppressNotification = false): Promise<void> {
    lastConfig = config;
    suppressLoadingNotification = suppressNotification;

    // Cancel any pending debounce since we are about to do a fresh render.
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

    // Reset scroll state on file switch; keep initialHtmlSet so the
    // incremental path is used (much faster than a full webview reload).
    if (currentFilePath !== filePath) {
        lastScrollLine = -1;
        lastMaxTopLine = -1;
        normalVisibleLineCount = 0;
        lastAtBottom = false;
        pendingScrollRestore = true;
        lastDiagramContent = '';
        disposeAllViewers();
    }
    currentFilePath = filePath;

    if (panel) {
        panel.title = makeTitle();
        const optionsChanged = applyWebviewOptions();
        disposeEventHandlers();
        registerEventHandlers();
        // applyWebviewOptions() may trigger a webview reload from stale
        // panel.webview.html; force full HTML render so the backing
        // HTML has the current theme and content.
        if (optionsChanged) {
            initialHtmlSet = false;
        }
        // When auto-following editor changes (preserveFocus=true), skip
        // reveal() — it would bring the preview to the front and cover
        // a file the user just opened in the same column.
        if (!preserveFocus) {
            panel.reveal(vscode.ViewColumn.Two, false);
        }
    } else {
        const pmCfg = vscode.workspace.getConfiguration('plantumlMarkdownPreview');
        const retainCtx = pmCfg.get<boolean>('retainPreviewContext', true);
        enableDiagramViewer = pmCfg.get<boolean>('enableDiagramViewer', true);
        panel = vscode.window.createWebviewPanel(
            'plantumlMarkdownPreview',
            makeTitle(),
            { viewColumn: vscode.ViewColumn.Two, preserveFocus },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: retainCtx,
                localResourceRoots: config.allowLocalImages ? buildLocalResourceRoots(filePath) : [vscode.Uri.file(__dirname)],
            }
        );

        // Show loading placeholder until the first full render completes
        panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<div id="loading-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:var(--vscode-editor-background,#fff);display:flex;align-items:center;justify-content:center;z-index:9999;">
<div style="color:var(--vscode-editor-foreground,#333);font-size:14px;">${escapeHtml(vscode.l10n.t('Rendering...'))}</div>
</div></body></html>`;

        panel.onDidDispose(resetState);
        panel.onDidChangeViewState(() => {
            if (!panel) return;
            if (!panel.visible) {
                if (!retainCtx) panelWasHidden = true;
                return;
            }
            if (panelWasHidden && currentFilePath && lastConfig) {
                panelWasHidden = false;
                void readFileContent(currentFilePath).then((text) => {
                    if (text === null || !panel || !lastConfig) return;
                    void renderPanel(text).catch(err =>
                        getOutputChannel().appendLine(`[re-render on show] ${err}`)
                    );
                });
            } else if (retainCtx && lastScrollLine >= 0) {
                void panel.webview.postMessage({ type: 'scrollToLine', line: lastScrollLine, maxTopLine: lastMaxTopLine, atBottom: lastAtBottom });
            }
        });
        registerEventHandlers();
    }

    // Initial display: capture the editor's current top line and maxTopLine
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.fsPath === filePath && activeEditor.visibleRanges.length > 0) {
        lastScrollLine = activeEditor.visibleRanges[0].start.line;
        const visibleLineCount = activeEditor.visibleRanges[0].end.line - activeEditor.visibleRanges[0].start.line + 1;
        lastMaxTopLine = calcMaxTopLine(activeEditor.document.lineCount, visibleLineCount);
    }
    return new Promise<void>((resolve) => {
        // Settle any previous openPreview Promise (e.g. rapid file switches)
        // so the old "Opening preview..." notification is dismissed.
        if (firstRenderResolve) {
            firstRenderResolve();
        }
        firstRenderResolve = resolve;

        void readFileContent(filePath).then((text) => {
            if (text === null) {
                suppressLoadingNotification = false;
                fireDeferredWork();
                return;
            }
            // Guard: skip if another file switch happened while reading
            if (currentFilePath !== filePath) {
                return;
            }
            lastDiagramContent = extractDiagramContent(text);
            renderPanelWithLoading(text);
        }).catch(() => {
            // Defensive: readFileContent should never reject, but guarantee
            // fireDeferredWork runs so the withProgress notification is dismissed.
            suppressLoadingNotification = false;
            fireDeferredWork();
        });
    });
}

/**
 * Render Markdown text and replace the panel's HTML content.
 *
 * Always uses renderHtmlAsync() so PlantUML blocks are pre-rendered
 * asynchronously (local: sequential spawn, server: parallel HTTP).
 * This prevents spawnSync from blocking the extension host event loop.
 *
 * Increments renderSeq, generates a fresh CSP nonce, and embeds the scroll
 * sync script. Resets lastScrollLine to -1 to force scroll sync on the next event.
 *
 * @param text - Full Markdown document text to render.
 */
async function renderPanel(text: string): Promise<void> {
    if (!panel || !lastConfig) return;
    // Cancel any in-flight rendering processes from a previous renderPanel call.
    // Abort is best-effort: the renderSeq guard below is the definitive stale check.
    if (renderAbortController) renderAbortController.abort();
    const myController = new AbortController();
    renderAbortController = myController;
    const signal = myController.signal;

    const mySeq = ++renderSeq;
    let htmlReplaced = false;

    // Re-capture editor scroll position just before rendering.
    // openPreview() captures it early (before readFileContent + 50ms delay),
    // but VS Code may not have restored the editor's scroll state yet at that point.
    // By the time renderPanel runs (~50ms later), the position is reliable.
    if (!initialHtmlSet || pendingScrollRestore) {
        const editor = vscode.window.activeTextEditor;
        if (editor && currentFilePath && editor.document.uri.fsPath === currentFilePath && editor.visibleRanges.length > 0) {
            lastScrollLine = editor.visibleRanges[0].start.line;
            const bottomLine = editor.visibleRanges[0].end.line;
            const lineCount = editor.document.lineCount;
            const visibleLineCount = bottomLine - lastScrollLine + 1;
            lastMaxTopLine = calcMaxTopLine(lineCount, visibleLineCount);
            lastAtBottom = false;
            if (bottomLine >= lineCount - 1 && lastScrollLine > 0) {
                if (normalVisibleLineCount > 0) {
                    // Have baseline: same check as scroll handler
                    if (normalVisibleLineCount - visibleLineCount >= 10) {
                        lastAtBottom = true;
                    }
                } else if (visibleLineCount < lineCount) {
                    // No baseline yet but top is not visible — scrolled past end.
                    lastAtBottom = true;
                }
            }
            if (!lastAtBottom && bottomLine < lineCount - 1) {
                normalVisibleLineCount = visibleLineCount;
            }
        }
    }

    try {
        if (!initialHtmlSet) {
            // --- First render: full HTML with scripts, CSP, etc. ---
            const nonce = getNonce();
            const mermaidPath = path.join(__dirname, 'mermaid.min.js');
            const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.file(mermaidPath)).toString();
            const scrollSyncPath = path.join(__dirname, 'scroll-sync-webview.js');
            const scrollSyncUri = panel.webview.asWebviewUri(vscode.Uri.file(scrollSyncPath)).toString();

            // Build KaTeX CSS with font URIs resolved for Webview
            let katexCssHtml = '';
            if (lastConfig.enableMath) {
                const katexCssPath = path.join(__dirname, 'katex.min.css');
                try {
                    let katexCss = await fs.promises.readFile(katexCssPath, 'utf-8');
                    const fontsBaseUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'fonts'))).toString();
                    katexCss = katexCss.replace(/url\(fonts\//g, `url(${fontsBaseUri}/`);
                    katexCssHtml = `\n  <style id="katex-css">${katexCss}</style>`;
                } catch { /* KaTeX CSS not found — skip */ }
            }

            const renderOptions = {
                sourceMap: true,
                scriptHtml: getScrollSyncScriptTag(lastScrollLine, lastMaxTopLine, nonce, mySeq, vscode.l10n.t('Rendering...'), SYNC_MASTER_TIMEOUT_MS, scrollSyncUri, lastAtBottom, enableDiagramViewer),
                cspNonce: nonce,
                cspSource: panel.webview.cspSource,
                lang: vscode.env.language,
                allowHttpImages: lastConfig.allowHttpImages,
                mermaidScriptUri: mermaidUri,
                mermaidTheme: lastConfig.mermaidTheme,
                mermaidScale: lastConfig.mermaidScale,
                navTopTitle: vscode.l10n.t('Go to top'),
                navBottomTitle: vscode.l10n.t('Go to bottom'),
                navTocTitle: vscode.l10n.t('Table of Contents'),
                katexCssHtml,
                enableMath: lastConfig.enableMath,
            };

            const html = await renderHtmlAsync(text, makeTitle(), lastConfig, renderOptions, signal);
            if (!panel || !lastConfig || renderSeq !== mySeq || signal.aborted) return;

            let finalHtml = html;
            if (lastConfig.allowLocalImages && currentFilePath) {
                const webview = panel.webview;
                finalHtml = resolveLocalImagePaths(
                    html,
                    path.dirname(currentFilePath),
                    (absPath) => webview.asWebviewUri(vscode.Uri.file(absPath)).toString()
                );
            }
            panel.webview.html = finalHtml;
            initialHtmlSet = true;
            initialHtmlHadMermaid = finalHtml.includes('__renderMermaid');
            pendingScrollRestore = false;
            htmlReplaced = true;
            lastRenderFailed = false;
            lastScrollLine = -1;
            lastMaxTopLine = -1;
        } else {
            // --- Incremental update: body content only via postMessage ---
            const renderOptions = { sourceMap: true };
            const { bodyHtml, hasMermaid } = await renderBodyAsync(text, lastConfig, renderOptions, signal);
            if (!panel || !lastConfig || renderSeq !== mySeq || signal.aborted) return;

            // Mermaid appeared for the first time but mermaid.min.js was never loaded.
            // Fall back to a full HTML render so the script is included.
            if (hasMermaid && !initialHtmlHadMermaid) {
                initialHtmlSet = false;
                return renderPanel(text);
            }

            let finalBody = bodyHtml;
            if (lastConfig.allowLocalImages && currentFilePath) {
                const webview = panel.webview;
                finalBody = resolveLocalImagePaths(
                    bodyHtml,
                    path.dirname(currentFilePath),
                    (absPath) => webview.asWebviewUri(vscode.Uri.file(absPath)).toString()
                );
            }
            const msg: Record<string, unknown> = { type: 'updateBody', html: finalBody, hasMermaid };
            if (pendingScrollRestore && lastScrollLine >= 0) {
                msg.scrollTo = { line: lastScrollLine, maxTopLine: lastMaxTopLine, atBottom: lastAtBottom };
            }
            // Sync theme CSS on file switch: applyWebviewOptions() may reload
            // the webview from panel.webview.html which has the initial theme,
            // discarding any updateTheme changes applied via postMessage.
            if (pendingScrollRestore) {
                msg.themeCss = getThemeCss(lastConfig.previewTheme || 'github-light');
            }
            pendingScrollRestore = false;
            void panel.webview.postMessage(msg);
            htmlReplaced = true;
            lastRenderFailed = false;
        }
    } catch (err) {
        getOutputChannel().appendLine(`[renderPanel error] ${err}`);
        lastRenderFailed = true;
        // Show error in the preview so the user sees something went wrong
        // instead of stale content from the previous file.
        if (panel && initialHtmlSet) {
            void panel.webview.postMessage({
                type: 'updateBody',
                html: `<div style="padding:2em;color:var(--vscode-errorForeground,red);">${escapeHtml(String(err))}</div>`,
                hasMermaid: false,
            });
            htmlReplaced = true;
        }
    } finally {
        // Only clear the controller if it is still ours — a recursive call
        // (e.g. Mermaid fallback at L577) replaces renderAbortController with
        // a new instance, and we must not overwrite it.
        if (renderAbortController === myController) {
            renderAbortController = null;
        }
        // If HTML was not replaced (stale render or error), dismiss the loading
        // overlay on the current webview to prevent it from staying permanently.
        if (!htmlReplaced && panel) {
            void panel.webview.postMessage({ type: 'hideLoading' });
        }
    }
}

/**
 * Run deferred work after the first render completes.
 *
 * Pre-fetches the PlantUML theme list (so the QuickPick menu is instant)
 * and invokes the one-shot firstRenderResolve (e.g. checkJavaAvailability).
 * This avoids competing with the initial async render for CPU/IO.
 */
function fireDeferredWork(): void {
    if (lastConfig && lastConfig.renderMode !== 'server') {
        prefetchThemes(lastConfig);
    }
    if (firstRenderResolve) {
        firstRenderResolve();
        firstRenderResolve = null;
    }
}

/**
 * Render with loading feedback when diagram blocks are present.
 *
 * If the text contains diagram blocks (PlantUML or Mermaid), shows a Webview
 * overlay and a notification bar progress before delegating to renderPanel().
 * Uses a 50ms setTimeout to yield the event loop so the overlay can render first.
 * For documents without diagrams, delegates directly to renderPanel().
 *
 * @param text - Full Markdown document text to render.
 */
function renderPanelWithLoading(text: string): void {
    if (!panel || !lastConfig) return;

    // Cancel any pending render from a previous invocation and dismiss its notification
    if (loadingRenderTimer) { clearTimeout(loadingRenderTimer); loadingRenderTimer = null; }
    if (loadingResolve) { loadingResolve(); loadingResolve = null; }

    const hasDiagram = PLANTUML_FENCE_TEST_RE.test(text) || MERMAID_FENCE_TEST_RE.test(text);
    if (!hasDiagram) {
        suppressLoadingNotification = false;
        void renderPanel(text).catch(err => {
            getOutputChannel().appendLine(`[render error] ${err}`);
        }).finally(() => {
            fireDeferredWork();
        });
        return;
    }

    // Send showLoading with the *current* (pre-increment) renderSeq.
    // renderPanel() will ++renderSeq and embed the new value as RENDER_SEQ in
    // the replacement HTML. Because the seq values differ, the new HTML's
    // message handler ignores this stale showLoading — which is intentional:
    // the overlay should only appear on the *old* HTML that is about to be replaced.
    void panel.webview.postMessage({ type: 'showLoading', seq: renderSeq });

    // When the caller already shows a notification (e.g. "Opening preview..."),
    // skip the separate "Rendering diagrams..." notification to avoid duplicates.
    const skipNotification = suppressLoadingNotification;
    suppressLoadingNotification = false;

    const doRender = () => {
        loadingRenderTimer = null;
        void renderPanel(text).catch(err => {
            getOutputChannel().appendLine(`[render error] ${err}`);
        }).finally(() => {
            if (loadingResolve) { loadingResolve(); loadingResolve = null; }
            fireDeferredWork();
        });
    };

    if (skipNotification) {
        // Yield to event loop so the webview overlay renders first
        loadingRenderTimer = setTimeout(doRender, 50);
    } else {
        void vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rendering diagrams...') },
            () => new Promise<void>((resolve) => {
                loadingResolve = resolve;
                loadingRenderTimer = setTimeout(doRender, 50);
            })
        );
    }
}

/** Property keys that affect rendering output (PlantUML paths and themes). */
const RENDER_KEYS = ['plantumlJarPath', 'javaPath', 'dotPath', 'plantumlTheme', 'plantumlScale', 'previewTheme', 'allowLocalImages', 'allowHttpImages', 'mode', 'plantumlServerUrl', 'plantumlLocalServerPort', 'mermaidTheme', 'mermaidScale', 'enableMath'] as const;

/**
 * Check which rendering-related properties changed between two configs.
 *
 * @param a - New configuration.
 * @param b - Old configuration.
 * @returns Set of property names that differ.
 */
function changedRenderKeys(a: Config, b: Config): Set<string> {
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
 * @param config - New configuration from onDidChangeConfiguration.
 */
export function updateConfig(config: Config): void {
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
            void panel.webview.postMessage({ type: 'updateTheme', css });
            return;
        }

        // No rendering properties changed (only debounce values)
        if (changed.size === 0) return;

        // Reinit Mermaid theme before the incremental body update arrives
        if (changed.has('mermaidTheme')) {
            void panel.webview.postMessage({
                type: 'reinitMermaid',
                theme: config.mermaidTheme || 'default'
            });
        }

        // Update webview options when allowLocalImages toggled
        if (changed.has('allowLocalImages')) {
            applyWebviewOptions();
        }

        // Settings that affect <head> content require a full HTML reload
        if ([...changed].some(k => HEAD_KEYS.has(k))) {
            initialHtmlSet = false;
        }
    }

    void readFileContent(currentFilePath).then((text) => {
        if (text === null) return;
        renderPanelWithLoading(text);
    }).catch(err => getOutputChannel().appendLine(`[config update error] ${err}`));
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
 * @returns Resolves when the theme selection is complete or cancelled.
 */
export async function changeTheme(): Promise<void> {
    if (!panel) return;

    const currentPreviewTheme = lastConfig ? lastConfig.previewTheme : 'github-light';
    const currentPlantumlTheme = lastConfig ? lastConfig.plantumlTheme : 'default';
    const currentMermaidTheme = lastConfig ? lastConfig.mermaidTheme : 'default';

    // Helper to build QuickPick items for a set of theme keys
    const buildThemeItems = <C extends string>(keys: readonly string[], category: C, currentKey: string) =>
        keys.map(key => ({
            label: key === currentKey ? `$(check) ${key}` : `      ${key}`,
            description: key === currentKey ? vscode.l10n.t('(current)') : '',
            category,
            themeKey: key
        }));

    // PlantUML Theme section (async fetch; resolves instantly if cache is warm)
    const plantumlThemes = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Fetching PlantUML theme list...') },
        () => listThemesAsync(lastConfig || { plantumlJarPath: '', javaPath: 'java' })
    );
    if (!panel) return;

    const items = [
        { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(LIGHT_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(DARK_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        { label: vscode.l10n.t('PlantUML Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(['default', ...plantumlThemes], 'plantuml' as const, currentPlantumlTheme),
        { label: vscode.l10n.t('Mermaid Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems([...MERMAID_THEME_KEYS], 'mermaid' as const, currentMermaidTheme)
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select theme')
    });
    if (!panel) return;

    if (!selected || !('category' in selected)) return;

    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);

    try {
        if (selected.category === 'preview') {
            if (selected.themeKey === currentPreviewTheme) return;
            await cfg.update('previewTheme', selected.themeKey, vscode.ConfigurationTarget.Global);
        } else if (selected.category === 'plantuml') {
            if (selected.themeKey === currentPlantumlTheme) return;
            await cfg.update('plantumlTheme', selected.themeKey, vscode.ConfigurationTarget.Global);
        } else if (selected.category === 'mermaid') {
            if (selected.themeKey === currentMermaidTheme) return;
            await cfg.update('mermaidTheme', selected.themeKey, vscode.ConfigurationTarget.Global);
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
 * @returns Absolute file path of the previewed .md file, or null if no preview is open.
 */
export function getCurrentFilePath(): string | null {
    return currentFilePath;
}

/**
 * Return whether the most recent render failed.
 *
 * Used by extension.ts to allow re-rendering the same file when the user
 * re-focuses the editor after a render failure.
 */
export function getLastRenderFailed(): boolean {
    return lastRenderFailed;
}
