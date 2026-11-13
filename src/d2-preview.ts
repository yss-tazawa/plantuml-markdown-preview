/**
 * @module d2-preview
 * @description Standalone D2 file preview with pan & zoom.
 *
 * Opens a WebviewPanel to preview .d2 files directly,
 * without requiring a Markdown wrapper. Reuses the Diagram Viewer HTML
 * (pan & zoom) and renders via the D2 Wasm renderer.
 */
import * as vscode from 'vscode';
import { generateViewerHtml } from './diagram-viewer.js';
import { renderD2ToSvg } from './d2-renderer.js';
import { D2_THEME_KEYS, D2_THEME_MAP, type Config } from './config.js';
import { errorHtml, buildThemeItems } from './utils.js';
import { createStandalonePreview, createDiagramReadingView, type StandalonePreview } from './standalone-preview.js';
import type { AdoptedPanel, ReadingView } from './reading-view.js';

/** A render handed to the standalone D2 preview's webview. */
export interface D2Render {
    /** The previewed file. */
    filePath: string;
    /** SVG markup, or error HTML when the render failed. */
    svg: string;
    /** Background color sent with the render. */
    bgColor: string;
}

/** A D2 preview or Reading View with its D2-specific state. */
export interface D2Preview extends StandalonePreview {
    /** The render most recently handed to the webview (cleared with the panel). */
    getLastRender(): D2Render | null;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Create a D2 preview, or a Reading View when given a panel, with its own theme and
 * layout overrides and config.
 *
 * @param initialConfig - Configuration to render with until a newer one arrives.
 * @param adopted - Panel handed over by VS Code and the file it shows (Reading View).
 * @returns The preview or Reading View.
 */
function createD2Preview(initialConfig: Config | null, adopted?: AdoptedPanel): D2Preview {
    /** Local D2 theme (not synced to settings). */
    let localD2Theme: string | null = null;
    /** Local D2 layout (not synced to settings). */
    let localD2Layout: string | null = null;
    /** Last known config for D2-specific getters. */
    let lastD2Config: Config | null = initialConfig;
    let lastRender: D2Render | null = null;

    /**
     * Remember a render that is about to reach the webview.
     *
     * @param svg - SVG markup or error HTML of the render.
     * @param bgColor - Background color sent with it.
     */
    function recordRender(svg: string, bgColor: string): void {
        const filePath = base.getCurrentFilePath();
        lastRender = filePath ? { filePath, svg, bgColor } : null;
    }

    /** Return the effective D2 theme, falling back to config default. */
    function getD2Theme(): string {
        return localD2Theme ?? (lastD2Config ? lastD2Config.d2Theme : 'Neutral Default');
    }

    /** Return the effective D2 layout engine, falling back to config default. */
    function getD2Layout(): string {
        return localD2Layout ?? (lastD2Config ? lastD2Config.d2Layout : 'dagre');
    }

    /**
     * Render D2 content to SVG.
     *
     * @param content - D2 diagram source text.
     * @returns SVG markup string, or error HTML on failure.
     */
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

    const base: StandalonePreview = createStandalonePreview({
        viewType: 'plantumlD2Preview',
        defaultTitle: 'D2',

        async buildHtml(content, nonce, bgColor, panel) {
            const svg = await renderSvg(content);
            // Once this panel is closed, the current file may already belong to a newer panel.
            if (base.getPanel() === panel) recordRender(svg, bgColor);
            return generateViewerHtml(svg, nonce, bgColor);
        },

        async updateWebview(panel, content, bgColor, signal) {
            if (signal?.aborted) return;
            const svg = await renderSvg(content);
            if (signal?.aborted) return;
            recordRender(svg, bgColor);
            void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
        },

        showError(panel, message, nonce) {
            panel.webview.html = generateViewerHtml(errorHtml(message), nonce);
            return true;
        },

        buildDiagramThemeItems() {
            return {
                label: vscode.l10n.t('D2 Theme'),
                items: buildThemeItems([...D2_THEME_KEYS], 'd2' as const, getD2Theme()),
            };
        },

        onDiagramThemeSelected(themeKey) {
            if (themeKey === getD2Theme()) return 'done';
            localD2Theme = themeKey;
            return 'render';
        },

        // Side-effect: updates lastD2Config so theme/layout reads stay current.
        shouldReRenderOnConfigChange(prev, next) {
            lastD2Config = next;
            return (!localD2Theme && prev.d2Theme !== next.d2Theme)
                || (!localD2Layout && prev.d2Layout !== next.d2Layout);
        },

        resetDiagramState() {
            localD2Theme = null;
            localD2Layout = null;
            lastRender = null;
        },
    }, adopted);

    return {
        ...base,
        open(filePath, config) {
            lastD2Config = config;
            return base.open(filePath, config);
        },
        openAdopted(config) {
            lastD2Config = config;
            return base.openAdopted(config);
        },
        updateConfig(config) {
            lastD2Config = config;
            base.updateConfig(config);
        },
        getLastRender: () => lastRender,
    };
}

/** The D2 preview (beside the source, following the active editor). */
const preview: D2Preview = createD2Preview(null);

/**
 * Create a Reading View of a .d2 file in a panel VS Code handed over, and start its
 * first render.
 *
 * @param adopted - The panel and the file it shows.
 * @param config - Current extension configuration snapshot.
 * @returns The Reading View.
 */
export function createD2ReadingView(adopted: AdoptedPanel, config: Config): ReadingView {
    return createDiagramReadingView('d2', createD2Preview(config, adopted), adopted, config);
}

// ---------------------------------------------------------------------------
// Public API (thin wrappers preserving the existing call signatures)
// ---------------------------------------------------------------------------

/**
 * Open (or reveal) a preview panel for the given .d2 file.
 *
 * @param filePath - Absolute path to the .d2 file to preview.
 * @param config - Current extension configuration snapshot.
 */
export async function openD2Preview(filePath: string, config: Config): Promise<void> {
    await preview.open(filePath, config);
}

/**
 * Update config reference. Called when settings change.
 *
 * @param config - New extension configuration snapshot.
 */
export function updateD2Config(config: Config): void {
    preview.updateConfig(config);
}

/**
 * Get the currently previewed .d2 file path.
 *
 * @returns Absolute file path, or null if no preview is open.
 */
export function getCurrentD2FilePath(): string | null {
    return preview.getCurrentFilePath();
}

/**
 * Get the preview panel (for save commands).
 *
 * @returns The active WebviewPanel, or null if no preview is open.
 */
export function getD2PreviewPanel(): vscode.WebviewPanel | null {
    return preview.getPanel();
}

/**
 * Get the render most recently handed to the preview webview (for test hooks).
 *
 * @returns The previewed file, the SVG markup (or error HTML) and its background, or null when none.
 */
export function getLastD2Render(): D2Render | null {
    return preview.getLastRender();
}

/** Dispose the preview panel and clean up. */
export function disposeD2Preview(): void {
    preview.dispose();
}

/**
 * Show a theme QuickPick for the .d2 preview.
 * Theme selection is local to this preview and does not affect settings.
 */
export async function changeD2Theme(): Promise<void> {
    await preview.changeTheme();
}
