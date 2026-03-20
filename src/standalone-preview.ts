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
import { LIGHT_THEME_KEYS, DARK_THEME_KEYS, getThemeBgColor } from './exporter.js';
import { getNonce, buildThemeItems, readSource } from './utils.js';
import { handleViewerMessage } from './export-handler.js';

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
     */
    showError(panel: vscode.WebviewPanel, message: string, nonce: string): void;

    /**
     * Handle a preview-theme change.
     *
     * If not provided the factory calls {@link renderCurrentFile} (re-renders
     * the diagram with the new background).  Mermaid overrides this to send a
     * lightweight `updateBgColor` message instead.
     */
    onPreviewThemeChanged?(panel: vscode.WebviewPanel, bgColor: string): void;

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
     * Only called when no local diagram-theme override is active.
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
    updateConfig(config: Config): void;
    getCurrentFilePath(): string | null;
    getPanel(): vscode.WebviewPanel | null;
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
 */
export function createStandalonePreview(def: StandalonePreviewDef): StandalonePreview {
    // -- shared state --------------------------------------------------------
    let panel: vscode.WebviewPanel | null = null;
    let currentFilePath: string | null = null;
    let lastConfig: Config | null = null;
    let localPreviewTheme: string | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const panelDisposables: vscode.Disposable[] = [];
    let renderSeq = 0;
    let renderAbort: AbortController | null = null;
    /** Guard against double panel creation during async readSource. */
    let isOpening = false;
    /** File path queued while isOpening is true; processed after current open() finishes. */
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

    /** Build a panel title from the file name (e.g. "foo.puml (Preview)"). */
    function makePanelTitle(filePath: string): string {
        const name = filePath.split(/[/\\]/).pop() ?? def.defaultTitle;
        return `${name} ${vscode.l10n.t('(Preview)')}`;
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
        if (content === null) {
            def.showError(panel, vscode.l10n.t('File not found: {0}', currentFilePath), getNonce());
            renderAbort = null;
            return;
        }

        if (signal.aborted || seq !== renderSeq) { renderAbort = null; return; }

        try {
            await def.updateWebview(panel, content, getCurrentBgColor(), signal);
            if (signal.aborted || seq !== renderSeq) return;
            updateIncludePaths(content);
        } finally {
            if (renderAbort?.signal === signal) renderAbort = null;
        }
    }

    /** Clean up all panel state and disposables. */
    function disposeState(): void {
        isOpening = false;
        panel = null;
        currentFilePath = null;
        lastConfig = null;
        localPreviewTheme = null;
        includePaths = new Set<string>();
        def.resetDiagramState();
        for (const d of panelDisposables) d.dispose();
        panelDisposables.length = 0;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (renderAbort) { renderAbort.abort(); renderAbort = null; }
    }

    // -- public API ----------------------------------------------------------

    /** Open (or reveal) the standalone preview panel for the given diagram file. */
    async function open(filePath: string, config: Config): Promise<void> {
        // Guard against double panel creation if open() is called again during await.
        // Check before updating state to avoid overwriting currentFilePath/lastConfig
        // while a previous open() is still in progress.
        if (isOpening) { pendingOpen = { filePath, config }; return; }

        lastConfig = config;
        currentFilePath = filePath;

        if (panel) {
            panel.reveal(vscode.ViewColumn.Two, true);
            panel.title = makePanelTitle(filePath);
            isOpening = true;
            try { await renderCurrentFile(); } finally { isOpening = false; }
            return;
        }
        isOpening = true;

        let content: string | null;
        try {
            content = await readSource(filePath);
        } catch {
            isOpening = false;
            return;
        }
        if (content === null) { currentFilePath = null; isOpening = false; return; }

        // Re-check after await: another open() call may have created the panel.
        // TypeScript narrows panel to null after the earlier if-return — cast to
        // break the narrowing since the module-level variable may have changed.
        const existingPanel = panel as vscode.WebviewPanel | null;
        if (existingPanel) {
            existingPanel.reveal(vscode.ViewColumn.Two, true);
            existingPanel.title = makePanelTitle(filePath);
            try { await renderCurrentFile(); } finally { isOpening = false; }
            return;
        }

        panel = vscode.window.createWebviewPanel(
            def.viewType,
            makePanelTitle(filePath),
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: vscode.workspace.getConfiguration(CONFIG_SECTION)
                    .get<boolean>('retainPreviewContext', true),
                localResourceRoots: typeof def.localResourceRoots === 'function'
                    ? def.localResourceRoots()
                    : def.localResourceRoots ?? [],
            }
        );

        try {
            panel.webview.html = await def.buildHtml(content, getNonce(), getCurrentBgColor(), panel);
        } catch (err) {
            panel.dispose();
            panel = null;
            currentFilePath = null;
            lastConfig = null;
            isOpening = false;
            // Process any file queued while we were opening.
            if (pendingOpen) {
                const queued = pendingOpen;
                pendingOpen = null;
                await open(queued.filePath, queued.config);
            }
            return;
        }

        panelDisposables.push(panel.onDidDispose(disposeState));

        panelDisposables.push(panel.webview.onDidReceiveMessage((msg) => {
            void handleViewerMessage(msg, currentFilePath);
        }));

        panelDisposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (!currentFilePath || e.document.uri.fsPath !== currentFilePath) return;
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

        def.onPanelCreated?.(config);
        isOpening = false;

        // If another file was requested while we were opening, process it now.
        if (pendingOpen) {
            const queued = pendingOpen;
            pendingOpen = null;
            await open(queued.filePath, queued.config);
        }
    }

    /** Apply updated configuration; triggers re-render if diagram keys changed. */
    function updateConfig(config: Config): void {
        const prevConfig = lastConfig;
        lastConfig = config;
        if (!panel || !prevConfig) return;

        if (def.shouldReRenderOnConfigChange?.(prevConfig, config)) {
            scheduleRender();
        }
    }

    /** Dispose the panel and release all resources. */
    function dispose(): void {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (renderAbort) { renderAbort.abort(); renderAbort = null; }
        if (panel) {
            panel.dispose(); // triggers onDidDispose → disposeState()
        } else {
            disposeState(); // safety net if panel was already gone
        }
    }

    /** Show a theme QuickPick and apply the selected theme. */
    async function changeTheme(): Promise<void> {
        if (!panel) return;

        const currentPreviewTheme = getPreviewTheme();

        const items: (vscode.QuickPickItem & { category?: string; themeKey?: string })[] = [
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

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Select theme')
        });
        if (!panel || !selected || !('category' in selected)) return;

        const sel = selected as { category: string; themeKey: string };

        if (sel.category === 'preview') {
            if (sel.themeKey === currentPreviewTheme) return;
            localPreviewTheme = sel.themeKey;
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

    return { open, updateConfig, getCurrentFilePath: () => currentFilePath, getPanel: () => panel, dispose, changeTheme };
}
