/**
 * @module standalone-preview
 * @description Factory for standalone diagram file previews (D2, PlantUML, Mermaid).
 *
 * Encapsulates the common lifecycle shared by all standalone preview panels:
 * panel creation / disposal, debounced re-rendering on text changes,
 * preview-theme QuickPick, and VS Code event wiring.
 *
 * Each diagram type supplies a small definition object describing its
 * rendering pipeline and theme options; the factory returns a uniform API.
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION, type Config } from './config.js';
import { VSCODE_THEME_KEYS, LIGHT_THEME_KEYS, DARK_THEME_KEYS, getThemeBgColor } from './exporter.js';
import { getNonce, buildThemeItems, showThemeQuickPick, readSource, isLiveSourceUri, errorPage } from './utils.js';
import { handleViewerMessage } from './export-handler.js';
import type { AdoptedPanel, DiagramReadingView } from './reading-view.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single item returned by {@link buildThemeItems}. */
export type ThemeItem = ReturnType<typeof buildThemeItems>[number];

/** Section of diagram-specific theme items for the QuickPick. */
export interface DiagramThemeSection {
    label: string;
    items: ThemeItem[];
}

/**
 * Definition object that captures the diagram-specific behaviour.
 * One of these is passed to {@link createStandalonePreview} for each diagram type.
 */
export interface StandalonePreviewDef {
    /** `WebviewPanel` view-type identifier (e.g. `'plantumlD2Preview'`). */
    viewType: string;

    /** Fallback name shown in the panel title when the filename is unavailable. */
    defaultTitle: string;

    /** Local resource roots passed to `createWebviewPanel`. May be a function for dynamic resolution. */
    localResourceRoots?: vscode.Uri[] | (() => vscode.Uri[]);

    /**
     * Generate the full webview HTML from file content.
     *
     * Called once when the panel is first created.
     * For SVG-based previews this should render the diagram first.
     * Throws when the page cannot be built.
     */
    buildHtml(content: string, nonce: string, bgColor: string, panel: vscode.WebviewPanel): Promise<string> | string;

    /**
     * Push new content into the webview.
     *
     * For SVG-based previews: render SVG in the extension host, then post a
     * message.  For source-based previews (Mermaid): post the raw source text.
     */
    updateWebview(panel: vscode.WebviewPanel, content: string, bgColor: string, signal?: AbortSignal): Promise<void>;

    /**
     * Display an error inside the webview (e.g. "file not found").
     *
     * @returns `true` if it replaced `panel.webview.html`; the factory then does not
     *          replace it again with the same error when that page reports its load.
     */
    showError(panel: vscode.WebviewPanel, message: string, nonce: string): boolean;

    /**
     * Handle a preview-theme change.
     *
     * If not provided the factory calls {@link renderCurrentFile} (re-renders
     * the diagram with the new background).  Mermaid overrides this to send a
     * lightweight `updateBgColor` message instead.
     */
    onPreviewThemeChanged?(panel: vscode.WebviewPanel, bgColor: string): void;

    /**
     * Handle a page load (told by a `webviewReady`) by sending the current
     * webview-side state. The page shows the state its HTML was built with, and VS Code
     * recreates the webview from that HTML in some cases (e.g. shown again after being
     * hidden with retainPreviewContext off, or moved to another window).
     * The factory re-renders the current file right after this call.
     */
    onWebviewReady?(panel: vscode.WebviewPanel, bgColor: string): void;

    /**
     * Return the diagram-specific section for the theme QuickPick.
     *
     * May be async (PlantUML fetches the theme list lazily).
     * Return `null` if there are no diagram-specific themes.
     */
    buildDiagramThemeItems?(): DiagramThemeSection | Promise<DiagramThemeSection | null> | null;

    /**
     * Handle diagram-theme selection from the QuickPick.
     *
     * @returns `'render'` to schedule a debounced re-render, `'done'` if the
     *          callback already handled the update (e.g. via `postMessage`).
     */
    onDiagramThemeSelected?(themeKey: string, panel: vscode.WebviewPanel): 'render' | 'done';

