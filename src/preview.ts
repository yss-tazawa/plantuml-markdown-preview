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
import { listThemesAsync, prefetchThemes, clearCache, resolveIncludePath, collectIncludePaths, renderToSvgAsync, renderAllLocal } from './plantuml.js';
import { clearServerCache, renderToSvgServer } from './plantuml-server.js';
import { getLocalServerUrl, waitForLocalServer } from './local-server.js';
import { scalePlantUmlSvg, scaleD2Svg } from './renderer.js';
import { renderD2ToSvg } from './d2-renderer.js';
import { getScrollSyncScriptTag } from './scroll-sync.js';
import { getNonce, resolveLocalImagePaths, extractPlantUmlBlocks, PLANTUML_FENCE_TEST_RE, extractMermaidBlocks, MERMAID_FENCE_TEST_RE, extractD2Blocks, D2_FENCE_TEST_RE, escapeHtml, errorHtml, buildThemeItems } from './utils.js';
import { CONFIG_SECTION, MERMAID_THEME_KEYS, D2_THEME_KEYS, D2_THEME_MAP, type Config } from './config.js';
import { updateDiagramViewer, closeStaleViewers, disposeAllViewers, setPendingSaveDiagram, handlePngFromPreview, handleCopyResult } from './diagram-viewer.js';

/** Config keys that affect &lt;head&gt; content and require a full HTML reload. */
const HEAD_KEYS = new Set(['allowLocalImages', 'allowHttpImages', 'mermaidScale', 'enableMath']);

/** Scroll sync state: which side currently owns the scroll. */
type SyncMaster = 'none' | 'editor' | 'preview';

/** Timeout (ms) for auto-resetting syncMaster to 'none'. Shared with scroll-sync.ts. */
const SYNC_MASTER_TIMEOUT_MS = 300;


/** Property keys that affect rendering output. */
const RENDER_KEYS = ['plantumlJarPath', 'javaPath', 'dotPath', 'plantumlTheme', 'plantumlScale', 'previewTheme', 'allowLocalImages', 'allowHttpImages', 'mode', 'plantumlServerUrl', 'plantumlLocalServerPort', 'mermaidTheme', 'mermaidScale', 'enableMath', 'plantumlIncludePath', 'd2Theme', 'd2Layout', 'd2Scale'] as const;

// =====================================================================
// PreviewManager class
// =====================================================================

/**
 * Encapsulates all preview state and behaviour in a single Disposable class.
 *
 * Instantiated once in extension.ts activate() and pushed to
 * context.subscriptions so dispose() is called automatically on deactivation.
 */
export class PreviewManager implements vscode.Disposable {
    // -- injected dependencies ----------------------------------------
    private readonly outputChannel: vscode.OutputChannel;

    // -- panel / file -------------------------------------------------
    private panel: vscode.WebviewPanel | null = null;
    private currentFilePath: string | null = null;
    private lastConfig: Config | null = null;

    // -- event disposables --------------------------------------------
    private messageDisposable: vscode.Disposable | null = null;
    private saveDisposable: vscode.Disposable | null = null;
    private changeDisposable: vscode.Disposable | null = null;
    private scrollDisposable: vscode.Disposable | null = null;
    private disposeDisposable: vscode.Disposable | null = null;
    private viewStateDisposable: vscode.Disposable | null = null;

    // -- timers / async -----------------------------------------------
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private loadingRenderTimer: ReturnType<typeof setTimeout> | null = null;
    private loadingResolve: (() => void) | null = null;
    private firstRenderResolve: (() => void) | null = null;
    private renderAbortController: AbortController | null = null;
    private suppressLoadingNotification = false;
    private syncMasterTimer: ReturnType<typeof setTimeout> | null = null;

    // -- render state -------------------------------------------------
    private lastDiagramContent = '';
    private lastScrollLine = -1;
    private lastMaxTopLine = -1;
    private lastAtBottom = false;
    private renderSeq = 0;
    private initialHtmlSet = false;
    private initialHtmlHadMermaid = false;
    private pendingScrollRestore = false;
    private lastRenderFailed = false;
    private panelWasHidden = false;
    private enableDiagramViewer = true;
    /** Cached retainContextWhenHidden value, set at panel creation time. */
    private retainCtx = true;

    // -- include tracking ---------------------------------------------
    private includePaths = new Set<string>();

    // -- diagram patch mode ---------------------------------------------
    /** Previous block lists for patch-mode diffing, keyed by diagram type. */
    private lastPlantUmlBlocks: string[] = [];
    private lastMermaidBlocks: string[] = [];
    private lastD2Blocks: string[] = [];
    /** Previous full text for patch-mode non-diagram text comparison. */
    private lastRenderedText: string | null = null;

    // -- scroll sync --------------------------------------------------
    private syncMaster: SyncMaster = 'none';
    /** Tracks whether the source editor was visible at the last check. Used to
     *  swallow the first visibleRanges event VS Code fires when a source tab is
     *  re-displayed (a position-restore "noise" event), so it isn't mistaken for a
     *  real user scroll. The editor is NOT moved on this transition — the editor is
     *  the master while the user works in it. */
    private sourceWasVisible = false;
    private visibleEditorsDisposable: vscode.Disposable | null = null;
    /** Snapshot of lastScrollLine taken when the preview becomes hidden.
     *  On visible+active restore, comparing against the current lastScrollLine
     *  tells us whether the source scrolled while the preview was hidden — if so
     *  the preview must re-sync to the source's current position. -1 = no snapshot. */
    private scrollLineWhenHidden = -1;
    /** Set when a render is requested while the preview is hidden. Rendering while
     *  hidden (especially a full reload from a document switch) would bake a stale
     *  scroll position into the HTML; instead we defer and re-render when shown. */
    private pendingShowRender = false;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    // -- pure / stateless helpers --------------------------------------

