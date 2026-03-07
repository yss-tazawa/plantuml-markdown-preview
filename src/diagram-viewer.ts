/**
 * @module diagram-viewer
 * @description Diagram Viewer panel with pan & zoom.
 *
 * Opens a separate WebviewPanel to display a diagram from the markdown preview
 * with interactive pan & zoom controls. Receives live SVG updates when the
 * editor content changes.
 */
import * as vscode from 'vscode';
import { writeFile } from 'fs/promises';
import { getNonce, escapeHtml } from './utils.js';

/**
 * Validate that a string looks like a CSS color value (rgb/rgba/hex/named).
 * Used to sanitize user-supplied bgColor before injecting into HTML templates,
 * preventing XSS via malicious CSS values.
 *
 * NOTE: This regex is duplicated as a string literal in the webview script
 * inside {@link getDiagramViewerHtml} (search for `cssColorRe`). Keep both in sync.
 */
const CSS_COLOR_RE = /^(#[\da-fA-F]{3,8}|rgba?\(\s*[\d.%,\s/]+\)|transparent|inherit|currentColor|[\w-]+)$/;

/** Active viewer panels keyed by 1-based diagram index. */
const viewers = new Map<number, vscode.WebviewPanel>();

/** Index of the most recently focused viewer panel. */
let activeViewerIndex = -1;

/** Pending diagram data from a preview right-click (for Save as PNG/SVG). */
let pendingSave: { svg: string; diagramIndex: number } | null = null;

/**
 * Open (or reveal) a diagram viewer panel for the given diagram index.
 *
 * If a viewer for the same index already exists, it is revealed.
 * Otherwise a new WebviewPanel is created.
 *
 * @param svg - innerHTML of the .plantuml-diagram element
 * @param diagramIndex - 1-based position of the diagram in the document
 * @param bgColor - CSS background color from the markdown preview theme
 */
export function openDiagramViewer(svg: string, diagramIndex: number, bgColor?: string): void {
    const existing = viewers.get(diagramIndex);
    if (existing) {
        void existing.webview.postMessage({ type: 'updateSvg', svg, bgColor });
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'plantumlDiagramViewer',
        vscode.l10n.t('Diagram {0} (Viewer)', diagramIndex),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [] }
    );

    viewers.set(diagramIndex, panel);
    activeViewerIndex = diagramIndex;
    // These Disposables are not stored — they are automatically disposed
    // when the owning panel is disposed.
    panel.onDidDispose(() => {
        viewers.delete(diagramIndex);
        if (activeViewerIndex === diagramIndex) activeViewerIndex = -1;
    });
    panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) activeViewerIndex = diagramIndex;
    });
    panel.webview.onDidReceiveMessage((msg) => { void handleViewerMessage(msg); });

    const nonce = getNonce();
    panel.webview.html = generateViewerHtml(svg, nonce, bgColor);
}

/**
 * Send an updated SVG to an existing viewer panel.
 *
 * @param diagramIndex - 1-based diagram index
 * @param svg - Updated innerHTML of the .plantuml-diagram element
 * @param bgColor - CSS background color from the markdown preview theme
 */
export function updateDiagramViewer(diagramIndex: number, svg: string, bgColor?: string): void {
    const panel = viewers.get(diagramIndex);
    if (panel) {
        void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
    }
}

/**
 * Close viewer panels whose index exceeds the current diagram count.
 *
 * @param diagramCount - Current number of diagrams in the document.
 */
export function closeStaleViewers(diagramCount: number): void {
    const stale = [...viewers].filter(([i]) => i > diagramCount);
    for (const [, panel] of stale) {
        panel.dispose();
    }
}

/** Dispose all open viewer panels (called on extension deactivate). */
export function disposeAllViewers(): void {
    for (const panel of viewers.values()) {
        panel.dispose();
    }
    viewers.clear();
}

/**
 * Store diagram data from a preview right-click so that the next
 * saveDiagramFromViewer() call can save it without requiring an open viewer.
 */
export function setPendingSaveDiagram(svg: string, diagramIndex: number): void {
    pendingSave = { svg, diagramIndex };
}

/**
 * Request the active viewer to export its diagram as PNG or SVG.
 *
 * If a viewer panel is active, delegates to its webview for canvas rendering.
 * Otherwise, falls back to pending diagram data from a preview right-click.
 *
 * @param format - 'png' or 'svg'
 * @param previewPanel - optional preview webview panel for PNG canvas conversion
 */