    /**
     * Should a settings change trigger a re-render?
     *
     * Called on every settings change while a panel exists; implementations
     * ignore keys that a local diagram-theme override takes precedence over.
     */
    shouldReRenderOnConfigChange?(prevConfig: Config, newConfig: Config): boolean;

    /** Hook called right after the panel is created (e.g. to prefetch themes). */
    onPanelCreated?(config: Config): void;

    /** Return include file paths tracked for save-triggered re-renders. */
    collectIncludePaths?(content: string, config: Config): Set<string>;

    /** Called when a tracked include file is saved (e.g. to clear caches). */
    onIncludeFileSaved?(): void;

    /** Reset diagram-specific local state on panel dispose. */
    resetDiagramState(): void;
}

/** Public API returned by {@link createStandalonePreview}. */
export interface StandalonePreview {
    open(filePath: string, config: Config): Promise<void>;
    /**
     * Show the file in the panel handed over at creation (Reading View only).
     * A file it cannot show leaves an error page, which tries the file again when it
     * is saved or when the panel is shown again. Settles when the first render ends.
     */
    openAdopted(config: Config): Promise<void>;
    updateConfig(config: Config): void;
    getCurrentFilePath(): string | null;
    getPanel(): vscode.WebviewPanel | null;
    /** Source text of the most recent render handed to the webview, or null. */
    getLastRenderedText(): string | null;
    dispose(): void;
    changeTheme(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a standalone diagram preview backed by the given definition.
 *
 * All mutable state lives inside the returned closure — callers keep a
 * reference to the {@link StandalonePreview} object and delegate to it.
 *
 * @param def - Diagram-specific behaviour.
 * @param adopted - Panel handed over by VS Code and the file it shows, for a Reading
 *                  View; omitted for the preview, which creates its own panel.
 *                  A Reading View never disposes its panel.
 */
export function createStandalonePreview(def: StandalonePreviewDef, adopted?: AdoptedPanel): StandalonePreview {
    // -- shared state --------------------------------------------------------
    let panel: vscode.WebviewPanel | null = adopted?.panel ?? null;
    let currentFilePath: string | null = adopted?.filePath ?? null;
    /** Source of the most recent render handed to the webview. */
    let lastRenderedText: string | null = null;
    /** Configuration the current panel uses; null while no panel exists. */
    let lastConfig: Config | null = null;
    /**
     * Newest requested configuration, from open() or updateConfig(), panel or not.
     * A panel built by an open in progress takes it, not the config of that open.
     */
    let latestConfig: Config | null = null;
    let localPreviewTheme: string | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Message of the error page `showError` last assigned to `webview.html`, until a
     * render updates the page. A render that finds the same error leaves that page as
     * it is, so the load the page reports does not replace it again, endlessly.
     */
    let shownError: string | null = null;
    const panelDisposables: vscode.Disposable[] = [];
    /** Listeners that try the file again while a Reading View shows an error page in its place. */
    const retryListeners: vscode.Disposable[] = [];
    let renderSeq = 0;
    let renderAbort: AbortController | null = null;
    /**
     * Generation of the latest open. Every open and every panel disposal bumps it;
     * an open whose generation is no longer current stops after its next await.
     */
    let openGeneration = 0;
    /** Generation of the open in progress, or null; guards against concurrent opens. */
    let activeOpen: number | null = null;
    /** File requested while an open was in progress; opened after that open ends. */
    let pendingOpen: { filePath: string; config: Config } | null = null;

    // -- include tracking ----------------------------------------------------
    /** Absolute paths of `!include` files tracked for save-triggered re-renders. */
    let includePaths = new Set<string>();

    /**
     * Collect include paths via the definition hook and update the tracking set.
     * @param content - Raw diagram source text.
     */
    function updateIncludePaths(content: string): void {
        if (!lastConfig || !def.collectIncludePaths) { includePaths = new Set<string>(); return; }
        includePaths = def.collectIncludePaths(content, lastConfig);
    }

    // -- helpers -------------------------------------------------------------

    /** Return the effective preview theme, falling back to config or 'github-light'. */
    function getPreviewTheme(): string {
        return localPreviewTheme ?? (lastConfig ? lastConfig.previewTheme : 'github-light');
    }

    /** Return the CSS background color for the current preview theme. */
    function getCurrentBgColor(): string {
        return getThemeBgColor(getPreviewTheme());
    }

    /** Build a panel title from the file name (e.g. "foo.puml (Preview)", "foo.puml [Reading View]"). */
    function makePanelTitle(filePath: string): string {
        const name = filePath.split(/[/\\]/).pop() ?? def.defaultTitle;
        return `${name} ${adopted ? vscode.l10n.t('[Reading View]') : vscode.l10n.t('(Preview)')}`;
    }

    /** Schedule a debounced re-render of the current file. */
    function scheduleRender(): void {
        if (debounceTimer) clearTimeout(debounceTimer);
        const delay = lastConfig?.debounceDiagramChangeMs ?? 300;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void renderCurrentFile();
        }, delay);
    }

