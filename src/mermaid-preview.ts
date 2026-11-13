/**
 * @module mermaid-preview
 * @description Standalone Mermaid file preview with pan & zoom.
 *
 * Opens a WebviewPanel to preview .mmd / .mermaid files directly.
 * Mermaid rendering happens inside the webview via mermaid.js.
 */
import * as vscode from 'vscode';
import { MERMAID_THEME_KEYS, MERMAID_THEME_SET, type Config } from './config.js';
import { escapeHtml, CSS_COLOR_RE, buildThemeItems } from './utils.js';
import { getPanZoomScript } from './webview/pan-zoom-script.js';
import { createStandalonePreview, createDiagramReadingView, type StandalonePreview } from './standalone-preview.js';
import type { AdoptedPanel, ReadingView } from './reading-view.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/** Extension URI for resolving mermaid.min.js path. */
let cachedExtensionUri: vscode.Uri | null = null;

/** A Mermaid theme handed to the standalone Mermaid preview's webview. */
export interface MermaidThemePost {
    /** The previewed file when the theme was sent. */
    filePath: string | null;
    /** Mermaid theme name sent with `updateMermaidTheme`. */
    theme: string;
}

/** A diagram source handed to the standalone Mermaid preview's webview. */
export interface MermaidSourcePost {
    /** The previewed file. */
    filePath: string | null;
    /** Diagram source sent with `updateSource`. */
    source: string;
}

/** A Mermaid preview or Reading View with its Mermaid-specific state. */
export interface MermaidPreview extends StandalonePreview {
    /** The theme most recently posted to the webview (cleared with the panel). */
    getLastThemePost(): MermaidThemePost | null;
    /** The source most recently posted to the webview (cleared with the panel). */
    getLastSourcePost(): MermaidSourcePost | null;
}

/**
 * Set the extension URI that locates the bundled mermaid.min.js. Called once on
 * activation, before any preview or Reading View builds its page.
 *
 * @param extensionUri - Extension root URI.
 */
export function setMermaidExtensionUri(extensionUri: vscode.Uri): void {
    cachedExtensionUri = extensionUri;
}

// ---------------------------------------------------------------------------
// Webview HTML generation
// ---------------------------------------------------------------------------

/**
 * Generate the full HTML for the Mermaid viewer webview panel.
 *
 * @param mermaidScriptUri - Webview URI pointing to the bundled mermaid.min.js.
 * @param nonce - CSP nonce for inline scripts.
 * @param bgColor - Background color derived from the current preview theme.
 * @param mermaidTheme - Mermaid theme name (e.g. 'default', 'dark', 'forest').
 * @param initialSource - Mermaid diagram source to render on first load.
 * @returns Complete HTML string for the webview.
 */
function generateMermaidViewerHtml(
    mermaidScriptUri: string,
    nonce: string,
    bgColor: string,
    mermaidTheme: string,
    initialSource: string
): string {
    const containerBg = bgColor && CSS_COLOR_RE.test(bgColor.trim()) ? bgColor.trim() : '#fff';
    const safeMermaidTheme = MERMAID_THEME_SET.has(mermaidTheme) ? mermaidTheme : 'default';
    // The template writes this after a newline inside the <textarea>: the HTML parser
    // drops one leading newline there, so the source's own leading newline survives.
    const escapedSource = escapeHtml(initialSource);
    const labels = {
        fit: escapeHtml(vscode.l10n.t('Fit')),
        fitTitle: escapeHtml(vscode.l10n.t('Fit to Window')),
        actualSize: escapeHtml(vscode.l10n.t('Actual Size')),
        actualSizeTitle: escapeHtml(vscode.l10n.t('Actual Size (1:1)')),
        zoomIn: escapeHtml(vscode.l10n.t('Zoom In')),
        zoomOut: escapeHtml(vscode.l10n.t('Zoom Out')),
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${containerBg}; }
#toolbar {
    position: fixed; top: 0; left: 0; right: 0; height: 36px;
    display: flex; align-items: center; gap: 4px; padding: 0 8px;
    background: var(--vscode-titleBar-activeBackground, #3c3c3c);
    color: var(--vscode-titleBar-activeForeground, #ccc);
    border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
    z-index: 100; user-select: none;
}
#toolbar button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-contrastBorder, rgba(255,255,255,0.1)); border-radius: 4px;
    height: 24px; padding: 0 8px;
    font-size: 12px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
}
#toolbar button:hover {
    background: var(--vscode-button-secondaryHoverBackground, #505050);
}
#zoom-label {
    color: var(--vscode-titleBar-activeForeground, #ccc);
    font-size: 12px; min-width: 44px; text-align: center;
    font-family: var(--vscode-editor-font-family, monospace);
}
#viewport {
    position: absolute; top: 36px; left: 0; right: 0; bottom: 0;
    overflow: hidden; cursor: grab;
}
#viewport.dragging { cursor: grabbing; }
#svg-container {
    transform-origin: 0 0;
    display: inline-block;
    position: absolute; left: 0; top: 0;
    background: ${containerBg};
}
#render-error {
    color: #d32f2f; padding: 1em; white-space: pre-wrap; font-size: 0.9em;
    font-family: var(--vscode-editor-font-family, monospace);
}
</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="toolbar">
    <button id="btn-fit" title="${labels.fitTitle}">${labels.fit}</button>
    <button id="btn-100" title="${labels.actualSizeTitle}">${labels.actualSize}</button>
    <button id="btn-zoom-out" title="${labels.zoomOut}">&minus;</button>
    <span id="zoom-label">100%</span>
    <button id="btn-zoom-in" title="${labels.zoomIn}">+</button>
