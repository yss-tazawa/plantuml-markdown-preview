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
import { createStandalonePreview, type StandalonePreview } from './standalone-preview.js';

// ---------------------------------------------------------------------------
// Mermaid-specific state
// ---------------------------------------------------------------------------

/** Extension URI for resolving mermaid.min.js path. */
let cachedExtensionUri: vscode.Uri | null = null;

/** Local Mermaid theme override, independent from VS Code settings. Reset on panel dispose. */
let localMermaidTheme: string | null = null;

/** Last known config for Mermaid-specific getters. */
let lastMermaidConfig: Config | null = null;

/** Return the effective Mermaid theme, falling back to config default. */
function getMermaidTheme(): string {
    return localMermaidTheme ?? (lastMermaidConfig ? lastMermaidConfig.mermaidTheme : 'default');
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
<textarea id="initial-source" style="display:none;">${escapedSource}</textarea>
<script nonce="${nonce}" src="${mermaidScriptUri}"></script>
<script nonce="${nonce}">
(function() {
    var vscodeApi = acquireVsCodeApi();
${getPanZoomScript()}
    // Mermaid rendering
    var renderCounter = 0;
    var isFirstRender = true;
    mermaid.initialize({ startOnLoad: false, theme: '${safeMermaidTheme}' });
    var lastSource = '';

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
            renderMermaid(e.data.source);
        } else if (e.data.type === 'updateBgColor') {
            if (e.data.bgColor && cssColorRe.test(e.data.bgColor.trim())) {
                var bg = e.data.bgColor.trim();
                container.style.background = bg;
                document.body.style.background = bg;
            }
        } else if (e.data.type === 'updateMermaidTheme') {
            mermaid.initialize({ startOnLoad: false, theme: e.data.theme });
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
 * @returns Webview-safe URI string, or empty string if unavailable.
 */
function getMermaidScriptUri(panel: vscode.WebviewPanel): string {
    if (!cachedExtensionUri) return '';
    const onDisk = vscode.Uri.joinPath(cachedExtensionUri, 'dist', 'mermaid.min.js');
    return panel.webview.asWebviewUri(onDisk).toString();
}

// ---------------------------------------------------------------------------
// Factory instance
// ---------------------------------------------------------------------------

const preview: StandalonePreview = createStandalonePreview({
    viewType: 'plantumlMermaidPreview',
    defaultTitle: 'Mermaid',
    localResourceRoots: () => cachedExtensionUri
        ? [vscode.Uri.joinPath(cachedExtensionUri, 'dist')]
        : [],

    buildHtml(content, nonce, bgColor, panel) {
        return generateMermaidViewerHtml(
            getMermaidScriptUri(panel), nonce, bgColor, getMermaidTheme(), content
        );
    },

    async updateWebview(panel, content, _bgColor, _signal) {
        void panel.webview.postMessage({ type: 'updateSource', source: content });
    },

    showError() {
        // Mermaid preview silently preserves previous state on missing files
    },

    onPreviewThemeChanged(panel, bgColor) {
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
        void panel.webview.postMessage({ type: 'updateMermaidTheme', theme: getMermaidTheme() });
        return 'done';
    },

    onPanelCreated(config) {
        lastMermaidConfig = config;
    },

    // Side-effect: updates lastMermaidConfig so theme/config reads stay current.
    shouldReRenderOnConfigChange(prev, next) {
        lastMermaidConfig = next;
        return !localMermaidTheme && prev.mermaidTheme !== next.mermaidTheme;
    },

    resetDiagramState() {
        localMermaidTheme = null;
        lastMermaidConfig = null;
    },
});

// ---------------------------------------------------------------------------
// Public API (thin wrappers preserving the existing call signatures)
// ---------------------------------------------------------------------------

/**
 * Open (or reveal) a standalone Mermaid file preview panel.
 *
 * @param filePath - Absolute path to the .mmd / .mermaid file.
 * @param config - Current extension configuration snapshot.
 * @param extensionUri - Extension root URI for resolving bundled assets.
 */
export async function openMermaidPreview(filePath: string, config: Config, extensionUri: vscode.Uri): Promise<void> {
    cachedExtensionUri = extensionUri;
    await preview.open(filePath, config);
}

/**
 * Update config reference. Called when settings change.
 *
 * @param config - New extension configuration snapshot.
 */
export function updateMermaidConfig(config: Config): void {
    lastMermaidConfig = config;
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