    /** Re-render the current file in the webview panel. */
    async function renderCurrentFile(): Promise<void> {
        if (!panel || !currentFilePath || !lastConfig) return;

        if (renderAbort) renderAbort.abort();
        renderAbort = new AbortController();
        const signal = renderAbort.signal;
        const seq = ++renderSeq;

        panel.title = makePanelTitle(currentFilePath);

        const content = await readSource(currentFilePath);
        if (signal.aborted || seq !== renderSeq) {
            // A newer render owns renderAbort; only clear our own controller.
            if (renderAbort?.signal === signal) renderAbort = null;
            return;
        }

        if (content === null) {
            const message = vscode.l10n.t('File not found: {0}', currentFilePath);
            if (message !== shownError && def.showError(panel, message, getNonce())) {
                shownError = message;
            }
            if (renderAbort?.signal === signal) renderAbort = null;
            return;
        }

        try {
            await def.updateWebview(panel, content, getCurrentBgColor(), signal);
            if (signal.aborted || seq !== renderSeq) return;
            lastRenderedText = content;
            shownError = null;
            updateIncludePaths(content);
        } finally {
            if (renderAbort?.signal === signal) renderAbort = null;
        }
    }

    /** Clean up all panel state and disposables. */
    function disposeState(): void {
        // Supersede the open in progress and drop the queued one: the panel is gone.
        openGeneration++;
        activeOpen = null;
        pendingOpen = null;
        panel = null;
        currentFilePath = null;
        lastConfig = null;
        localPreviewTheme = null;
        shownError = null;
        lastRenderedText = null;
        includePaths = new Set<string>();
        def.resetDiagramState();
        for (const d of panelDisposables) d.dispose();
        panelDisposables.length = 0;
        disposeRetryListeners();
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (renderAbort) { renderAbort.abort(); renderAbort = null; }
    }

    /**
     * Handle a page load reported by the webview of `from`: send the current state.
     * Updates posted before the page could receive them, or while its webview was gone
     * (hidden without retained context), were dropped, and a webview VS Code recreated
     * from its HTML shows the diagram, theme and background that HTML was built with.
     *
     * @param from - Panel whose webview posted the message.
     */
    function handleWebviewReady(from: vscode.WebviewPanel): void {
        if (panel !== from) return;
        def.onWebviewReady?.(from, getCurrentBgColor());
        void renderCurrentFile();
    }