    /** Extract all diagram fence blocks (PlantUML, Mermaid, D2) for change detection. */
    private extractDiagramContent(text: string): string {
        const parts: string[] = [];
        const plantumlBlocks = extractPlantUmlBlocks(text);
        if (plantumlBlocks.length) {
            parts.push(...plantumlBlocks.map(b => b.trim()));
        }
        const mermaidBlocks = extractMermaidBlocks(text);
        if (mermaidBlocks.length) {
            parts.push(...mermaidBlocks.map(b => b.trim()));
        }
        const d2Blocks = extractD2Blocks(text);
        if (d2Blocks.length) {
            parts.push(...d2Blocks.map(b => b.trim()));
        }
        return parts.join('\n---\n');
    }

    /** Collect all `!include` paths from PlantUML blocks and update the tracking set. */
    private updateIncludePaths(text: string): void {
        if (!this.lastConfig) { this.includePaths = new Set<string>(); return; }
        this.includePaths = collectIncludePaths(text, this.lastConfig);
    }

    /** Calculate the maximum scroll top-line for proportional mapping. */
    private calcMaxTopLine(lineCount: number, visibleLineCount: number): number {
        const BOTTOM_OVERLAP_RATIO = 3 / 4;
        return Math.max(0, lineCount - Math.ceil(visibleLineCount * BOTTOM_OVERLAP_RATIO));
    }

    /** Derive the editor->preview sync values (mid line, max top line, bottom snap)
     *  from an editor's visible range. Shared by the scroll handler and the
     *  preview-restore path so both compute the position identically. */
    private calcScrollSync(topLine: number, bottomLine: number, lineCount: number):
            { midLine: number; maxTopLine: number; atBottom: boolean } {
        const visibleLineCount = bottomLine - topLine + 1;
        const maxTopLine = this.calcMaxTopLine(lineCount, visibleLineCount);
        let midLine: number;
        if (topLine === 0) midLine = 0;
        else if (bottomLine >= lineCount - 1) midLine = bottomLine;
        else midLine = Math.floor((topLine + bottomLine) / 2);
        const atBottom = topLine >= maxTopLine && topLine > 0;
        return { midLine, maxTopLine, atBottom };
    }

    /** Build the panel title from the current file name. */
    private makeTitle(): string {
        const name = this.currentFilePath ? path.basename(this.currentFilePath, '.md') : 'Untitled';
        return name + ' ' + vscode.l10n.t('(Preview)');
    }

    /** Build the localResourceRoots array based on the file location.
     *  For files inside a workspace folder, use the workspace root (which already
     *  covers every subfolder) instead of the file's own dir. This keeps the roots
     *  identical across document switches within the same workspace, so switching
     *  between same-named files in different subfolders does NOT change the webview
     *  options and therefore does NOT force a full reload — it stays a body-only
     *  update. (A full reload mid-switch caused stale anchors / wrong scroll pos.) */
    private buildLocalResourceRoots(filePath: string): vscode.Uri[] {
        const roots: vscode.Uri[] = [vscode.Uri.file(__dirname)];
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (workspaceFolder) {
            roots.push(workspaceFolder.uri);
        } else {
            // Outside any workspace: fall back to the file's own directory.
            roots.push(vscode.Uri.file(path.dirname(filePath)));
        }
        return roots;
    }

    /** Return the set of rendering-related config keys that differ between two configs. */
    private changedRenderKeys(a: Config, b: Config): Set<string> {
        const changed = new Set<string>();
        for (const key of RENDER_KEYS) {
            if (a[key] !== b[key]) changed.add(key);
        }
        return changed;
    }

    // -- state management helpers ------------------------------------

    /** Set the scroll-sync owner and start the auto-reset timer. */
    private setSyncMaster(who: 'editor' | 'preview'): void {
        this.syncMaster = who;
        if (this.syncMasterTimer) clearTimeout(this.syncMasterTimer);
        this.syncMasterTimer = setTimeout(() => { this.syncMaster = 'none'; this.syncMasterTimer = null; }, SYNC_MASTER_TIMEOUT_MS);
    }

    /** Force the preview to sync to the paired source editor's current position.
     *  Used when the preview regains focus after the source scrolled while it was
     *  hidden. Returns false if the source editor isn't visible (nothing to sync). */
    private syncPreviewToSourceNow(): boolean {
        if (!this.panel) return false;
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === this.currentFilePath
        );
        if (!editor || editor.visibleRanges.length === 0) return false;

        const topLine = editor.visibleRanges[0].start.line;
        const bottomLine = editor.visibleRanges[0].end.line;
        const { midLine, maxTopLine, atBottom } = this.calcScrollSync(topLine, bottomLine, editor.document.lineCount);

