/**
 * @module diagram-viewer
 * @description Diagram Viewer panel with pan & zoom.
 *
 * Opens a separate WebviewPanel to display a diagram from the markdown preview
 * with interactive pan & zoom controls. Receives live SVG updates when the
 * editor content changes.
 */
import * as vscode from 'vscode';
import { getNonce } from './utils.js';

/** Active viewer panels keyed by 1-based diagram index. */
const viewers = new Map<number, vscode.WebviewPanel>();

/**
 * Open (or reveal) a diagram viewer panel for the given diagram index.
 *
 * If a viewer for the same index already exists, it is revealed.
 * Otherwise a new WebviewPanel is created.
 *
 * @param svg - innerHTML of the .plantuml-diagram element
 * @param diagramIndex - 1-based position of the diagram in the document
 */
export function openDiagramViewer(svg: string, diagramIndex: number, bgColor?: string): void {
    const existing = viewers.get(diagramIndex);
    if (existing) {
        existing.reveal(vscode.ViewColumn.Two);
        existing.webview.postMessage({ type: 'updateSvg', svg, bgColor });
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'plantumlDiagramViewer',
        vscode.l10n.t('Diagram {0} (Viewer)', diagramIndex),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [] }
    );

    viewers.set(diagramIndex, panel);
    panel.onDidDispose(() => { viewers.delete(diagramIndex); });

    const nonce = getNonce();
    panel.webview.html = generateViewerHtml(svg, nonce, bgColor);
}

/**
 * Send an updated SVG to an existing viewer panel.
 *
 * @param diagramIndex - 1-based diagram index
 * @param svg - Updated innerHTML of the .plantuml-diagram element
 */
export function updateDiagramViewer(diagramIndex: number, svg: string, bgColor?: string): void {
    const panel = viewers.get(diagramIndex);
    if (panel) {
        void panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
    }
}

/** Dispose all open viewer panels (called on extension deactivate). */
export function disposeAllViewers(): void {
    for (const panel of viewers.values()) {
        panel.dispose();
    }
    viewers.clear();
}

function generateViewerHtml(svg: string, nonce: string, bgColor?: string): string {
    const containerBg = bgColor || '#fff';
    const labels = {
        fit: vscode.l10n.t('Fit'),
        fitTitle: vscode.l10n.t('Fit to Window'),
        zoomIn: vscode.l10n.t('Zoom In'),
        zoomOut: vscode.l10n.t('Zoom Out'),
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
    border: none; border-radius: 4px;
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
<body>
<div id="toolbar">
    <button id="btn-fit" title="${labels.fitTitle}">${labels.fit}</button>
    <button id="btn-100" title="1:1">1:1</button>
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

    // Mouse wheel zoom (cursor-centered)
    viewport.addEventListener('wheel', function(e) {
        e.preventDefault();
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
    window.addEventListener('message', function(e) {
        if (e.data.type === 'updateSvg') {
            container.innerHTML = e.data.svg;
            if (e.data.bgColor) {
                container.style.background = e.data.bgColor;
                document.body.style.background = e.data.bgColor;
            }
            applyTransform();
        }
    });

    // Initial fit
    fitToWindow();
})();
</script>
</body>
</html>`;
}
