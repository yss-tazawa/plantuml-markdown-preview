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
    /** Last line reported by the preview via revealLine (tracked even when blocked). */
    private lastPreviewReportedLine = -1;
    private activeEditorDisposable: vscode.Disposable | null = null;

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

    /** Build the panel title from the current file name. */
    private makeTitle(): string {
        const name = this.currentFilePath ? path.basename(this.currentFilePath, '.md') : 'Untitled';
        return name + ' ' + vscode.l10n.t('(Preview)');
    }

    /** Build the localResourceRoots array based on the file location. */
    private buildLocalResourceRoots(filePath: string): vscode.Uri[] {
        const roots: vscode.Uri[] = [
            vscode.Uri.file(__dirname),
            vscode.Uri.file(path.dirname(filePath)),
        ];
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (workspaceFolder) {
            roots.push(workspaceFolder.uri);
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
        if (this.activeEditorDisposable) { this.activeEditorDisposable.dispose(); this.activeEditorDisposable = null; }
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
        this.initialHtmlSet = false;
        this.initialHtmlHadMermaid = false;
        this.pendingScrollRestore = false;
        this.lastRenderFailed = false;
        this.panelWasHidden = false;
        this.syncMaster = 'none';
        this.lastPlantUmlBlocks = [];
        this.lastMermaidBlocks = [];
        this.lastD2Blocks = [];
        this.lastRenderedText = null;

        this.lastPreviewReportedLine = -1;
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
                // Always track the preview's position (used for initial sync on editor activation).
                const line = Math.max(0, Math.round(message.line));
                this.lastPreviewReportedLine = line;

                if (this.syncMaster === 'editor') return;
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.fsPath === this.currentFilePath
                );
                if (!editor) return;

                this.setSyncMaster('preview');
                const range = new vscode.Range(line, 0, line, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                this.lastScrollLine = line;
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
            if (this.syncMaster === 'preview') return;
            if (this.pendingScrollRestore) return;

            const topLine = event.visibleRanges[0].start.line;
            const bottomLine = event.visibleRanges[0].end.line;
            const lineCount = event.textEditor.document.lineCount;
            const visibleLineCount = bottomLine - topLine + 1;
            const maxTopLine = this.calcMaxTopLine(lineCount, visibleLineCount);

            let midLine: number;
            if (topLine === 0) midLine = 0;
            else if (bottomLine >= lineCount - 1) midLine = bottomLine;
            else midLine = Math.floor((topLine + bottomLine) / 2);

            if (midLine === this.lastScrollLine && maxTopLine === this.lastMaxTopLine) return;
            this.setSyncMaster('editor');
            this.lastScrollLine = midLine;
            this.lastMaxTopLine = maxTopLine;
            const atBottom = topLine >= maxTopLine && topLine > 0;
            this.lastAtBottom = atBottom;
            void this.panel.webview.postMessage({ type: 'scrollToLine', line: midLine, maxTopLine, atBottom });
        });

        this.activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || editor.document.uri.fsPath !== this.currentFilePath) return;

            // Suppress stale onDidChangeTextEditorVisibleRanges events from moving
            // the preview during the activation transition.
            this.setSyncMaster('preview');

            // Initial sync: scroll the editor to the preview's last known position.
            // The pre-scroll in onDidChangeViewState may have already positioned it;
            // only call revealRange as a fallback if the editor is not yet there.
            if (this.lastPreviewReportedLine >= 0) {
                // Always apply revealRange — during tab switch, editor.visibleRanges
                // reports the default position (line 0) before VS Code restores the
                // previous scroll state, so comparing currentTop is unreliable.
                const range = new vscode.Range(this.lastPreviewReportedLine, 0, this.lastPreviewReportedLine, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                this.lastScrollLine = this.lastPreviewReportedLine;
            }
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
        if (this.renderAbortController) this.renderAbortController.abort();
        const myController = new AbortController();
        this.renderAbortController = myController;
        const signal = myController.signal;

        const mySeq = ++this.renderSeq;
        let htmlReplaced = false;

        if (!this.initialHtmlSet || this.pendingScrollRestore) {
            const editor = vscode.window.activeTextEditor;
            if (editor && this.currentFilePath && editor.document.uri.fsPath === this.currentFilePath && editor.visibleRanges.length > 0) {
                this.lastScrollLine = editor.visibleRanges[0].start.line;
                const bottomLine = editor.visibleRanges[0].end.line;
                const lineCount = editor.document.lineCount;
                const visibleLineCount = bottomLine - this.lastScrollLine + 1;
                this.lastMaxTopLine = this.calcMaxTopLine(lineCount, visibleLineCount);
                this.lastAtBottom = this.lastScrollLine >= this.lastMaxTopLine && this.lastScrollLine > 0;
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
                this.lastScrollLine = -1;
                this.lastMaxTopLine = -1;
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

    /** Render with a loading overlay and optional progress notification. */
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
                    return;
                }
                // Re-render after being hidden (retainContextWhenHidden: false).
                // This must run regardless of active state.
                if (this.panelWasHidden && this.currentFilePath && this.lastConfig) {
                    this.panelWasHidden = false;
                    void this.readFileContent(this.currentFilePath).then((text) => {
                        if (text === null || !this.panel || !this.lastConfig) return;
                        void this.renderPanel(text).catch(err =>
                            this.outputChannel.appendLine(`[re-render on show] ${err}`)
                        );
                    });
                }
                if (!this.panel.active) {
                    // Preview lost focus — pre-scroll the editor to the preview's
                    // position while it is still in the background tab so no scroll
                    // animation is visible when the editor tab appears.
                    if (this.lastPreviewReportedLine >= 0 && this.currentFilePath) {
                        const editor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.fsPath === this.currentFilePath
                        );
                        if (editor) {
                            this.setSyncMaster('preview');
                            const range = new vscode.Range(this.lastPreviewReportedLine, 0, this.lastPreviewReportedLine, 0);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                            this.lastScrollLine = this.lastPreviewReportedLine;
                        }
                    }
                    return;
                }

                // Suppress editor→preview feedback during initial sync so the editor
                // doesn't jump when the preview scrolls to the editor's position.
                this.setSyncMaster('editor');
                if (this.retainCtx && this.lastScrollLine >= 0) {
                    void this.panel.webview.postMessage({ type: 'scrollToLine', line: this.lastScrollLine, maxTopLine: this.lastMaxTopLine, atBottom: this.lastAtBottom });
                }
            });
            this.registerEventHandlers();
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.fsPath === filePath && activeEditor.visibleRanges.length > 0) {
            this.lastScrollLine = activeEditor.visibleRanges[0].start.line;
            const visibleLineCount = activeEditor.visibleRanges[0].end.line - activeEditor.visibleRanges[0].start.line + 1;
            this.lastMaxTopLine = this.calcMaxTopLine(activeEditor.document.lineCount, visibleLineCount);
        }
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
