/**
 * @module mermaid-preview
 * @description Standalone Mermaid file preview with pan & zoom.
 *
 * Opens a WebviewPanel to preview .mmd / .mermaid files directly.
 * Mermaid rendering happens inside the webview via mermaid.js.
 */
import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { CONFIG_SECTION, MERMAID_THEME_KEYS, MERMAID_THEME_SET, type Config } from './config.js';
import { LIGHT_THEME_KEYS, DARK_THEME_KEYS, getThemeBgColor } from './exporter.js';
import { getNonce, escapeHtml, CSS_COLOR_RE } from './utils.js';
import { handleExportMessage } from './export-handler.js';

/** The singleton preview panel. */
let panel: vscode.WebviewPanel | null = null;

/** Absolute path of the currently previewed file. */
let currentFilePath: string | null = null;

/** Last known config snapshot (used only for debounceDiagramChangeMs). */
let lastConfig: Config | null = null;

/** Extension URI for resolving mermaid.min.js path. */
let cachedExtensionUri: vscode.Uri | null = null;

/** Local preview theme (completely independent from settings). */
let localPreviewTheme = 'github-light';

/** Local Mermaid theme (completely independent from settings). */
let localMermaidTheme = 'default';

/** Debounce timer for text document changes. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Disposables tied to the current panel lifecycle. */
const panelDisposables: vscode.Disposable[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentBgColor(): string {
    return getThemeBgColor(localPreviewTheme);
}

function makePanelTitle(filePath: string): string {
    const name = filePath.split(/[/\\]/).pop() ?? 'Mermaid';
    return `${name} ${vscode.l10n.t('(Preview)')}`;
}

/** Read file content from open editor buffer or disk. */
async function readSource(filePath: string): Promise<string | null> {
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (openDoc) return openDoc.getText();
    try {
        return await readFile(filePath, 'utf-8');
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Webview HTML generation
// ---------------------------------------------------------------------------

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
<!-- TODO: extract shared pan & zoom script (shared with diagram-viewer.ts) -->
<script nonce="${nonce}">
(function() {
    var vscodeApi = acquireVsCodeApi();
    var viewport = document.getElementById('viewport');
    var container = document.getElementById('svg-container');
    var zoomLabel = document.getElementById('zoom-label');
    var MIN_SCALE = 0.1, MAX_SCALE = 20, ZOOM_STEP = 0.15;
    var scale = 1, translateX = 0, translateY = 0;
    var isDragging = false, dragStartX = 0, dragStartY = 0, dragStartTX = 0, dragStartTY = 0;
    var renderCounter = 0;
    var isFirstRender = true;

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

    // Mermaid rendering
    mermaid.initialize({ startOnLoad: false, theme: '${safeMermaidTheme}' });
    var lastSource = '';

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
    }

    // Message handler
    var cssColorRe = /^(#[\\da-fA-F]{3,8}|rgba?\\(\\s*[\\d.%,\\s\\/]+\\)|transparent|inherit|currentColor|[\\w-]+)$/;
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
            exportDiagram(e.data.format);
        }
    });

    function exportDiagram(format) {
        var svgEl = container.querySelector('svg');
        if (!svgEl) return;
        if (format === 'svg') {
            vscodeApi.postMessage({ type: 'exportDiagramResult', format: 'svg', data: svgEl.outerHTML });
            return;
        }
        var svgData = new XMLSerializer().serializeToString(svgEl);
        var sz = getSvgNaturalSize();
        var dpr = 2;
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

    // Render initial source
    var initialEl = document.getElementById('initial-source');
    if (initialEl && initialEl.textContent) {
        renderMermaid(initialEl.textContent);
    }
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

function getMermaidScriptUri(): string {
    if (!cachedExtensionUri || !panel) return '';
    const onDisk = vscode.Uri.joinPath(cachedExtensionUri, 'dist', 'mermaid.min.js');
    return panel.webview.asWebviewUri(onDisk).toString();
}

function buildHtml(source: string): string {
    return generateMermaidViewerHtml(
        getMermaidScriptUri(),
        getNonce(),
        getCurrentBgColor(),
        localMermaidTheme,
        source
    );
}

/** Schedule a debounced re-render. */
function scheduleRender(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    const delay = lastConfig?.debounceDiagramChangeMs ?? 300;
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void sendCurrentSource();
    }, delay);
}

/** Read current file and send source to webview. */
async function sendCurrentSource(): Promise<void> {
    if (!panel || !currentFilePath) return;
    const source = await readSource(currentFilePath);
    if (source === null || !panel) return;
    void panel.webview.postMessage({ type: 'updateSource', source });
}

// ---------------------------------------------------------------------------
// Export API
// ---------------------------------------------------------------------------

export async function openMermaidPreview(filePath: string, config: Config, extensionUri: vscode.Uri): Promise<void> {
    lastConfig = config;
    currentFilePath = filePath;
    cachedExtensionUri = extensionUri;

    if (panel) {
        panel.reveal(vscode.ViewColumn.Two, true);
        panel.title = makePanelTitle(filePath);
        void sendCurrentSource();
        return;
    }

    const source = await readSource(filePath);
    if (source === null) return;

    panel = vscode.window.createWebviewPanel(
        'plantumlMermaidPreview',
        makePanelTitle(filePath),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
            enableScripts: true,
            retainContextWhenHidden: vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('retainPreviewContext', true),
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
        }
    );

    panel.webview.html = buildHtml(source);

    panel.onDidDispose(() => {
        panel = null;
        currentFilePath = null;
        for (const d of panelDisposables) d.dispose();
        panelDisposables.length = 0;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    });

    panel.webview.onDidReceiveMessage((msg) => {
        void handleViewerMessage(msg);
    });

    panelDisposables.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!currentFilePath) return;
            if (e.document.uri.fsPath !== currentFilePath) return;
            scheduleRender();
        })
    );

    panelDisposables.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!currentFilePath) return;
            if (doc.uri.fsPath !== currentFilePath) return;
            scheduleRender();
        })
    );
}

