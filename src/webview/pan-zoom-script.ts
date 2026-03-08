/**
 * @module pan-zoom-script
 * @description Shared pan & zoom JavaScript for webview panels.
 *
 * Returns inline JavaScript that provides pan, zoom, drag, and diagram
 * export functionality. Used by both diagram-viewer and mermaid-preview
 * webview panels.
 *
 * Assumes the following DOM elements exist:
 * - `#viewport` — scrollable container
 * - `#svg-container` — holds the SVG element
 * - `#zoom-label` — displays the current zoom percentage
 * - `#btn-fit`, `#btn-100`, `#btn-zoom-in`, `#btn-zoom-out` — toolbar buttons
 *
 * Assumes `vscodeApi` variable is available (from `acquireVsCodeApi()`).
 *
 * Exposes these functions to the surrounding IIFE scope:
 * `applyTransform`, `getSvgNaturalSize`, `fitToWindow`, `resetZoom`,
 * `zoomAtCenter`, `exportDiagram`, and the `cssColorRe` regex.
 */

/**
 * Return the shared pan & zoom JavaScript code as a string.
 *
 * @returns Inline JavaScript to embed in a webview `<script>` block.
 */
export function getPanZoomScript(): string {
    return `
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
            var parts = vb.split(/[\\\\s,]+/);
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

    var cssColorRe = /^(#[\\\\da-fA-F]{3,8}|rgba?\\\\(\\\\s*[\\\\d.%,\\\\s\\\\/]+\\\\)|transparent|inherit|currentColor|[\\\\w-]+)$/;

    // NOTE: This SVG-to-PNG canvas conversion logic is duplicated in
    // scroll-sync-webview.ts (exportSvgAsPng). The two run in separate
    // webview contexts and cannot share code directly.
    function exportDiagram(format) {
        var svgEl = container.querySelector('svg');
        if (!svgEl) return;
        if (format === 'svg') {
            vscodeApi.postMessage({ type: 'exportDiagramResult', format: 'svg', data: svgEl.outerHTML });
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
                vscodeApi.postMessage({ type: 'exportDiagramResult', format: 'png', data: canvas.toDataURL('image/png') });
            } catch (e) {
                vscodeApi.postMessage({ type: 'exportDiagramResult', format: 'png', data: '' });
            }
        };
        img.onerror = function() {
            vscodeApi.postMessage({ type: 'exportDiagramResult', format: 'png', data: '' });
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
    }
`;
}
