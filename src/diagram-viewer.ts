/**
 * @module diagram-viewer
 * @description Diagram Viewer panel with pan & zoom.
 *
 * Opens a separate WebviewPanel to display a diagram from the markdown preview
 * with interactive pan & zoom controls. Receives live SVG updates when the
 * editor content changes.
 */
import * as vscode from 'vscode';
import { getNonce, escapeHtml, CSS_COLOR_RE } from './utils.js';
import { getPanZoomScript } from './webview/pan-zoom-script.js';
import { saveDiagramFile } from './export-handler.js';

/** Active viewer panels keyed by 1-based diagram index. */
const viewers = new Map<number, vscode.WebviewPanel>();

/** Latest SVG/bgColor per viewer, for re-sending after webview reload (e.g. panel move). */
const latestState = new Map<number, { svg: string; bgColor?: string }>();

/** Index of the most recently focused viewer panel. */
let activeViewerIndex = -1;

/** Pending diagram data from a preview right-click (for Save/Copy as PNG/SVG and Open in Viewer). */
let pendingSave: { svg: string; diagramIndex: number; bgColor?: string; diagramType?: string; plantumlIndex?: number } | null = null;

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
        latestState.set(diagramIndex, { svg, bgColor: bgColor ?? '' });
        void existing.webview.postMessage({ type: 'updateSvg', svg, bgColor });
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'plantumlDiagramViewer',
        vscode.l10n.t('Diagram {0} (Viewer)', diagramIndex),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );

    viewers.set(diagramIndex, panel);
    activeViewerIndex = diagramIndex;
    // Disposed explicitly in onDidDispose below (not added to a shared disposable array).
    const viewStateDisposable = panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) activeViewerIndex = diagramIndex;
        // Re-send latest SVG after potential webview reload (e.g. panel move)
        if (e.webviewPanel.visible) {
            const latest = latestState.get(diagramIndex);
            if (latest) {
                void e.webviewPanel.webview.postMessage({ type: 'updateSvg', svg: latest.svg, bgColor: latest.bgColor });
            }
        }
    });
    const messageDisposable = panel.webview.onDidReceiveMessage((msg) => { void handleViewerMessage(msg); });
    panel.onDidDispose(() => {
        viewStateDisposable.dispose();
        messageDisposable.dispose();
        viewers.delete(diagramIndex);
        latestState.delete(diagramIndex);
        if (activeViewerIndex === diagramIndex) activeViewerIndex = -1;
    });

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
        latestState.set(diagramIndex, { svg, bgColor });
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
    latestState.clear();
    activeViewerIndex = -1;
}

/**
 * Store diagram data from a preview right-click so that the next
 * diagramAction() or openPendingDiagramViewer() call can operate
 * without requiring an open viewer panel.
 *
 * @param svg - innerHTML of the .plantuml-diagram / .mermaid-diagram element
 * @param diagramIndex - 1-based position of the diagram in the document
 * @param bgColor - CSS background color from the markdown preview theme
 * @param diagramType - 'plantuml', 'mermaid', or 'd2'
 * @param plantumlIndex - 0-based index among PlantUML diagrams only (-1 if not PlantUML)
 */
export function setPendingSaveDiagram(svg: string, diagramIndex: number, bgColor?: string, diagramType?: string, plantumlIndex?: number): void {
    pendingSave = { svg, diagramIndex, bgColor, diagramType, plantumlIndex };
}

/**
 * Return the diagram type and PlantUML-specific index from the most recent
 * right-click context, or null if no context has been stored.
 */
export function getPendingDiagramContext(): { diagramType?: string; plantumlIndex?: number } | null {
    if (!pendingSave) return null;
    return { diagramType: pendingSave.diagramType, plantumlIndex: pendingSave.plantumlIndex };
}

/**
 * Open the diagram viewer using the pending diagram data stored by a
 * previous right-click (via {@link setPendingSaveDiagram}).
 *
 * Called by the `plantuml-markdown-preview.openDiagramViewer` command
 * registered in extension.ts.  Shows a warning if no diagram context
 * has been stored yet.
 */
export function openPendingDiagramViewer(): void {
    if (!pendingSave) {
        vscode.window.showWarningMessage(vscode.l10n.t('No diagram selected. Right-click a diagram first.'));
        return;
    }
    openDiagramViewer(pendingSave.svg, pendingSave.diagramIndex, pendingSave.bgColor);
}

/**
 * Save or copy a diagram as PNG or SVG.
 *
 * If a viewer panel is active, delegates to its webview.
 * Otherwise, falls back to pending diagram data from a preview right-click.
 *
 * @param action - 'save' (file dialog) or 'copy' (clipboard)
 * @param format - 'png' or 'svg'
 * @param previewPanel - optional preview webview panel for PNG canvas conversion
 */