export function saveDiagramFromViewer(format: 'png' | 'svg', previewPanel?: vscode.WebviewPanel): void {
    // Try active viewer panel first
    const viewerPanel = viewers.get(activeViewerIndex);
    if (viewerPanel) {
        void viewerPanel.webview.postMessage({ type: 'exportDiagram', format });
        return;
    }

    // Fall back to pending diagram data from preview right-click
    if (!pendingSave) {
        vscode.window.showWarningMessage(vscode.l10n.t('No diagram selected. Right-click a diagram or open it in the Diagram Viewer first.'));
        return;
    }
    const { svg, diagramIndex } = pendingSave;

    if (format === 'svg') {
        // Extract the SVG element from the innerHTML
        void saveSvgFromHtml(svg, diagramIndex);
    } else {
        // PNG: need canvas conversion — send to preview webview
        if (previewPanel) {
            void previewPanel.webview.postMessage({ type: 'exportDiagramAsPng', svg });
        }
    }
}

/**
 * Show a save dialog and write diagram data to the chosen file.
 *
 * @param data - File content (Buffer for PNG, string for SVG)
 * @param diagramIndex - 1-based diagram index for the default filename
 * @param format - 'png' or 'svg'
 */
async function saveDiagramToFile(data: Buffer | string, diagramIndex: number, format: 'png' | 'svg'): Promise<void> {
    const filters: Record<string, string[]> = format === 'png'
        ? { 'PNG Image': ['png'] }
        : { 'SVG Image': ['svg'] };
    const uri = await vscode.window.showSaveDialog({
        filters,
        defaultUri: vscode.Uri.file(`diagram-${diagramIndex}.${format}`),
    });
    if (!uri) return;
    try {
        await writeFile(uri.fsPath, data, typeof data === 'string' ? 'utf-8' : undefined);
        vscode.window.showInformationMessage(vscode.l10n.t('Diagram saved: {0}', uri.fsPath));
    } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to save diagram: {0}', (err as Error).message));
    }
}

/**
 * Save SVG extracted from diagram innerHTML.
 *
 * @param html - innerHTML of the .plantuml-diagram element containing an SVG
 * @param diagramIndex - 1-based diagram index for the default filename
 */
async function saveSvgFromHtml(html: string, diagramIndex: number): Promise<void> {
    // Extract the first <svg …>…</svg> from the innerHTML
    const match = html.match(/<svg[\s\S]*<\/svg>/i);
    if (!match) return;
    await saveDiagramToFile(match[0], diagramIndex, 'svg');
    pendingSave = null;
}

/**
 * Handle PNG data returned from the preview webview after canvas conversion.
 *
 * @param data - Base64-encoded PNG data URI from the webview canvas.
 */
