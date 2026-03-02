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
import { renderHtmlAsync, getThemeCss, LIGHT_THEME_KEYS, DARK_THEME_KEYS } from './exporter.js';
import { listThemesAsync, prefetchThemes } from './plantuml.js';
import { buildScrollSyncScript } from './scroll-sync.js';
import { getNonce, resolveLocalImagePaths, extractPlantUmlBlocks, PLANTUML_FENCE_TEST_RE, extractMermaidBlocks, MERMAID_FENCE_TEST_RE, escapeHtml } from './utils.js';
import { CONFIG_SECTION, type Config } from './config.js';

/** Mermaid built-in theme keys, ordered for display. */
const MERMAID_THEME_KEYS = ['default', 'dark', 'forest', 'neutral', 'base'] as const;

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
/** Monotonically increasing render sequence number for stale message detection. */
let renderSeq = 0;

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
    if (PLANTUML_FENCE_TEST_RE.test(text)) {
        parts.push(...extractPlantUmlBlocks(text).map(b => b.trim()));
    }
    if (MERMAID_FENCE_TEST_RE.test(text)) {
        parts.push(...extractMermaidBlocks(text).map(b => b.trim()));
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
function applyWebviewOptions(): void {
    if (!panel || !lastConfig || !currentFilePath) return;
    if (lastConfig.allowLocalImages) {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: buildLocalResourceRoots(currentFilePath),
        };
    } else {
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(__dirname)] };
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
    if (renderAbortController) { renderAbortController.abort(); renderAbortController = null; }
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

    // Reset scroll state on file switch
    if (currentFilePath !== filePath) {
        lastScrollLine = -1;
        lastMaxTopLine = -1;
    }
    currentFilePath = filePath;

    if (panel) {
        panel.title = makeTitle();
        applyWebviewOptions();
        // When auto-following editor changes (preserveFocus=true), skip
        // reveal() — it would bring the preview to the front and cover
        // a file the user just opened in the same column.
        if (!preserveFocus) {
            panel.reveal(vscode.ViewColumn.Two, false);
        }
    } else {
        panel = vscode.window.createWebviewPanel(
            'plantumlMarkdownPreview',
            makeTitle(),
            { viewColumn: vscode.ViewColumn.Two, preserveFocus },
            {
                enableFindWidget: true,
                enableScripts: true,
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
        });

        // Event listeners are managed by disposeEventHandlers() (called from
        // resetState() via panel.onDidDispose) to avoid stale disposable
        // accumulation on panel re-creation.
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
            const { debounceNoPlantUmlMs, debouncePlantUmlMs } = lastConfig;
            const delay = currentDiagramContent !== lastDiagramContent ? debouncePlantUmlMs : debounceNoPlantUmlMs;
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

            const topLine = event.visibleRanges[0].start.line;
            const bottomLine = event.visibleRanges[0].end.line;
            const lineCount = event.textEditor.document.lineCount;
            const visibleLineCount = bottomLine - topLine + 1;
            const maxTopLine = calcMaxTopLine(lineCount, visibleLineCount);

            if (topLine === lastScrollLine && maxTopLine === lastMaxTopLine) return;
            setSyncMaster('editor');
            lastScrollLine = topLine;
            lastMaxTopLine = maxTopLine;
            void panel.webview.postMessage({ type: 'scrollToLine', line: topLine, maxTopLine });
        });

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

    try {
        const nonce = getNonce();
        const mermaidPath = path.join(__dirname, 'mermaid.min.js');
        const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.file(mermaidPath)).toString();
        const renderOptions = {
            sourceMap: true,
            scriptHtml: buildScrollSyncScript(lastScrollLine, lastMaxTopLine, nonce, mySeq, vscode.l10n.t('Rendering...'), SYNC_MASTER_TIMEOUT_MS),
            cspNonce: nonce,
            cspSource: panel.webview.cspSource,
            lang: vscode.env.language,
            allowHttpImages: lastConfig.allowHttpImages,
            mermaidScriptUri: mermaidUri,
            mermaidTheme: lastConfig.mermaidTheme,
            mermaidScale: lastConfig.mermaidScale,
        };

        const html = await renderHtmlAsync(text, makeTitle(), lastConfig, renderOptions, signal);
        // Guard against stale render: renderSeq mismatch means a newer renderPanel
        // call has started; signal.aborted means disposeEventHandlers() ran mid-flight.
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
        htmlReplaced = true;
        // After re-render the scrollMap changes, so force sync on next scroll event
        lastScrollLine = -1;
        lastMaxTopLine = -1;
    } catch (err) {
        getOutputChannel().appendLine(`[renderPanel error] ${err}`);
    } finally {
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
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rendering diagrams...') },
            () => new Promise<void>((resolve) => {
                loadingResolve = resolve;
                loadingRenderTimer = setTimeout(doRender, 50);
            })
        );
    }
}

/** Property keys that affect rendering output (PlantUML paths and themes). */
const RENDER_KEYS = ['jarPath', 'javaPath', 'dotPath', 'plantumlTheme', 'plantumlScale', 'previewTheme', 'allowLocalImages', 'allowHttpImages', 'renderMode', 'serverUrl', 'mermaidTheme', 'mermaidScale'] as const;

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

        // Update webview options when allowLocalImages toggled
        if (changed.has('allowLocalImages')) {
            applyWebviewOptions();
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
        ...plantumlItems,
        { label: vscode.l10n.t('Mermaid Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...MERMAID_THEME_KEYS.map(key => ({
            label: key === currentMermaidTheme ? `$(check) ${key}` : `      ${key}`,
            description: key === currentMermaidTheme ? vscode.l10n.t('(current)') : '',
            category: 'mermaid' as const,
            themeKey: key
        }))
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
