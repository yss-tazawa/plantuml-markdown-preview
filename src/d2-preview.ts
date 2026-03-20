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
import { createStandalonePreview, type StandalonePreview } from './standalone-preview.js';

// ---------------------------------------------------------------------------
// D2-specific state (managed outside the factory)
// ---------------------------------------------------------------------------

/** Local D2 theme (not synced to settings). */
let localD2Theme: string | null = null;

/** Local D2 layout (not synced to settings). */
let localD2Layout: string | null = null;

/** Last known config for D2-specific getters. */
let lastD2Config: Config | null = null;

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

// ---------------------------------------------------------------------------
// Factory instance
// ---------------------------------------------------------------------------

const preview: StandalonePreview = createStandalonePreview({
    viewType: 'plantumlD2Preview',
    defaultTitle: 'D2',

    async buildHtml(content, nonce, bgColor) {
        const svg = await renderSvg(content);
        return generateViewerHtml(svg, nonce, bgColor);
    },

    async updateWebview(panel, content, bgColor, signal) {
        if (signal?.aborted) return;
        const svg = await renderSvg(content);
        if (signal?.aborted) return;
        void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
    },

    showError(panel, message, nonce) {
        panel.webview.html = generateViewerHtml(errorHtml(message), nonce);
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
    },
});

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
    lastD2Config = config;
    await preview.open(filePath, config);
}

/**
 * Update config reference. Called when settings change.
 *
 * @param config - New extension configuration snapshot.
 */
export function updateD2Config(config: Config): void {
    lastD2Config = config;
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