export async function handlePngFromPreview(data: string): Promise<void> {
    if (!data || !pendingSave) return;
    const { diagramIndex } = pendingSave;
    await saveDiagramToFile(Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'), diagramIndex, 'png');
    pendingSave = null;
}

/** Handle messages sent from the viewer webview (runtime-validated by type guard). */
async function handleViewerMessage(msg: { type: string; format?: string; data?: string }): Promise<void> {
    if (msg.type !== 'exportDiagramResult' || !msg.format || !msg.data) return;
    if (msg.format !== 'png' && msg.format !== 'svg') return;

    const viewerIndex = activeViewerIndex;
    if (viewerIndex < 1) return;
    const format = msg.format;
    const fileData = format === 'png'
        ? Buffer.from(msg.data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : msg.data;
    await saveDiagramToFile(fileData, viewerIndex, format);
}

/**
 * Generate the full HTML for a Diagram Viewer webview panel.
 *
 * @param svg - innerHTML of the .plantuml-diagram element
 * @param nonce - CSP nonce for the inline script
 * @param bgColor - Optional CSS background color from the preview theme
 * @returns Complete HTML string for the webview
 */
function generateViewerHtml(svg: string, nonce: string, bgColor?: string): string {
    const containerBg = bgColor && CSS_COLOR_RE.test(bgColor.trim()) ? bgColor.trim() : '#fff';
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
    <div id="svg-container">${svg}</div>
</div>
<script nonce="${nonce}">
(function() {
    var vscode = acquireVsCodeApi();
    var viewport = document.getElementById('viewport');
    var container = document.getElementById('svg-container');
    var zoomLabel = document.getElementById('zoom-label');
    var MIN_SCALE = 0.1, MAX_SCALE = 20, ZOOM_STEP = 0.15;
    var scale = 1, translateX = 0, translateY = 0;
    var isDragging = false, dragStartX = 0, dragStartY = 0, dragStartTX = 0, dragStartTY = 0;

    function applyTransform() {
        container.style.transform = 'translate(' + translateX + 'px,' + translateY + 'px) scale(' + scale + ')';
        zoomLabel.textContent = Math.round(scale * 100) + '%';
    }

    function getSvgNaturalSize() {
        var svg = container.querySelector('svg');
        if (!svg) return { w: 100, h: 100 };
        var vb = svg.getAttribute('viewBox');
        if (vb) {
            var parts = vb.split(/[\\s,]+/);
            if (parts.length === 4) return { w: parseFloat(parts[2]), h: parseFloat(parts[3]) };
        }
        var w = parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width;
        var h = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height;
        return { w: w || 100, h: h || 100 };
    }

    function fitToWindow() {
        var sz = getSvgNaturalSize();
        var vpW = viewport.clientWidth;
        var vpH = viewport.clientHeight;
        var pad = 20;
        scale = Math.min((vpW - pad * 2) / sz.w, (vpH - pad * 2) / sz.h);
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        translateX = (vpW - sz.w * scale) / 2;
        translateY = (vpH - sz.h * scale) / 2;
        applyTransform();
    }

    function resetZoom() {
        var sz = getSvgNaturalSize();
        var vpW = viewport.clientWidth;
        var vpH = viewport.clientHeight;
        scale = 1;
        translateX = (vpW - sz.w) / 2;
        translateY = (vpH - sz.h) / 2;
        applyTransform();
    }

    function zoomAtCenter(delta) {
        var prevScale = scale;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (1 + delta)));
        var vpW = viewport.clientWidth;
        var vpH = viewport.clientHeight;
        var cx = vpW / 2, cy = vpH / 2;
        var ratio = scale / prevScale;
        translateX = cx - (cx - translateX) * ratio;
        translateY = cy - (cy - translateY) * ratio;
        applyTransform();
    }

    // Mouse wheel: vertical = zoom (cursor-centered), horizontal = pan
    viewport.addEventListener('wheel', function(e) {
        e.preventDefault();
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            // Horizontal scroll → horizontal pan
            translateX -= e.deltaX;
            applyTransform();
            return;
        }
        var prevScale = scale;
        var delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (1 + delta)));
        var rect = viewport.getBoundingClientRect();
        var cursorX = e.clientX - rect.left;
        var cursorY = e.clientY - rect.top;
        var ratio = scale / prevScale;
        translateX = cursorX - (cursorX - translateX) * ratio;
        translateY = cursorY - (cursorY - translateY) * ratio;
        applyTransform();
    }, { passive: false });

    // Drag to pan
    viewport.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        isDragging = true;
        viewport.classList.add('dragging');
        dragStartX = e.clientX; dragStartY = e.clientY;
        dragStartTX = translateX; dragStartTY = translateY;
        e.preventDefault();
    });
    window.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        translateX = dragStartTX + (e.clientX - dragStartX);
        translateY = dragStartTY + (e.clientY - dragStartY);
        applyTransform();
    });
    window.addEventListener('mouseup', function() {
        if (!isDragging) return;
        isDragging = false;
        viewport.classList.remove('dragging');
    });

    // Toolbar buttons
    document.getElementById('btn-fit').addEventListener('click', fitToWindow);
    document.getElementById('btn-100').addEventListener('click', resetZoom);
    document.getElementById('btn-zoom-in').addEventListener('click', function() { zoomAtCenter(ZOOM_STEP); });
    document.getElementById('btn-zoom-out').addEventListener('click', function() { zoomAtCenter(-ZOOM_STEP); });

    // Live update from extension host
    var cssColorRe = /^(#[\\da-fA-F]{3,8}|rgba?\\(\\s*[\\d.%,\\s\\/]+\\)|transparent|inherit|currentColor|[\\w-]+)$/;
    window.addEventListener('message', function(e) {
        if (e.data.type === 'updateSvg') {
            container.innerHTML = e.data.svg;
            if (e.data.bgColor && cssColorRe.test(e.data.bgColor.trim())) {
                var bg = e.data.bgColor.trim();
                container.style.background = bg;
                document.body.style.background = bg;
            }
            applyTransform();
        } else if (e.data.type === 'exportDiagram') {
            exportDiagram(e.data.format);
        }
    });

    // NOTE: This SVG-to-PNG canvas conversion logic is duplicated in
    // scroll-sync-webview.ts (exportSvgAsPng). The two run in separate
    // webview contexts and cannot share code directly.
    function exportDiagram(format) {
        var svgEl = container.querySelector('svg');
        if (!svgEl) return;
        if (format === 'svg') {
            vscode.postMessage({ type: 'exportDiagramResult', format: 'svg', data: svgEl.outerHTML });
            return;
        }
        // PNG: render SVG to canvas
        var svgData = new XMLSerializer().serializeToString(svgEl);
        var sz = getSvgNaturalSize();
        var dpr = 2; // export at 2x for crisp output
        var canvas = document.createElement('canvas');
        canvas.width = sz.w * dpr;
        canvas.height = sz.h * dpr;
        var ctx = canvas.getContext('2d');
        var img = new Image();
        img.onload = function() {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            try {
                vscode.postMessage({ type: 'exportDiagramResult', format: 'png', data: canvas.toDataURL('image/png') });
            } catch (e) {
                vscode.postMessage({ type: 'exportDiagramResult', format: 'png', data: '' });
            }
        };
        img.onerror = function() {
            vscode.postMessage({ type: 'exportDiagramResult', format: 'png', data: '' });
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
    }

    // Initial fit
    fitToWindow();
})();
</script>
</body>
</html>`;
}