</div>
<div id="viewport">
    <div id="svg-container"></div>
</div>
<textarea id="initial-source" style="display:none;">\n${escapedSource}</textarea>
<script nonce="${nonce}" src="${mermaidScriptUri}"></script>
<script nonce="${nonce}">
(function() {
    var vscodeApi = acquireVsCodeApi();
${getPanZoomScript()}
    // Mermaid rendering
    var renderCounter = 0;
    var isFirstRender = true;
    var currentTheme = '${safeMermaidTheme}';
    mermaid.initialize({ startOnLoad: false, theme: '${safeMermaidTheme}' });
    // Source of the latest render; null until the page renders anything.
    var lastSource = null;

    // The HTML parser turns CRLF and CR into LF in the initial source, so compare
    // sources by content regardless of line endings.
    function sameSource(a, b) {
        return a !== null && b !== null && a.replace(/\\r\\n?/g, '\\n') === b.replace(/\\r\\n?/g, '\\n');
    }

    function removeMermaidTempElements() {
        // mermaid.render() appends temp divs (id="d" + renderId) to document.body
        // and does NOT remove them when an error is thrown.
        document.querySelectorAll('body > [id^="dmermaid-svg-"]').forEach(function(el) { el.remove(); });
    }

    async function renderMermaid(source) {
        lastSource = source;
        var id = 'mermaid-svg-' + (renderCounter++);
        try {
            var result = await mermaid.render(id, source);
            container.innerHTML = result.svg;
            // Strip Mermaid's size constraints so pan & zoom works on natural viewBox size
            var svg = container.querySelector('svg');
            if (svg) {
                svg.style.maxWidth = 'none';
                var vb = svg.getAttribute('viewBox');
                if (vb) {
                    var p = vb.split(/[\\s,]+/);
                    if (p.length === 4) {
                        svg.setAttribute('width', p[2]);
                        svg.setAttribute('height', p[3]);
                    }
                }
            }
            if (isFirstRender) {
                isFirstRender = false;
                fitToWindow();
            } else {
                applyTransform();
            }
        } catch (err) {
            var errorDiv = document.createElement('div');
            errorDiv.id = 'render-error';
            errorDiv.textContent = err.message || String(err);
            container.innerHTML = '';
            container.appendChild(errorDiv);
        }
        removeMermaidTempElements();
    }

    // Message handler
    window.addEventListener('message', function(e) {
        if (e.data.type === 'updateSource') {
            // Each page load is sent the current source, usually the one already rendered.
            if (sameSource(e.data.source, lastSource)) return;
            renderMermaid(e.data.source);
        } else if (e.data.type === 'updateBgColor') {
            if (e.data.bgColor && cssColorRe.test(e.data.bgColor.trim())) {
                var bg = e.data.bgColor.trim();
                container.style.background = bg;
                document.body.style.background = bg;
            }
        } else if (e.data.type === 'updateMermaidTheme') {
            // Each page load is sent the current theme, usually the one already shown.
            if (e.data.theme === currentTheme) return;
            currentTheme = e.data.theme;
            mermaid.initialize({ startOnLoad: false, theme: currentTheme });
            if (lastSource) renderMermaid(lastSource);
        } else if (e.data.type === 'exportDiagram') {
            handleDiagramAction('save', e.data.format);
        } else if (e.data.type === 'copyDiagram') {
            handleDiagramAction('copy', e.data.format);
        }
    });

    // Render initial source
    var initialEl = document.getElementById('initial-source');
    if (initialEl && initialEl.textContent) {
        renderMermaid(initialEl.textContent).catch(function(err) {
            console.error('Mermaid initial render failed:', err);
        });
    }

    // Report each page load; a webview recreated from this HTML gets the current state.
    vscodeApi.postMessage({ type: 'webviewReady' });
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the webview URI for the bundled mermaid.min.js script.
 *
 * @param panel - The WebviewPanel used to convert on-disk URIs.
 * @returns Webview-safe URI string.
 * @throws When {@link setMermaidExtensionUri} has not run.
 */
function getMermaidScriptUri(panel: vscode.WebviewPanel): string {
    if (!cachedExtensionUri) throw new Error('The location of mermaid.min.js is not set');
    const onDisk = vscode.Uri.joinPath(cachedExtensionUri, 'dist', 'mermaid.min.js');
    return panel.webview.asWebviewUri(onDisk).toString();
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Create a Mermaid preview, or a Reading View when given a panel, with its own theme
 * override and config.
 *
 * @param initialConfig - Configuration to render with until a newer one arrives.
 * @param adopted - Panel handed over by VS Code and the file it shows (Reading View).
 * @returns The preview or Reading View.
 */
function createMermaidPreview(initialConfig: Config | null, adopted?: AdoptedPanel): MermaidPreview {
    /** Local Mermaid theme override, independent from VS Code settings. Reset on panel dispose. */
    let localMermaidTheme: string | null = null;
    /** Last known config for Mermaid-specific getters. */
    let lastMermaidConfig: Config | null = initialConfig;
    /** Mermaid theme the webview currently renders with; null while it has no HTML. */
    let webviewMermaidTheme: string | null = null;
    let lastThemePost: MermaidThemePost | null = null;
    let lastSourcePost: MermaidSourcePost | null = null;

    /**
     * Post a theme to the webview, remembering it for the test hooks.
     *
     * @param panel - Panel whose webview receives the theme.
     * @param theme - Mermaid theme name.
     */
    function postTheme(panel: vscode.WebviewPanel, theme: string): void {
        lastThemePost = { filePath: base.getCurrentFilePath(), theme };
        void panel.webview.postMessage({ type: 'updateMermaidTheme', theme });
    }

    /** Return the effective Mermaid theme, falling back to 'default' for unknown names. */
    function getMermaidTheme(): string {
        const theme = localMermaidTheme ?? lastMermaidConfig?.mermaidTheme ?? 'default';
        return MERMAID_THEME_SET.has(theme) ? theme : 'default';
    }

    /**
     * Send the effective Mermaid theme to the webview if it renders with another one.
     * The webview re-renders its current source with the new theme.
     *
     * @param panel - Panel whose webview receives the theme.
     */
    function syncWebviewTheme(panel: vscode.WebviewPanel): void {
        const theme = getMermaidTheme();
        if (webviewMermaidTheme === null || theme === webviewMermaidTheme) return;
        webviewMermaidTheme = theme;
        postTheme(panel, theme);
    }

    const base: StandalonePreview = createStandalonePreview({
        viewType: 'plantumlMermaidPreview',
        defaultTitle: 'Mermaid',
        localResourceRoots: () => cachedExtensionUri
            ? [vscode.Uri.joinPath(cachedExtensionUri, 'dist')]
            : [],

        // Side-effect: records the theme of the new webview in webviewMermaidTheme.
        buildHtml(content, nonce, bgColor, panel) {
            const scriptUri = getMermaidScriptUri(panel);
            webviewMermaidTheme = getMermaidTheme();
            return generateMermaidViewerHtml(scriptUri, nonce, bgColor, webviewMermaidTheme, content);
        },

        async updateWebview(panel, content, _bgColor, _signal) {
            // An open with another config while the panel exists may have changed the theme.
            syncWebviewTheme(panel);
            lastSourcePost = { filePath: base.getCurrentFilePath(), source: content };
            void panel.webview.postMessage({ type: 'updateSource', source: content });
        },

        showError() {
            // Mermaid preview silently preserves previous state on missing files;
            // the HTML is not replaced.
            return false;
        },

        onPreviewThemeChanged(panel, bgColor) {
            void panel.webview.postMessage({ type: 'updateBgColor', bgColor });
        },

        onWebviewReady(panel, bgColor) {
            // The page shows the theme and background of its HTML; send the current ones.
            webviewMermaidTheme = getMermaidTheme();
            postTheme(panel, webviewMermaidTheme);
            void panel.webview.postMessage({ type: 'updateBgColor', bgColor });
        },

        buildDiagramThemeItems() {
            return {
                label: vscode.l10n.t('Mermaid Theme'),
                items: buildThemeItems(MERMAID_THEME_KEYS, 'mermaid' as const, getMermaidTheme()),
            };
        },

        onDiagramThemeSelected(themeKey, panel) {
            if (themeKey === getMermaidTheme()) return 'done';
            localMermaidTheme = themeKey;
            syncWebviewTheme(panel);
            return 'done';
        },

        resetDiagramState() {
            localMermaidTheme = null;
            webviewMermaidTheme = null;
            lastThemePost = null;
            lastSourcePost = null;
        },
    }, adopted);

    return {
        ...base,
        open(filePath, config) {
            lastMermaidConfig = config;
            return base.open(filePath, config);
        },
        openAdopted(config) {
            lastMermaidConfig = config;
            return base.openAdopted(config);
        },
        // An open panel takes a changed mermaidTheme unless a theme was picked in the panel.
        updateConfig(config) {
            lastMermaidConfig = config;
            base.updateConfig(config);
            const panel = base.getPanel();
            if (panel) syncWebviewTheme(panel);
        },
        getLastThemePost: () => lastThemePost,
        getLastSourcePost: () => lastSourcePost,
    };
}

/** The Mermaid preview (beside the source, following the active editor). */
const preview: MermaidPreview = createMermaidPreview(null);

/**
 * Create a Reading View of a .mmd file in a panel VS Code handed over, and start its
 * first render.
 *
 * @param adopted - The panel and the file it shows.
 * @param config - Current extension configuration snapshot.
 * @returns The Reading View.
 */
export function createMermaidReadingView(adopted: AdoptedPanel, config: Config): ReadingView {
    return createDiagramReadingView('mermaid', createMermaidPreview(config, adopted), adopted, config);
}

// ---------------------------------------------------------------------------
// Public API (thin wrappers preserving the existing call signatures)
// ---------------------------------------------------------------------------

/**
 * Open (or reveal) a standalone Mermaid file preview panel.
 *
 * @param filePath - Absolute path to the .mmd / .mermaid file.
 * @param config - Current extension configuration snapshot.
 */
export async function openMermaidPreview(filePath: string, config: Config): Promise<void> {
    await preview.open(filePath, config);
}

/**
 * Update config reference. Called when settings change.
 * An open panel takes a changed mermaidTheme unless a theme was picked in the panel.
 *
 * @param config - New extension configuration snapshot.
 */
export function updateMermaidConfig(config: Config): void {
    preview.updateConfig(config);
}

/**
 * Get the currently previewed .mmd / .mermaid file path.
 *
 * @returns Absolute file path, or null if no preview is open.
 */
export function getCurrentMermaidFilePath(): string | null {
    return preview.getCurrentFilePath();
}

/**
 * Get the preview panel (for save commands).
 *
 * @returns The active WebviewPanel, or null if no preview is open.
 */
export function getMermaidPreviewPanel(): vscode.WebviewPanel | null {
    return preview.getPanel();
}

/**
 * Get the theme most recently posted to the preview webview (for test hooks).
 *
 * @returns The previewed file and the theme, or null when none was posted.
 */
export function getLastMermaidThemePost(): MermaidThemePost | null {
    return preview.getLastThemePost();
}

/**
 * Get the source most recently posted to the preview webview (for test hooks).
 *
 * @returns The previewed file and the source, or null when none was posted.
 */
export function getLastMermaidSourcePost(): MermaidSourcePost | null {
    return preview.getLastSourcePost();
}

/** Dispose the preview panel and clean up all associated resources. */
export function disposeMermaidPreview(): void {
    preview.dispose();
}

/**
 * Show a theme QuickPick for the Mermaid preview.
 * Theme selection is local to this preview and does not affect settings.
 */
export async function changeMermaidTheme(): Promise<void> {
    await preview.changeTheme();
}