export function diagramAction(action: 'save' | 'copy', format: 'png' | 'svg', previewPanel?: vscode.WebviewPanel): void {
    // Try active viewer panel first
    const viewerPanel = viewers.get(activeViewerIndex);
    if (viewerPanel) {
        const msgType = action === 'copy' ? 'copyDiagram' : 'exportDiagram';
        void viewerPanel.webview.postMessage({ type: msgType, format });
        return;
    }

    // Fall back to pending diagram data from preview right-click
    if (!pendingSave) {
        vscode.window.showWarningMessage(vscode.l10n.t('No diagram selected. Right-click a diagram or open it in the Diagram Viewer first.'));
        return;
    }
    const { svg, diagramIndex } = pendingSave;

    if (format === 'svg' && action === 'save') {
        void saveSvgFromHtml(svg, diagramIndex);
    } else if (format === 'png') {
        // PNG: need canvas conversion — send to preview webview
        const msgType = action === 'copy' ? 'copyDiagramAsPng' : 'exportDiagramAsPng';
        if (previewPanel) {
            void previewPanel.webview.postMessage({ type: msgType, svg });
        }
    }
    // SVG copy (format==='svg' && action==='copy') is handled directly via
    // the webview clipboard API. If we reach this fallback, notify the user.
    if (format === 'svg' && action === 'copy') {
        void vscode.window.showWarningMessage(vscode.l10n.t('SVG copy is not available from this context.'));
    }
}


/**
 * Extract SVG from innerHTML and save to file.
 *
 * @param html - Raw innerHTML containing an SVG element.
 * @param diagramIndex - 1-based diagram index for the default file name.
 */
async function saveSvgFromHtml(html: string, diagramIndex: number): Promise<void> {
    const match = html.match(/<svg[\s\S]*<\/svg>/i);
    if (!match) return;
    await saveDiagramFile(match[0], vscode.Uri.file(`diagram-${diagramIndex}.svg`), 'svg');
    pendingSave = null;
}

/**
 * Handle PNG data returned from the preview webview after canvas conversion.
 *
 * @param data - Base64-encoded PNG data URL string.
 */
export async function handlePngFromPreview(data: string): Promise<void> {
    if (!data || !pendingSave) return;
    const { diagramIndex } = pendingSave;
    pendingSave = null;
    await saveDiagramFile(Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'), vscode.Uri.file(`diagram-${diagramIndex}.png`), 'png');
}

/**
 * Show a notification after a webview copy operation completes.
 *
 * @param success - Whether the clipboard copy succeeded.
 */
export function handleCopyResult(success: boolean): void {
    if (success) {
        vscode.window.showInformationMessage(vscode.l10n.t('Diagram copied as PNG'));
    } else {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy diagram to clipboard'));
    }
    pendingSave = null;
}

/** Handle messages sent from the viewer webview (runtime-validated by type guard). */
async function handleViewerMessage(msg: { type: string; format?: string; data?: string; success?: boolean }): Promise<void> {
    if (msg.type === 'copyDiagramResult') {
        handleCopyResult(!!msg.success);
        return;
    }
    if (msg.type !== 'exportDiagramResult' || !msg.format || !msg.data) return;
    if (msg.format !== 'png' && msg.format !== 'svg') return;

    const viewerIndex = activeViewerIndex;
    if (viewerIndex < 1) return;
    const format = msg.format;
    const fileData = format === 'png'
        ? Buffer.from(msg.data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : msg.data;
    await saveDiagramFile(fileData, vscode.Uri.file(`diagram-${viewerIndex}.${format}`), format);
}

/**
 * Generate the full HTML for a Diagram Viewer webview panel.
 *
 * @param svg - innerHTML of the .plantuml-diagram element
 * @param nonce - CSP nonce for the inline script
 * @param bgColor - Optional CSS background color from the preview theme
 * @returns Complete HTML string for the webview
 */
export function generateViewerHtml(svg: string, nonce: string, bgColor?: string): string {
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
    var vscodeApi = acquireVsCodeApi();
${getPanZoomScript()}
    // Live update from extension host
    var hasInitialFit = false;
    window.addEventListener('message', function(e) {
        if (e.data.type === 'updateSvg') {
            container.innerHTML = e.data.svg;
            if (e.data.bgColor && cssColorRe.test(e.data.bgColor.trim())) {
                var bg = e.data.bgColor.trim();
                container.style.background = bg;
                document.body.style.background = bg;
            }
            // Only fit on first load; subsequent updates preserve zoom/pan
            if (!hasInitialFit) { fitToWindow(); hasInitialFit = true; }
            else { applyTransform(); }
        } else if (e.data.type === 'exportDiagram') {
            handleDiagramAction('save', e.data.format);
        } else if (e.data.type === 'copyDiagram') {
            handleDiagramAction('copy', e.data.format);
        }
    });

    // Initial fit
    fitToWindow();
})();
</script>
</body>
</html>`;
}