    /**
     * Body of {@link open}: reveal or create the panel and render the file.
     * Stops after any await once `generation` is superseded by a panel disposal.
     *
     * @param generation - Generation that {@link open} assigned to this open.
     * @param filePath - Absolute path of the diagram file to show.
     * @param config - Configuration to render with.
     */
    async function openFile(generation: number, filePath: string, config: Config): Promise<void> {
        if (panel) {
            lastConfig = config;
            currentFilePath = filePath;
            panel.reveal(vscode.ViewColumn.Two, true);
            panel.title = makePanelTitle(filePath);
            await renderCurrentFile();
            return;
        }

        let content: string | null;
        try {
            content = await readSource(filePath);
        } catch {
            return;
        }
        if (generation !== openGeneration) return;
        if (content === null) return;

        const created = vscode.window.createWebviewPanel(
            def.viewType,
            makePanelTitle(filePath),
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: vscode.workspace.getConfiguration(CONFIG_SECTION)
                    .get<boolean>('retainPreviewContext', true),
                localResourceRoots: resolveLocalResourceRoots(),
            }
        );
        // Take the file only once a panel exists, so a failed creation leaves none behind.
        panel = created;
        // A settings change during the read is newer than the config of this open.
        lastConfig = latestConfig ?? config;
        currentFilePath = filePath;
        // Listen before building the HTML: the panel can be closed while it is built.
        listenForDisposal(created);
        await setUpPanel(generation, created, content, config);
    }

    /**
     * Reset the state when the panel is closed.
     * @param target - The panel taken as `panel`.
     */
    function listenForDisposal(target: vscode.WebviewPanel): void {
        panelDisposables.push(target.onDidDispose(() => { if (panel === target) disposeState(); }));
    }

    /** Local resource roots the definition asks for. */
    function resolveLocalResourceRoots(): vscode.Uri[] {
        return typeof def.localResourceRoots === 'function'
            ? def.localResourceRoots()
            : def.localResourceRoots ?? [];
    }

    /**
     * Show the file in a panel that has no content yet: build the HTML and listen to
     * the panel, the webview and the documents. A preview's panel that cannot get its
     * HTML is closed; a Reading View's panel shows the error instead (see
     * {@link showAdoptedError}).
     *
     * @param generation - Generation of the open in progress.
     * @param target - The panel, already taken as `panel` and listened to for disposal.
     * @param content - Diagram source read for the first render.
     * @param config - Configuration of the open, used when no newer one exists.
     */
    async function setUpPanel(generation: number, target: vscode.WebviewPanel, content: string, config: Config): Promise<void> {
        let html: string | null;
        let buildError = '';
        try {
            html = await def.buildHtml(content, getNonce(), getCurrentBgColor(), target);
        } catch (err) {
            html = null;
            buildError = err instanceof Error ? err.message : String(err);
        }
        // A disposal that superseded this open has already cleared the state. A Reading
        // View's open is superseded only by its disposal, which leaves the panel to VS Code.
        if (generation !== openGeneration) { if (!adopted) target.dispose(); return; }
        if (html === null && adopted) {
            showAdoptedError(target, adopted.filePath, vscode.l10n.t('[PlantUML Markdown Preview] {0}', buildError));
            return;
        }
        if (html === null) {
            // Disposing runs disposeState(), which cancels renders scheduled during the
            // build and resets panel-local state; keep the queued open, which it drops.
            const queued = pendingOpen;
            target.dispose();
            // As in dispose(): reset here if the listener did not run.
            if (panel === target) disposeState();
            pendingOpen = queued;
            // Hold the guard until open() releases it and opens the queued file, so a
            // newer request replaces the queued one instead of running before it.
            activeOpen = generation;
            return;
        }
        panelDisposables.push(target.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === 'webviewReady') {
                handleWebviewReady(target);
                return;
            }
            void handleViewerMessage(msg, currentFilePath);
        }));
        target.webview.html = html;
        lastRenderedText = content;

        panelDisposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (!currentFilePath) return;
                // A `git:` diff document shares the working-tree fsPath, and its content
                // provider updates arrive here as ordinary change events. Without this
                // guard, activity on the diff side triggers a needless re-render.
                if (!isLiveSourceUri(e.document.uri)) return;
                if (e.document.uri.fsPath !== currentFilePath) return;
                scheduleRender();
            })
        );

        panelDisposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (!currentFilePath) return;
                if (doc.uri.fsPath === currentFilePath) {
                    scheduleRender();
                    return;
                }
                if (includePaths.has(doc.uri.fsPath)) {
                    def.onIncludeFileSaved?.();
                    scheduleRender();
                }
            })
        );

        def.onPanelCreated?.(lastConfig ?? config);
    }

    /**
     * Read the file and show it in the handed-over panel. A file that cannot be read
     * shows an error page.
     *
     * @param generation - Generation assigned to this open.
     * @param target - The handed-over panel.
     * @param filePath - Absolute path of the file it shows.
     */
    async function openAdoptedFile(generation: number, target: vscode.WebviewPanel, filePath: string): Promise<void> {
        let content: string | null;
        try {
            content = await readSource(filePath);
        } catch {
            content = null;
        }
        if (generation !== openGeneration) return;
        if (content === null) {
            showAdoptedError(target, filePath, vscode.l10n.t('File not found: {0}', filePath));
            return;
        }
        await setUpPanel(generation, target, content, latestConfig ?? lastConfig!);
    }

    /**
     * Show an error page in the handed-over panel in place of the file, and try the
     * file again when it is saved or when the panel is shown again after being hidden.
     *
     * @param target - The handed-over panel.
     * @param filePath - Absolute path of the file it shows.
     * @param message - Text of the error page.
     */
    function showAdoptedError(target: vscode.WebviewPanel, filePath: string, message: string): void {
        target.webview.html = errorPage(message);
        disposeRetryListeners();
        let hidden = false;
        retryListeners.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.uri.fsPath === filePath) retryAdopted();
            }),
            target.onDidChangeViewState(() => {
                if (!target.visible) { hidden = true; return; }
                if (hidden) retryAdopted();
            }),
        );
    }

    /** Stop the listeners {@link showAdoptedError} set. */
    function disposeRetryListeners(): void {
        for (const d of retryListeners) d.dispose();
        retryListeners.length = 0;
    }

    /** Try again to show the file in the handed-over panel showing an error page. */
    function retryAdopted(): void {
        disposeRetryListeners();
        void showAdopted();
    }

    /**
     * Show the file in the handed-over panel, unless the view is disposed or an open
     * is under way.
     */
    async function showAdopted(): Promise<void> {
        if (!adopted || panel !== adopted.panel || activeOpen !== null) return;
        const generation = ++openGeneration;
        activeOpen = generation;
        try {
            await openAdoptedFile(generation, adopted.panel, adopted.filePath);
        } finally {
            if (activeOpen === generation) activeOpen = null;
        }
    }

    // -- public API ----------------------------------------------------------

    /** Open (or reveal) the standalone preview panel for the given diagram file. */
    async function open(filePath: string, config: Config): Promise<void> {
        // Guard against double panel creation if open() is called again during await.
        // latestConfig is updated first, so an open in progress builds its panel with it;
        // currentFilePath is only set by the open that owns the guard; lastConfig by it
        // and by updateConfig while a panel exists.
        latestConfig = config;
        if (activeOpen !== null) { pendingOpen = { filePath, config }; return; }

        const generation = ++openGeneration;
        activeOpen = generation;
        try {
            await openFile(generation, filePath, config);
        } finally {
            // Only the current open owns the guard; a superseded one leaves it alone.
            if (activeOpen === generation) activeOpen = null;
            // Whichever way the open ended, show the file requested while it ran.
            // Its caller has already returned, so its failure is logged, not thrown here.
            if (activeOpen === null && pendingOpen) {
                const queued = pendingOpen;
                pendingOpen = null;
                try {
                    await open(queued.filePath, queued.config);
                } catch (err) {
                    console.error('[standalone-preview] queued open failed:', err);
                }
            }
        }
    }

    /** Show the file in the handed-over panel; see {@link StandalonePreview.openAdopted}. */
    async function openAdopted(config: Config): Promise<void> {
        latestConfig = config;
        lastConfig = config;
        if (!adopted || panel !== adopted.panel || activeOpen !== null) return;
        const target = adopted.panel;
        listenForDisposal(target);
        target.title = makePanelTitle(adopted.filePath);
        // Before the first HTML: the panel comes without scripts or resource roots.
        target.webview.options = { enableScripts: true, localResourceRoots: resolveLocalResourceRoots() };
        await showAdopted();
    }

    /** Apply updated configuration; triggers re-render if diagram keys changed, and
     *  applies a changed preview theme unless this panel picked its own. */
    function updateConfig(config: Config): void {
        // The open in progress (via latestConfig) and the queued one take it, panel or not.
        latestConfig = config;
        if (pendingOpen) pendingOpen = { ...pendingOpen, config };
        if (!panel) return;
        const prevConfig = lastConfig;
        lastConfig = config;
        if (!prevConfig) return;

        const reRender = def.shouldReRenderOnConfigChange?.(prevConfig, config) ?? false;
        if (!localPreviewTheme && prevConfig.previewTheme !== config.previewTheme) {
            if (def.onPreviewThemeChanged) {
                def.onPreviewThemeChanged(panel, getCurrentBgColor());
            } else {
                scheduleRender();
                return;
            }
        }
        if (reRender) scheduleRender();
    }

    /** Dispose the panel and release all resources. A Reading View leaves its panel to VS Code. */
    function dispose(): void {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (renderAbort) { renderAbort.abort(); renderAbort = null; }
        if (adopted) {
            if (panel) disposeState();
            return;
        }
        const disposing = panel;
        disposing?.dispose(); // triggers onDidDispose → disposeState()
        // No listener ran: the panel was already gone.
        if (panel === disposing) disposeState();
    }

    /** Show a theme QuickPick and apply the selected theme. */
    async function changeTheme(): Promise<void> {
        if (!panel) return;

        const currentPreviewTheme = getPreviewTheme();

        const items: (vscode.QuickPickItem & { category?: string; themeKey?: string })[] = [
            { label: vscode.l10n.t('Preview Theme (Follow VS Code Color Theme)'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems(VSCODE_THEME_KEYS, 'preview' as const, currentPreviewTheme),
            { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems(LIGHT_THEME_KEYS, 'preview' as const, currentPreviewTheme),
            { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
            ...buildThemeItems(DARK_THEME_KEYS, 'preview' as const, currentPreviewTheme),
        ];

        const diagramSection = await def.buildDiagramThemeItems?.();
        if (diagramSection) {
            items.push(
                { label: diagramSection.label, kind: vscode.QuickPickItemKind.Separator },
                ...diagramSection.items
            );
        }

        const selected = await showThemeQuickPick(items, vscode.l10n.t('Select theme'), 'preview', currentPreviewTheme);
        if (!panel || !selected || !('category' in selected)) return;

        const sel = selected as { category: string; themeKey: string };

        if (sel.category === 'preview') {
            // The setting may have switched the panel while the picker was open, so compare
            // against the theme shown now. Pin the pick even when it is already shown, so a
            // later setting change does not move it.
            const shownPreviewTheme = getPreviewTheme();
            localPreviewTheme = sel.themeKey;
            if (sel.themeKey === shownPreviewTheme) return;
            if (def.onPreviewThemeChanged) {
                def.onPreviewThemeChanged(panel, getCurrentBgColor());
            } else {
                await renderCurrentFile();
            }
        } else if (def.onDiagramThemeSelected) {
            const action = def.onDiagramThemeSelected(sel.themeKey, panel);
            if (action === 'render') {
                scheduleRender();
            }
        }
    }

    return {
        open, openAdopted, updateConfig, getCurrentFilePath: () => currentFilePath, getPanel: () => panel,
        getLastRenderedText: () => lastRenderedText, dispose, changeTheme,
    };
}

/**
 * Make the Reading View of a diagram file from a preview created on the handed-over
 * panel, and start its first render.
 *
 * @param kind - Kind of diagram file it shows.
 * @param view - The preview, created with `adopted`.
 * @param adopted - The panel and the file it shows.
 * @param config - Current extension configuration snapshot.
 * @returns The Reading View.
 */
export function createDiagramReadingView(
    kind: DiagramReadingView['kind'], view: StandalonePreview, adopted: AdoptedPanel, config: Config,
): DiagramReadingView {
    const firstRender = view.openAdopted(config);
    return {
        kind,
        filePath: () => adopted.filePath,
        panel: () => adopted.panel,
        firstRender,
        updateConfig: (c) => view.updateConfig(c),
        changeTheme: () => view.changeTheme(),
        getLastRenderedText: () => view.getLastRenderedText(),
        dispose: () => view.dispose(),
    };
}