        this.setSyncMaster('editor');
        this.lastScrollLine = midLine;
        this.lastMaxTopLine = maxTopLine;
        this.lastAtBottom = atBottom;
        // force: the webview just became visible and its layout-shift scroll event
        // may have set its syncMaster to 'preview', which would make it drop a
        // normal scrollToLine. This is an explicit restore, so bypass that guard.
        void this.panel.webview.postMessage({ type: 'scrollToLine', line: midLine, maxTopLine, atBottom, force: true });
        return true;
    }

    /** Update webview localResourceRoots if changed. Returns true if updated. */
    private applyWebviewOptions(): boolean {
        if (!this.panel || !this.lastConfig || !this.currentFilePath) return false;
        const newRoots = this.lastConfig.allowLocalImages
            ? this.buildLocalResourceRoots(this.currentFilePath)
            : [vscode.Uri.file(__dirname)];
        const old = this.panel.webview.options.localResourceRoots;
        if (old && old.length === newRoots.length
            && old.every((u, i) => u.toString() === newRoots[i].toString())) {
            return false;
        }
        this.panel.webview.options = { enableScripts: true, localResourceRoots: newRoots };
        return true;
    }

    /** Dispose event subscriptions and cancel pending timers/renders. */
    private disposeEventHandlers(includePanelHandlers = false): void {
        if (includePanelHandlers) {
            if (this.disposeDisposable) { this.disposeDisposable.dispose(); this.disposeDisposable = null; }
            if (this.viewStateDisposable) { this.viewStateDisposable.dispose(); this.viewStateDisposable = null; }
        }
        if (this.messageDisposable) { this.messageDisposable.dispose(); this.messageDisposable = null; }
        if (this.saveDisposable) { this.saveDisposable.dispose(); this.saveDisposable = null; }
        if (this.changeDisposable) { this.changeDisposable.dispose(); this.changeDisposable = null; }
        if (this.scrollDisposable) { this.scrollDisposable.dispose(); this.scrollDisposable = null; }
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
        if (this.loadingRenderTimer) { clearTimeout(this.loadingRenderTimer); this.loadingRenderTimer = null; }
        if (this.loadingResolve) { this.loadingResolve(); this.loadingResolve = null; }
        if (this.syncMasterTimer) { clearTimeout(this.syncMasterTimer); this.syncMasterTimer = null; }
        if (this.visibleEditorsDisposable) { this.visibleEditorsDisposable.dispose(); this.visibleEditorsDisposable = null; }
        if (this.renderAbortController) { this.renderAbortController.abort(); this.renderAbortController = null; }
        this.includePaths = new Set<string>();
    }

    /** Reset all instance state to initial values (called on panel dispose). */
    private resetState(): void {
        this.panel = null;
        this.currentFilePath = null;
        this.lastConfig = null;
        this.lastDiagramContent = '';
        this.lastScrollLine = -1;
        this.lastMaxTopLine = -1;
        this.lastAtBottom = false;
        this.initialHtmlSet = false;
        this.initialHtmlHadMermaid = false;
        this.pendingScrollRestore = false;
        this.lastRenderFailed = false;
        this.panelWasHidden = false;
        this.syncMaster = 'none';
        this.sourceWasVisible = false;
        this.scrollLineWhenHidden = -1;
        this.pendingShowRender = false;
        this.lastPlantUmlBlocks = [];
        this.lastMermaidBlocks = [];
        this.lastD2Blocks = [];
        this.lastRenderedText = null;

        if (this.firstRenderResolve) { this.firstRenderResolve(); this.firstRenderResolve = null; }
        this.disposeEventHandlers(true);
    }

    /** Read file content from an open editor or disk. Returns null on failure. */
    private async readFileContent(filePath: string): Promise<string | null> {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (doc) {
            return doc.getText();
        }
        try {
            const text = await fs.promises.readFile(filePath, 'utf8');
            if (this.currentFilePath !== filePath) return null;
            return text;
        } catch (err) {
            vscode.window.showErrorMessage(vscode.l10n.t('[PlantUML Markdown Preview] {0}', (err as Error).message));
            return null;
        }
    }

    /** Run deferred tasks after the first render (theme prefetch, resolve firstRenderPromise). */
    private fireDeferredWork(): void {
        if (this.lastConfig && this.lastConfig.renderMode !== 'server') {
            prefetchThemes(this.lastConfig);
        }
        if (this.firstRenderResolve) {
            this.firstRenderResolve();
            this.firstRenderResolve = null;
        }
    }

    // -- event registration ------------------------------------------

    /** Wire up webview message, save, change, and scroll event handlers. */
    private registerEventHandlers(): void {
        if (!this.panel) return;

        this.messageDisposable = this.panel.webview.onDidReceiveMessage((message) => {
            if (message.type === 'revealLine' && typeof message.line === 'number') {
                // Always track the preview's position regardless of editor visibility.
                // lastScrollLine is used by onDidChangeViewState to restore the preview's
                // position when it re-gains focus — if we don't update it here, a stale
                // editor-side value would cause the preview to jump back to that old
                // position when re-focused after scrolling while the source was hidden.
                const line = Math.max(0, Math.round(message.line));
                this.lastScrollLine = line;

                if (this.syncMaster === 'editor') return;
                // Only move the editor when the preview is the active pane — i.e. the
                // user is actively scrolling the preview. Otherwise (editor is the
                // active pane: tab switches, typing, scrolling the source) the editor
                // is the master and must not be yanked around by the preview.
                if (!this.panel?.active) return;
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.fsPath === this.currentFilePath
                );
                if (!editor) return;

                this.setSyncMaster('preview');
                const range = new vscode.Range(line, 0, line, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            } else if (this.enableDiagramViewer && message.type === 'updateDiagramViewer') {
                updateDiagramViewer(message.diagramIndex, message.svg, message.bgColor);
            } else if (this.enableDiagramViewer && message.type === 'diagramCount') {
                closeStaleViewers(message.count);
            } else if (this.enableDiagramViewer && message.type === 'saveDiagramContext') {
                setPendingSaveDiagram(message.svg, message.diagramIndex, message.bgColor, message.diagramType, message.plantumlIndex);
            } else if (this.enableDiagramViewer && message.type === 'exportDiagramFromPreview') {
                void handlePngFromPreview(message.data);
            } else if (this.enableDiagramViewer && message.type === 'copyDiagramFromPreview') {
                handleCopyResult(!!message.success);
            } else if (message.type === 'reload') {
                clearCache();
                clearServerCache();
                if (this.currentFilePath) {
                    void this.readFileContent(this.currentFilePath).then((text) => {
                        if (text === null) return;
                        this.renderPanelWithLoading(text);
                    });
                }
            }
        });

        this.saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!this.panel || !this.currentFilePath) return;

            if (doc.uri.fsPath === this.currentFilePath) {
                // Main file saved — existing behaviour
                if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
                const text = doc.getText();
                this.lastDiagramContent = this.extractDiagramContent(text);
                void this.renderPanel(text).catch(err => this.outputChannel.appendLine(`[render error] ${err}`));
                return;
            }

            if (this.includePaths.has(doc.uri.fsPath)) {
                // Include file saved — clear caches and re-render main file
                clearCache();
                clearServerCache();
                void this.readFileContent(this.currentFilePath).then((text) => {
                    if (text === null) return;
                    void this.renderPanel(text).catch(err => this.outputChannel.appendLine(`[render error] ${err}`));
                });
            }
        });

        this.changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
            if (!this.panel || !this.currentFilePath || !this.lastConfig || event.document.uri.fsPath !== this.currentFilePath) return;
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            const text = event.document.getText();
            const currentDiagramContent = this.extractDiagramContent(text);
            const { debounceNoDiagramChangeMs, debounceDiagramChangeMs } = this.lastConfig;
            const delay = currentDiagramContent !== this.lastDiagramContent ? debounceDiagramChangeMs : debounceNoDiagramChangeMs;
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = null;
                this.lastDiagramContent = currentDiagramContent;
                // Patch mode: if only diagram block contents changed (same counts, same surrounding text),
                // skip md.render() and innerHTML replacement — just update changed SVGs in the DOM.
                if (this.initialHtmlSet) {
                    void this.tryPatchDiagrams(text).then(patched => {
                        if (!patched) {
                            void this.renderPanel(text).catch(e => this.outputChannel.appendLine(`[render error] ${e}`));
                        }
                    }).catch(err => this.outputChannel.appendLine(`[patch error] ${err}`));
                    return;
                }
                void this.renderPanel(text).catch(err => this.outputChannel.appendLine(`[render error] ${err}`));
            }, delay);
        });

        this.scrollDisposable = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (!this.panel) return;
            if (event.textEditor.document.uri.fsPath !== this.currentFilePath) return;
            if (event.visibleRanges.length === 0) return;

            // Hidden -> visible transition: the source editor is being re-displayed.
            // Do NOT move it. The editor is the master while the user works in it
            // (tab switches, scrolling); moving it to the preview's position is the
            // "source scrolls on its own" bug. Just mark it visible again and let
            // the normal editor->preview sync below run from its real position.
            if (!this.sourceWasVisible) {
                this.sourceWasVisible = true;
                return;
            }

            if (this.syncMaster === 'preview') return;
            if (this.pendingScrollRestore) return;

            const topLine = event.visibleRanges[0].start.line;
            const bottomLine = event.visibleRanges[0].end.line;
            const lineCount = event.textEditor.document.lineCount;
            const { midLine, maxTopLine, atBottom } = this.calcScrollSync(topLine, bottomLine, lineCount);

            if (midLine === this.lastScrollLine && maxTopLine === this.lastMaxTopLine) return;
            this.setSyncMaster('editor');
            this.lastScrollLine = midLine;
            this.lastMaxTopLine = maxTopLine;
            this.lastAtBottom = atBottom;
            // Don't sync a hidden preview: its layout is collapsed (innerHeight is
            // tiny), so the line->pixel math produces a garbage scroll position.
            // lastScrollLine is still updated above; the preview re-syncs to it via
            // syncPreviewToSourceNow() when it becomes visible again.
            if (!this.panel.visible) return;
            void this.panel.webview.postMessage({ type: 'scrollToLine', line: midLine, maxTopLine, atBottom });
        });

        // Initial snapshot: is the source editor currently visible?
        this.sourceWasVisible = vscode.window.visibleTextEditors.some(
            e => e.document.uri.fsPath === this.currentFilePath
        );

        // We track source visibility so that the hidden->visible transition can
        // be detected inside onDidChangeTextEditorVisibleRanges. This subscription
        // exists mainly to reset sourceWasVisible to false when the source becomes
        // hidden (no visibleRanges event fires for a hidden editor, so we need
        // this separate signal).
        this.visibleEditorsDisposable = vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (!this.currentFilePath) return;
            const isVisible = editors.some(e => e.document.uri.fsPath === this.currentFilePath);
            if (!isVisible) this.sourceWasVisible = false;
        });
    }

    // -- rendering ----------------------------------------------------

    /**
     * Try patch mode: if only diagram block contents changed (same counts, same
     * surrounding text), render only changed blocks and patch the DOM directly.
     * Returns true if patch mode was used, false if full render is needed.
     */
    private async tryPatchDiagrams(text: string): Promise<boolean> {
        if (!this.panel || !this.lastConfig || !this.lastRenderedText) return false;

        const newPuml = extractPlantUmlBlocks(text);
        const newMmd = extractMermaidBlocks(text);
        const newD2 = extractD2Blocks(text);

        // Block counts must match
        if (newPuml.length !== this.lastPlantUmlBlocks.length) return false;
        if (newMmd.length !== this.lastMermaidBlocks.length) return false;
        if (newD2.length !== this.lastD2Blocks.length) return false;

        // At least one block must have actually changed
        let hasChange = false;
        for (let i = 0; i < newPuml.length && !hasChange; i++) {
            if (newPuml[i].trim() !== this.lastPlantUmlBlocks[i].trim()) hasChange = true;
        }
        for (let i = 0; i < newMmd.length && !hasChange; i++) {
            if (newMmd[i].trim() !== this.lastMermaidBlocks[i].trim()) hasChange = true;
        }
        for (let i = 0; i < newD2.length && !hasChange; i++) {
            if (newD2[i].trim() !== this.lastD2Blocks[i].trim()) hasChange = true;
        }
        if (!hasChange) return false;

        // Non-diagram text must be identical
        const strip = (s: string, ...blockLists: string[][]) => {
            let r = s;
            for (const blocks of blockLists) for (const b of blocks) r = r.split(b).join('');
            return r;
        };
        if (strip(text, newPuml, newMmd, newD2) !== strip(this.lastRenderedText, this.lastPlantUmlBlocks, this.lastMermaidBlocks, this.lastD2Blocks)) {
            return false;
        }

        // --- Patch mode confirmed: render changed blocks only ---
        if (this.renderAbortController) this.renderAbortController.abort();
        const myController = new AbortController();
        this.renderAbortController = myController;
        const signal = myController.signal;

        try {
            const pumlPatches: { index: number; svg: string }[] = [];
            const mermaidPatches: { index: number; source: string }[] = [];
            const d2Patches: { index: number; svg: string }[] = [];

            // --- PlantUML patches ---
            if (newPuml.some((b, i) => b.trim() !== this.lastPlantUmlBlocks[i]?.trim())) {
                let serverConfig: Config | undefined;
                if (this.lastConfig.renderMode === 'local-server') {
                    await waitForLocalServer();
                    const localUrl = getLocalServerUrl();
                    if (signal.aborted) return true;
                    if (!localUrl) return false; // fall back to full render (shows error)
                    serverConfig = { ...this.lastConfig, plantumlServerUrl: localUrl };
                } else if (this.lastConfig.renderMode === 'server') {
                    serverConfig = this.lastConfig;
                }
                // Collect changed block indices
                const changedIndices: number[] = [];
                for (let i = 0; i < newPuml.length; i++) {
                    if (newPuml[i].trim() !== this.lastPlantUmlBlocks[i].trim()) changedIndices.push(i);
                }
                if (changedIndices.length > 0 && !signal.aborted) {
                    if (serverConfig) {
                        // Fast / Easy: parallel HTTP requests
                        const results = await Promise.all(
                            changedIndices.map(async i => {
                                const rawSvg = await renderToSvgServer(newPuml[i], serverConfig!, signal);
                                return { index: i, svg: scalePlantUmlSvg(rawSvg, this.lastConfig!.plantumlScale) };
                            })
                        );
                        if (signal.aborted) return true;
                        pumlPatches.push(...results);
                    } else {
                        // Secure (local): batch all changed blocks in a single JVM
                        const changedBlocks = changedIndices.map(i => newPuml[i]);
                        const svgMap = await renderAllLocal(changedBlocks, this.lastConfig, signal);
                        if (signal.aborted) return true;
                        for (const i of changedIndices) {
                            const rawSvg = svgMap.get(newPuml[i].trim()) ?? '';
                            pumlPatches.push({ index: i, svg: scalePlantUmlSvg(rawSvg, this.lastConfig!.plantumlScale) });
                        }
                    }
                }
            }

            // --- Mermaid patches (send source to webview for client-side rendering) ---
            for (let i = 0; i < newMmd.length; i++) {
                if (newMmd[i].trim() !== this.lastMermaidBlocks[i].trim()) {
                    mermaidPatches.push({ index: i, source: newMmd[i].trim() });
                }
            }

            // --- D2 patches (Wasm rendering) ---
            for (let i = 0; i < newD2.length; i++) {
                if (signal.aborted) return true;
                if (newD2[i].trim() === this.lastD2Blocks[i].trim()) continue;
                try {
                    const themeID = D2_THEME_MAP.get(this.lastConfig!.d2Theme) ?? 0;
                    const rawSvg = await renderD2ToSvg(newD2[i].trim(), themeID, this.lastConfig!.d2Layout);
                    if (signal.aborted) return true;
                    d2Patches.push({ index: i, svg: scaleD2Svg(rawSvg, this.lastConfig!.d2Scale) });
                } catch (err) {
                    const msg = String(err);
                    if (msg.includes('returned no diagram')) {
                        // Incomplete input during editing — keep previous SVG
                    } else {
                        d2Patches.push({ index: i, svg: errorHtml(escapeHtml(msg)) });
                    }
                }
            }

            if (this.panel && !signal.aborted && (pumlPatches.length > 0 || mermaidPatches.length > 0 || d2Patches.length > 0)) {
                const mermaidScaleNum = this.lastConfig!.mermaidScale && this.lastConfig!.mermaidScale !== 'auto'
                    ? parseFloat(this.lastConfig!.mermaidScale) / 100 : 0;
                void this.panel.webview.postMessage({
                    type: 'patchDiagrams',
                    plantuml: pumlPatches,
                    mermaid: mermaidPatches,
                    mermaidScale: mermaidScaleNum,
                    d2: d2Patches,
                });
            }
            if (signal.aborted) return true;
            // No patches sent (e.g. all changes were incomplete input) — fall back to full render
            if (pumlPatches.length === 0 && mermaidPatches.length === 0 && d2Patches.length === 0) {
                return false;
            }
            this.lastPlantUmlBlocks = newPuml;
            this.lastMermaidBlocks = newMmd;
            this.lastD2Blocks = newD2;
            this.lastRenderedText = text;
            this.updateIncludePaths(text);
        } catch (err) {
            if (!myController.signal.aborted) {
                this.outputChannel.appendLine(`[patchDiagrams error] ${err}`);
                return false; // Fall back to full render
            }
        } finally {
            if (this.renderAbortController === myController) {
                this.renderAbortController = null;
            }
        }
        return true;
    }

    /** Render Markdown content into the webview (full HTML or body-only update). */
    private async renderPanel(text: string): Promise<void> {
        if (!this.panel || !this.lastConfig) return;
        // Defer rendering while the preview is hidden. A render here (especially a
        // full reload triggered by a document switch changing localResourceRoots)
        // would bake the current — possibly stale — scroll position into the HTML,
        // and a later visible-time sync loses the race against that restore. We
        // re-render with the correct position when the preview is shown again.
        if (!this.panel.visible) {
            this.pendingShowRender = true;
            return;
        }
        if (this.renderAbortController) this.renderAbortController.abort();
        const myController = new AbortController();
        this.renderAbortController = myController;
        const signal = myController.signal;

        const mySeq = ++this.renderSeq;
        let htmlReplaced = false;

        if (!this.initialHtmlSet || this.pendingScrollRestore) {
            const editor = vscode.window.activeTextEditor;
            if (editor && this.currentFilePath && editor.document.uri.fsPath === this.currentFilePath && editor.visibleRanges.length > 0) {
                // Use midLine (same as the editor->preview scroll handler), NOT the
                // top line. The webview centers the line it receives, so sending the
                // top line here would place it at the viewport center — a half-screen
                // offset versus normal sync. calcScrollSync keeps them consistent.
                const topLine = editor.visibleRanges[0].start.line;
                const bottomLine = editor.visibleRanges[0].end.line;
                const { midLine, maxTopLine, atBottom } = this.calcScrollSync(topLine, bottomLine, editor.document.lineCount);
                this.lastScrollLine = midLine;
                this.lastMaxTopLine = maxTopLine;
                this.lastAtBottom = atBottom;
            }
        }

        try {
            if (!this.initialHtmlSet) {
                const nonce = getNonce();
                const mermaidPath = path.join(__dirname, 'mermaid.min.js');
                const mermaidUri = this.panel.webview.asWebviewUri(vscode.Uri.file(mermaidPath)).toString();
                const scrollSyncPath = path.join(__dirname, 'scroll-sync-webview.js');
                const scrollSyncUri = this.panel.webview.asWebviewUri(vscode.Uri.file(scrollSyncPath)).toString();

                let katexCssHtml = '';
                if (this.lastConfig.enableMath) {
                    const katexCssPath = path.join(__dirname, 'katex.min.css');
                    try {
                        let katexCss = await fs.promises.readFile(katexCssPath, 'utf-8');
                        const fontsBaseUri = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'fonts'))).toString();
                        katexCss = katexCss.replace(/url\(fonts\//g, `url(${fontsBaseUri}/`);
                        katexCssHtml = `\n  <style id="katex-css">${katexCss}</style>`;
                    } catch { /* KaTeX CSS not found — skip */ }
                }

                const renderOptions = {
                    sourceMap: true,
                    scriptHtml: getScrollSyncScriptTag(this.lastScrollLine, this.lastMaxTopLine, nonce, vscode.l10n.t('Rendering...'), SYNC_MASTER_TIMEOUT_MS, scrollSyncUri, this.lastAtBottom, this.enableDiagramViewer),
                    cspNonce: nonce,
                    cspSource: this.panel.webview.cspSource,
                    lang: vscode.env.language,
                    allowHttpImages: this.lastConfig.allowHttpImages,
                    mermaidScriptUri: mermaidUri,
                    mermaidTheme: this.lastConfig.mermaidTheme,
                    mermaidScale: this.lastConfig.mermaidScale,
                    navTopTitle: vscode.l10n.t('Go to top'),
                    navBottomTitle: vscode.l10n.t('Go to bottom'),
                    navReloadTitle: vscode.l10n.t('Reload'),
                    navTocTitle: vscode.l10n.t('Table of Contents'),
                    katexCssHtml,
                    enableMath: this.lastConfig.enableMath,
                    hideBodyInitially: this.lastScrollLine > 0 || this.lastAtBottom,
                };

                const html = await renderHtmlAsync(text, this.makeTitle(), this.lastConfig, renderOptions, signal);
                if (!this.panel || !this.lastConfig || this.renderSeq !== mySeq || signal.aborted) return;

                let finalHtml = html;
                if (this.lastConfig.allowLocalImages && this.currentFilePath) {
                    const webview = this.panel.webview;
                    finalHtml = resolveLocalImagePaths(
                        html,
                        path.dirname(this.currentFilePath),
                        (absPath) => webview.asWebviewUri(vscode.Uri.file(absPath)).toString()
                    );
                }
                this.panel.webview.html = finalHtml;
                this.initialHtmlSet = true;
                this.initialHtmlHadMermaid = finalHtml.includes('__renderMermaid');
                this.pendingScrollRestore = false;
                htmlReplaced = true;
                this.lastRenderFailed = false;
                // Reset to -1 after embedding the initial scroll position into the HTML.
                // The webview now owns the scroll position from here on; the next
                // onDidChangeTextEditorVisibleRanges event will re-populate these
                // fields from the editor's actual position, and the equality check
                // in the handler (midLine === lastScrollLine) will then correctly
                // detect real scroll changes versus the initial -1 state.
                this.lastScrollLine = -1;
                this.lastMaxTopLine = -1;
                this.lastAtBottom = false;
            } else {
                const renderOptions = { sourceMap: true };
                const { bodyHtml, hasMermaid } = await renderBodyAsync(text, this.lastConfig, renderOptions, signal);
                if (!this.panel || !this.lastConfig || this.renderSeq !== mySeq || signal.aborted) return;

                // When Mermaid is first detected after the initial HTML was built without
                // Mermaid support, rebuild from scratch so the Mermaid <script> is included.
                // The recursive call manages its own htmlReplaced / renderSeq state.
                if (hasMermaid && !this.initialHtmlHadMermaid) {
                    this.initialHtmlSet = false;
                    // Mark as replaced so the outer finally does not send a redundant hideLoading.
                    htmlReplaced = true;
                    // Clear outer controller reference before recursing so the
                    // outer finally block does not interfere with the new one.
                    if (this.renderAbortController === myController) {
                        this.renderAbortController = null;
                    }
                    return await this.renderPanel(text);
                }

                let finalBody = bodyHtml;
                if (this.lastConfig.allowLocalImages && this.currentFilePath) {
                    const webview = this.panel.webview;
                    finalBody = resolveLocalImagePaths(
                        bodyHtml,
                        path.dirname(this.currentFilePath),
                        (absPath) => webview.asWebviewUri(vscode.Uri.file(absPath)).toString()
                    );
                }
                const msg: Record<string, unknown> = { type: 'updateBody', html: finalBody, hasMermaid };
                if (this.pendingScrollRestore && this.lastScrollLine >= 0) {
                    msg.scrollTo = { line: this.lastScrollLine, maxTopLine: this.lastMaxTopLine, atBottom: this.lastAtBottom };
                }
                if (this.pendingScrollRestore) {
                    msg.themeCss = getThemeCss(this.lastConfig.previewTheme || 'github-light');
                }
                this.pendingScrollRestore = false;
                void this.panel.webview.postMessage(msg);
                htmlReplaced = true;
                this.lastRenderFailed = false;
            }
        } catch (err) {
            this.outputChannel.appendLine(`[renderPanel error] ${err}`);
            this.lastRenderFailed = true;
            if (this.panel && this.initialHtmlSet) {
                void this.panel.webview.postMessage({
                    type: 'updateBody',
                    html: `<div style="padding:2em;color:var(--vscode-errorForeground,red);">${escapeHtml(String(err))}</div>`,
                    hasMermaid: false,
                });
                htmlReplaced = true;
            }
        } finally {
            if (this.renderAbortController === myController) {
                this.renderAbortController = null;
            }
            if (!htmlReplaced && this.panel) {
                void this.panel.webview.postMessage({ type: 'hideLoading' });
            }
            if (htmlReplaced) {
                this.updateIncludePaths(text);
                this.lastPlantUmlBlocks = extractPlantUmlBlocks(text);
                this.lastMermaidBlocks = extractMermaidBlocks(text);
                this.lastD2Blocks = extractD2Blocks(text);
                this.lastRenderedText = text;
            }
        }
    }

    /** Render with a loading overlay and optional progress notification. @returns void */
    private renderPanelWithLoading(text: string): void {
        if (!this.panel || !this.lastConfig) return;

        if (this.loadingRenderTimer) { clearTimeout(this.loadingRenderTimer); this.loadingRenderTimer = null; }
        if (this.loadingResolve) { this.loadingResolve(); this.loadingResolve = null; }

        const hasDiagram = PLANTUML_FENCE_TEST_RE.test(text) || MERMAID_FENCE_TEST_RE.test(text) || D2_FENCE_TEST_RE.test(text);
        if (!hasDiagram) {
            this.suppressLoadingNotification = false;
            void this.renderPanel(text).catch(err => {
                this.outputChannel.appendLine(`[render error] ${err}`);
            }).finally(() => {
                this.fireDeferredWork();
            });
            return;
        }

        void this.panel.webview.postMessage({ type: 'showLoading' });

        const skipNotification = this.suppressLoadingNotification;
        this.suppressLoadingNotification = false;

        const doRender = () => {
            this.loadingRenderTimer = null;
            void this.renderPanel(text).catch(err => {
                this.outputChannel.appendLine(`[render error] ${err}`);
            }).finally(() => {
                if (this.loadingResolve) { this.loadingResolve(); this.loadingResolve = null; }
                this.fireDeferredWork();
            });
        };

        if (skipNotification) {
            this.loadingRenderTimer = setTimeout(doRender, 50);
        } else {
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rendering diagrams...') },
                () => new Promise<void>((resolve) => {
                    this.loadingResolve = resolve;
                    this.loadingRenderTimer = setTimeout(doRender, 50);
                })
            );
        }
    }

    // -- public API ---------------------------------------------------

    /** Return the current preview WebviewPanel, or null if not open. */
    getPanel(): vscode.WebviewPanel | null { return this.panel; }

    /** Return the Markdown file path being previewed, or null. */
    getCurrentFilePath(): string | null { return this.currentFilePath; }

    /** Whether the most recent render attempt failed. */
    getLastRenderFailed(): boolean { return this.lastRenderFailed; }

    /**
     * Open (or reuse) the preview panel for the given Markdown file.
     *
     * @param filePath - Absolute path to the Markdown file.
     * @param config - Current extension configuration snapshot.
     * @param preserveFocus - If true, keep focus on the editor.
     * @param suppressNotification - If true, skip the loading progress notification.
     */
    open(filePath: string, config: Config, preserveFocus = false, suppressNotification = false): Promise<void> {
        this.lastConfig = config;
        this.suppressLoadingNotification = suppressNotification;

        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }

        if (this.currentFilePath !== filePath) {
            this.lastScrollLine = -1;
            this.lastMaxTopLine = -1;
            this.lastAtBottom = false;
            this.pendingScrollRestore = true;
            this.lastDiagramContent = '';
            disposeAllViewers();
        }
        this.currentFilePath = filePath;

        if (this.panel) {
            this.panel.title = this.makeTitle();
            const optionsChanged = this.applyWebviewOptions();
            this.disposeEventHandlers();
            this.registerEventHandlers();
            if (optionsChanged) {
                this.initialHtmlSet = false;
            }
            if (suppressNotification) {
                this.panel.reveal(vscode.ViewColumn.Two, preserveFocus);
            } else if (!preserveFocus) {
                this.panel.reveal(vscode.ViewColumn.Two, false);
            }
        } else {
            const pmCfg = vscode.workspace.getConfiguration('plantumlMarkdownPreview');
            this.retainCtx = pmCfg.get<boolean>('retainPreviewContext', true);
            this.enableDiagramViewer = pmCfg.get<boolean>('enableDiagramViewer', true);
            this.panel = vscode.window.createWebviewPanel(
                'plantumlMarkdownPreview',
                this.makeTitle(),
                { viewColumn: vscode.ViewColumn.Two, preserveFocus },
                {
                    enableFindWidget: true,
                    enableScripts: true,
                    retainContextWhenHidden: this.retainCtx,
                    localResourceRoots: config.allowLocalImages ? this.buildLocalResourceRoots(filePath) : [vscode.Uri.file(__dirname)],
                }
            );
            this.panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<div id="loading-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:var(--vscode-editor-background,#fff);display:flex;align-items:center;justify-content:center;z-index:9999;">
<div style="color:var(--vscode-editor-foreground,#333);font-size:14px;">${escapeHtml(vscode.l10n.t('Rendering...'))}</div>
</div></body></html>`;

            this.disposeDisposable = this.panel.onDidDispose(() => this.resetState());
            this.viewStateDisposable = this.panel.onDidChangeViewState(() => {
                if (!this.panel) return;
                if (!this.panel.visible) {
                    if (!this.retainCtx) this.panelWasHidden = true;
                    // Snapshot the scroll line so a visible restore can detect whether
                    // the source scrolled while we were hidden (see the active block).
                    this.scrollLineWhenHidden = this.lastScrollLine;
                    return;
                }
                // Re-render on show when either:
                //  - the webview was discarded (retainContextWhenHidden: false), or
                //  - a render was deferred while hidden (pendingShowRender).
                // This must run regardless of active state. The render pipeline's
                // pendingScrollRestore path restores to the source's current
                // position (lastScrollLine is kept up to date even while hidden).
                const willReRender =
                    (this.panelWasHidden || this.pendingShowRender) && !!this.currentFilePath && !!this.lastConfig;
                if (willReRender) {
                    this.panelWasHidden = false;
                    this.pendingShowRender = false;
                    this.pendingScrollRestore = true;
                    this.scrollLineWhenHidden = -1;
                    void this.readFileContent(this.currentFilePath!).then((text) => {
                        if (text === null || !this.panel || !this.lastConfig) return;
                        void this.renderPanel(text).catch(err =>
                            this.outputChannel.appendLine(`[re-render on show] ${err}`)
                        );
                    });
                }
                if (!this.panel.active) {
                    // Preview lost focus — do NOT move the source editor here.
                    // Per the user's rule, whichever side becomes current stays
                    // put; the other side follows. When the source becomes the
                    // new current, it is the preview that must follow, not the
                    // source that gets yanked to the preview's position.
                    return;
                }

                // Preview regained focus without a re-render. Two cases, by whether
                // the source scrolled while we were hidden:
                //  (B) source moved -> the source is the master; re-sync the preview
                //      to the source's current position (this is the bug we fix).
                //  (A) source unchanged -> the preview is the master. With
                //      retainContextWhenHidden=true the webview already holds its
                //      exact pixel position; sending scrollToLine (integer line)
                //      would cause sub-line round-trip drift, so send nothing.
                // (A re-render above already restored scroll via the render pipeline.)
                const sourceMovedWhileHidden = !willReRender &&
                    this.scrollLineWhenHidden >= 0 && this.lastScrollLine !== this.scrollLineWhenHidden;
                this.scrollLineWhenHidden = -1; // consume (avoid re-fire / false positives)
                if (sourceMovedWhileHidden) {
                    this.syncPreviewToSourceNow();
                }
            });
            this.registerEventHandlers();
        }

        // Note: the initial scroll position is captured by renderPanel's
        // (!initialHtmlSet || pendingScrollRestore) branch from the active editor —
        // no need to set lastScrollLine here as well.
        // If open() is called again before the first render completes,
        // resolve the previous promise immediately so it doesn't hang.
        return new Promise<void>((resolve) => {
            const prev = this.firstRenderResolve;
            this.firstRenderResolve = resolve;
            prev?.();

            void this.readFileContent(filePath).then((text) => {
                if (text === null) {
                    this.suppressLoadingNotification = false;
                    this.fireDeferredWork();
                    return;
                }
                if (this.currentFilePath !== filePath) {
                    this.fireDeferredWork();
                    return;
                }
                this.lastDiagramContent = this.extractDiagramContent(text);
                this.renderPanelWithLoading(text);
            }).catch(() => {
                this.suppressLoadingNotification = false;
                this.fireDeferredWork();
            });
        });
    }

    /** Apply new configuration and re-render if rendering-related keys changed. */
    updateConfig(config: Config): void {
        if (!this.panel || !this.currentFilePath) return;

        const oldConfig = this.lastConfig;
        this.lastConfig = config;

        if (!oldConfig) {
            // First config — full render
        } else {
            const changed = this.changedRenderKeys(config, oldConfig);

            if (changed.size === 1 && changed.has('previewTheme')) {
                const css = getThemeCss(config.previewTheme || 'github-light');
                void this.panel.webview.postMessage({ type: 'updateTheme', css });
                return;
            }

            if (changed.size === 0) return;

            if (changed.has('mermaidTheme')) {
                void this.panel.webview.postMessage({
                    type: 'reinitMermaid',
                    theme: config.mermaidTheme || 'default'
                });
            }

            if (changed.has('allowLocalImages')) {
                this.applyWebviewOptions();
            }

            if (changed.has('mode') || changed.has('plantumlIncludePath')) {
                clearCache();
                clearServerCache();
                this.initialHtmlSet = false;
                this.panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:var(--vscode-editor-background,#fff);display:flex;align-items:center;justify-content:center;">
<div style="color:var(--vscode-editor-foreground,#333);font-size:14px;">${escapeHtml(vscode.l10n.t('Rendering...'))}</div>
</div></body></html>`;
            }

            if (changed.has('plantumlIncludePath')) {
                const resolved = resolveIncludePath(config) || '';
                if (config.plantumlIncludePath && resolved !== config.plantumlIncludePath) {
                    void vscode.window.showWarningMessage(
                        vscode.l10n.t('PlantUML include path "{0}" does not exist. Using workspace root instead.', config.plantumlIncludePath)
                    );
                }
                if (resolved) {
                    void vscode.window.showInformationMessage(
                        vscode.l10n.t('PlantUML include path changed to: {0}', resolved)
                    );
                }
                // Server restart is handled by handleLocalServerConfigChange() in extension.ts
                // via LOCAL_SERVER_KEYS — no need to restart here.
            }

            if ([...changed].some(k => HEAD_KEYS.has(k))) {
                this.initialHtmlSet = false;
            }
        }

        void this.readFileContent(this.currentFilePath).then((text) => {
            if (text === null) return;
            this.renderPanelWithLoading(text);
        }).catch(err => this.outputChannel.appendLine(`[config update error] ${err}`));
    }

    /** Show a theme QuickPick and apply the selected theme. */
    async changeTheme(): Promise<void> {
        if (!this.panel) return;

        const currentPreviewTheme = this.lastConfig ? this.lastConfig.previewTheme : 'github-light';
        const currentPlantumlTheme = this.lastConfig ? this.lastConfig.plantumlTheme : 'default';
        const currentMermaidTheme = this.lastConfig ? this.lastConfig.mermaidTheme : 'default';
        const currentD2Theme = this.lastConfig ? this.lastConfig.d2Theme : 'Neutral Default';

        const plantumlThemes = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Fetching PlantUML theme list...') },
            () => listThemesAsync(this.lastConfig || { plantumlJarPath: '', javaPath: 'java' })
        );
        if (!this.panel) return;

        const items = [
            { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems(LIGHT_THEME_KEYS, 'preview' as const, currentPreviewTheme),
            { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems(DARK_THEME_KEYS, 'preview' as const, currentPreviewTheme),
            { label: vscode.l10n.t('PlantUML Theme'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems(['default', ...plantumlThemes], 'plantuml' as const, currentPlantumlTheme),
            { label: vscode.l10n.t('Mermaid Theme'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems([...MERMAID_THEME_KEYS], 'mermaid' as const, currentMermaidTheme),
            { label: vscode.l10n.t('D2 Theme'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems([...D2_THEME_KEYS], 'd2' as const, currentD2Theme),
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Select theme')
        });
        if (!this.panel) return;

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
            } else if (selected.category === 'd2') {
                if (selected.themeKey === currentD2Theme) return;
                await cfg.update('d2Theme', selected.themeKey, vscode.ConfigurationTarget.Global);
            }
        } catch (err) {
            vscode.window.showErrorMessage(vscode.l10n.t('[PlantUML Markdown Preview] {0}', (err as Error).message));
        }
    }

    /** Dispose the preview panel and all associated resources. */
    dispose(): void {
        if (this.panel) {
            this.panel.dispose();
        }
    }
}