/** Update config reference. Called when settings change. */
export function updateMermaidConfig(config: Config): void {
    lastConfig = config;
}

/** Get the currently previewed .mmd / .mermaid file path. */
export function getCurrentMermaidFilePath(): string | null {
    return currentFilePath;
}

/** Get the preview panel (for save commands). */
export function getMermaidPreviewPanel(): vscode.WebviewPanel | null {
    return panel;
}

/** Dispose the preview panel and clean up. */
export function disposeMermaidPreview(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (panel) {
        panel.dispose();
        panel = null;
    }
    currentFilePath = null;
}

/** Show a theme QuickPick for the Mermaid preview. */
export async function changeMermaidTheme(): Promise<void> {
    if (!panel) return;

    const buildThemeItems = <C extends string>(keys: readonly string[], category: C, currentKey: string) =>
        keys.map(key => ({
            label: key === currentKey ? `$(check) ${key}` : `      ${key}`,
            description: key === currentKey ? vscode.l10n.t('(current)') : '',
            category,
            themeKey: key
        }));

    const items = [
        { label: vscode.l10n.t('Preview Theme (Light)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(LIGHT_THEME_KEYS, 'preview' as const, localPreviewTheme),
        { label: vscode.l10n.t('Preview Theme (Dark)'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(DARK_THEME_KEYS, 'preview' as const, localPreviewTheme),
        { label: vscode.l10n.t('Mermaid Theme'), kind: vscode.QuickPickItemKind.Separator },
        ...buildThemeItems(MERMAID_THEME_KEYS, 'mermaid' as const, localMermaidTheme),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select theme')
    });
    if (!panel) return;

    if (!selected || !('category' in selected)) return;

    if (selected.category === 'preview') {
        if (selected.themeKey === localPreviewTheme) return;
        localPreviewTheme = selected.themeKey;
        void panel.webview.postMessage({ type: 'updateBgColor', bgColor: getCurrentBgColor() });
    } else if (selected.category === 'mermaid') {
        if (selected.themeKey === localMermaidTheme) return;
        localMermaidTheme = selected.themeKey;
        void panel.webview.postMessage({ type: 'updateMermaidTheme', theme: localMermaidTheme });
    }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function handleViewerMessage(msg: { type: string; format?: string; data?: string }): Promise<void> {
    return handleExportMessage(msg, currentFilePath);
}
