/**
 * @module puml-preview
 * @description Standalone PlantUML file preview with pan & zoom.
 *
 * Opens a WebviewPanel to preview .puml / .plantuml files directly,
 * without requiring a Markdown wrapper. Reuses the Diagram Viewer HTML
 * (pan & zoom) and renders via renderToSvgAsync / renderToSvgServer.
 */
import * as vscode from 'vscode';
import { generateViewerHtml } from './diagram-viewer.js';
import { renderToSvgAsync, listThemesAsync, prefetchThemes, extractIncludePaths, resolveIncludePath, clearCache } from './plantuml.js';
import { renderToSvgServer, clearServerCache } from './plantuml-server.js';
import { getLocalServerUrl, waitForLocalServer } from './local-server.js';
import { type Config } from './config.js';
import { errorHtml, buildThemeItems } from './utils.js';
import { createStandalonePreview, type StandalonePreview } from './standalone-preview.js';

// ---------------------------------------------------------------------------
// PlantUML-specific state
// ---------------------------------------------------------------------------

/** Local PlantUML theme (not synced to settings). */
let localPlantumlTheme: string | null = null;

/** Last known config for PlantUML-specific rendering. */
let lastPumlConfig: Config | null = null;

/** Return the effective PlantUML theme, falling back to config default. */
function getPlantumlTheme(): string {
    return localPlantumlTheme ?? (lastPumlConfig ? lastPumlConfig.plantumlTheme : 'default');
}

/** Build a config snapshot with local PlantUML theme override applied. */
function getEffectiveConfig(): Config | null {
    if (!lastPumlConfig) return null;
    return localPlantumlTheme
        ? { ...lastPumlConfig, plantumlTheme: localPlantumlTheme }
        : lastPumlConfig;
}

/**
 * Render PlantUML content to SVG using the appropriate mode.
 *
 * @param content - PlantUML diagram source text.
 * @param config - Extension configuration (rendering mode, server URL, etc.).
 * @param signal - Optional AbortSignal to cancel the render.
 * @returns SVG markup string, or error HTML on failure.
 */
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

// ---------------------------------------------------------------------------
// Factory instance
// ---------------------------------------------------------------------------

const preview: StandalonePreview = createStandalonePreview({
    viewType: 'plantumlPumlPreview',
    defaultTitle: 'PlantUML',

    async buildHtml(content, nonce, bgColor) {
        const config = getEffectiveConfig();
        if (!config) return '';
        const svg = await renderSvg(content, config);
        return generateViewerHtml(svg, nonce, bgColor);
    },

    async updateWebview(panel, content, bgColor, signal) {
        const config = getEffectiveConfig();
        if (!config) return;
        const svg = await renderSvg(content, config, signal);
        if (signal?.aborted) return;
        void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
    },

    showError(panel, message, nonce) {
        panel.webview.html = generateViewerHtml(errorHtml(message), nonce);
    },

    async buildDiagramThemeItems() {
        const plantumlThemes = await listThemesAsync(lastPumlConfig || { plantumlJarPath: '', javaPath: 'java' });
        return {
            label: vscode.l10n.t('PlantUML Theme'),
            items: buildThemeItems(['default', ...plantumlThemes], 'plantuml' as const, getPlantumlTheme()),
        };
    },

    onDiagramThemeSelected(themeKey) {
        if (themeKey === getPlantumlTheme()) return 'done';
        localPlantumlTheme = themeKey;
        return 'render';
    },

    // Side-effect: updates lastPumlConfig so theme/config reads stay current.
    shouldReRenderOnConfigChange(prev, next) {
        lastPumlConfig = next;
        return !localPlantumlTheme && prev.plantumlTheme !== next.plantumlTheme;
    },

    onPanelCreated(config) {
        // Pre-fetch PlantUML theme list so the QuickPick menu is instant
        if (config.renderMode !== 'server') {
            prefetchThemes(config);
        }
    },

    collectIncludePaths(content, config) {
        const basePath = resolveIncludePath(config);
        if (!basePath) return new Set<string>();
        return new Set(extractIncludePaths(content, basePath));
    },

    onIncludeFileSaved() {
        clearCache();
        clearServerCache();
    },

    resetDiagramState() {
        localPlantumlTheme = null;
    },
});

// ---------------------------------------------------------------------------
// Public API (thin wrappers preserving the existing call signatures)
// ---------------------------------------------------------------------------

/**
 * Open (or reveal) a preview panel for the given .puml file.
 *
 * @param filePath - Absolute path to the .puml / .plantuml file.
 * @param config - Current extension configuration snapshot.
 */
export async function openPumlPreview(filePath: string, config: Config): Promise<void> {
    lastPumlConfig = config;
    await preview.open(filePath, config);
}

/**
 * Update config reference. Called when settings change.
 *
 * @param config - The new extension configuration.
 */
export function updatePumlConfig(config: Config): void {
    lastPumlConfig = config;
    preview.updateConfig(config);
}

/**
 * Get the currently previewed .puml file path.
 *
 * @returns Absolute file path, or null if no preview is open.
 */
export function getCurrentPumlFilePath(): string | null {
    return preview.getCurrentFilePath();
}

/**
 * Get the preview panel (for save commands).
 *
 * @returns The active WebviewPanel, or null if no preview is open.
 */
export function getPumlPreviewPanel(): vscode.WebviewPanel | null {
    return preview.getPanel();
}

/** Dispose the preview panel and clean up. */
export function disposePumlPreview(): void {
    preview.dispose();
}

/**
 * Show a theme QuickPick for the .puml preview (no Mermaid section).
 * Theme selection is local to this preview and does not affect other previews.
 */
export async function changePumlTheme(): Promise<void> {
    await preview.changeTheme();
}
