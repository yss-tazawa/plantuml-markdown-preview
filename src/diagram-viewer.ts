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
import { saveDiagramFile, sanitizeSvgEntities } from './export-handler.js';

/** A viewer panel and the preview it was opened from. */
interface ViewerEntry {
    /** Id of the preview that opened the viewer. */
    owner: number;
    /** 1-based diagram index within that preview. */
    index: number;
    panel: vscode.WebviewPanel;
    /** Latest SVG/bgColor, for re-sending after webview reload (e.g. panel move). */
    latest?: { svg: string; bgColor?: string };
}

/** Active viewer panels keyed by {@link viewerKey}. */
const viewers = new Map<string, ViewerEntry>();

/** Key of the most recently focused viewer panel, or null. */
let activeViewerKey: string | null = null;

/** Pending diagram data from a preview right-click (for Save/Copy as PNG/SVG and Open in Viewer). */
let pendingSave: { owner: number; svg: string; diagramIndex: number; bgColor?: string; diagramType?: string; plantumlIndex?: number } | null = null;

/**
 * Key of the viewer for a diagram of a preview.
 *
 * @param owner - Id of the preview the diagram belongs to.
 * @param diagramIndex - 1-based diagram index within that preview.
 */
function viewerKey(owner: number, diagramIndex: number): string {
    return `${owner}:${diagramIndex}`;
}

/**
 * Open (or reveal) a diagram viewer panel for the given diagram of a preview.
 *
 * If a viewer for the same diagram of the same preview already exists, it is updated.
 * Otherwise a new WebviewPanel is created.
 *
 * @param owner - Id of the preview the diagram belongs to.
 * @param svg - innerHTML of the .plantuml-diagram element
 * @param diagramIndex - 1-based position of the diagram in the document
 * @param bgColor - CSS background color from the markdown preview theme
 */
export function openDiagramViewer(owner: number, svg: string, diagramIndex: number, bgColor?: string): void {
    const key = viewerKey(owner, diagramIndex);
    const existing = viewers.get(key);
    if (existing) {
        existing.latest = { svg, bgColor: bgColor ?? '' };
        void existing.panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'plantumlDiagramViewer',
        vscode.l10n.t('Diagram {0} (Viewer)', diagramIndex),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );

    const entry: ViewerEntry = { owner, index: diagramIndex, panel };
    viewers.set(key, entry);
    activeViewerKey = key;
    // Disposed explicitly in onDidDispose below (not added to a shared disposable array).
    const viewStateDisposable = panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) activeViewerKey = key;
    });
    const messageDisposable = panel.webview.onDidReceiveMessage((msg) => {
        void handleViewerMessage(msg, entry).catch(err => console.error('[diagram-viewer] message handler error:', err));
    });
    const disposeDisposable = panel.onDidDispose(() => {
        viewStateDisposable.dispose();
        messageDisposable.dispose();
        disposeDisposable.dispose();
        if (viewers.get(key) === entry) viewers.delete(key);
        if (activeViewerKey === key) activeViewerKey = null;
    });

    const nonce = getNonce();
    panel.webview.html = generateViewerHtml(svg, nonce, bgColor);
}

/**
 * Send an updated SVG to an existing viewer panel of a preview.
 *
 * @param owner - Id of the preview the diagram belongs to.
 * @param diagramIndex - 1-based diagram index
 * @param svg - Updated innerHTML of the .plantuml-diagram element
 * @param bgColor - CSS background color from the markdown preview theme
 */
export function updateDiagramViewer(owner: number, diagramIndex: number, svg: string, bgColor?: string): void {
    const entry = viewers.get(viewerKey(owner, diagramIndex));
    if (entry) {
        entry.latest = { svg, bgColor };
        void entry.panel.webview.postMessage({ type: 'updateSvg', svg, bgColor });
    }
}

/**
 * Close the viewer panels of a preview whose index exceeds its current diagram count.
 *
 * @param owner - Id of the preview.
 * @param diagramCount - Current number of diagrams in the document.
 */
export function closeStaleViewers(owner: number, diagramCount: number): void {
    const stale = [...viewers.values()].filter(e => e.owner === owner && e.index > diagramCount);
    for (const entry of stale) {
        entry.panel.dispose();
    }
}

/**
 * Dispose the viewer panels opened from a preview (e.g. when it switches files,
 * or when a preview that owns no lasting panel goes away).
 *
 * @param owner - Id of the preview.
 */
export function disposeViewersOf(owner: number): void {
    for (const entry of [...viewers.values()]) {
        if (entry.owner === owner) entry.panel.dispose();
    }
}

/** Dispose all open viewer panels (called on extension deactivate). */
export function disposeAllViewers(): void {
    for (const entry of [...viewers.values()]) {
        entry.panel.dispose();
    }
    viewers.clear();
    activeViewerKey = null;
}

/**
 * The open viewer panels with the preview each belongs to (for test hooks).
 *
 * @returns One item per viewer: owning preview id, diagram index, panel and latest SVG sent after creation.
 */
export function getDiagramViewers(): { owner: number; index: number; panel: vscode.WebviewPanel; svg: string | null }[] {
    return [...viewers.values()].map(e => ({ owner: e.owner, index: e.index, panel: e.panel, svg: e.latest?.svg ?? null }));
}

/**
 * Store diagram data from a preview right-click so that the next
 * diagramAction() or openPendingDiagramViewer() call can operate
 * without requiring an open viewer panel.
 *
 * @param owner - Id of the preview the right-click came from.
 * @param svg - innerHTML of the .plantuml-diagram / .mermaid-diagram element
 * @param diagramIndex - 1-based position of the diagram in the document
 * @param bgColor - CSS background color from the markdown preview theme
 * @param diagramType - 'plantuml', 'mermaid', or 'd2'
 * @param plantumlIndex - 0-based index among PlantUML diagrams only (-1 if not PlantUML)
 */
export function setPendingSaveDiagram(owner: number, svg: string, diagramIndex: number, bgColor?: string, diagramType?: string, plantumlIndex?: number): void {
    pendingSave = { owner, svg, diagramIndex, bgColor, diagramType, plantumlIndex };
}

/**
 * Return the preview, diagram type and PlantUML-specific index from the most
 * recent right-click context, or null if no context has been stored.
 */
export function getPendingDiagramContext(): { owner: number; diagramType?: string; plantumlIndex?: number } | null {
    if (!pendingSave) return null;
    return { owner: pendingSave.owner, diagramType: pendingSave.diagramType, plantumlIndex: pendingSave.plantumlIndex };
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
    openDiagramViewer(pendingSave.owner, pendingSave.svg, pendingSave.diagramIndex, pendingSave.bgColor);
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
    const viewer = activeViewerKey === null ? undefined : viewers.get(activeViewerKey);
    if (viewer) {
        const msgType = action === 'copy' ? 'copyDiagram' : 'exportDiagram';
        void viewer.panel.webview.postMessage({ type: msgType, format });
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
    } else if (format === 'svg' && action === 'copy') {
        // SVG copy is normally handled via the webview clipboard API.
        // If we reach this fallback path, notify the user.
        void vscode.window.showWarningMessage(vscode.l10n.t('SVG copy is not available from this context.'));
    } else if (format === 'png') {
        // PNG: need canvas conversion — send to preview webview
        const msgType = action === 'copy' ? 'copyDiagramAsPng' : 'exportDiagramAsPng';
        if (previewPanel) {
            void previewPanel.webview.postMessage({ type: msgType, svg });
        }
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
    await saveDiagramFile(sanitizeSvgEntities(match[0]), vscode.Uri.file(`diagram-${diagramIndex}.svg`), 'svg');
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

/**
 * Handle a message posted by the viewer webview. The message is not validated as a
 * whole: each branch checks its type and the fields it uses.
 *
 * @param msg - Message posted by the webview.
 * @param entry - Viewer whose webview posted the message.
 */
async function handleViewerMessage(
    msg: { type: string; format?: string; data?: string; success?: boolean },
    entry: ViewerEntry
): Promise<void> {
    if (msg.type === 'webviewReady') {
        // A page load: a webview recreated from its initial HTML (e.g. after a
        // move to another window) shows the first SVG, so re-send the latest one.
        const latest = entry.latest;
        if (latest) void entry.panel.webview.postMessage({ type: 'updateSvg', svg: latest.svg, bgColor: latest.bgColor });
        return;
    }
    if (msg.type === 'copyDiagramResult') {
        handleCopyResult(!!msg.success);
        return;
    }
    if (msg.type !== 'exportDiagramResult' || !msg.format || !msg.data) return;
    if (msg.format !== 'png' && msg.format !== 'svg') return;

    const viewer = activeViewerKey === null ? undefined : viewers.get(activeViewerKey);
    if (!viewer) return;
    const format = msg.format;
    const fileData = format === 'png'
        ? Buffer.from(msg.data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : msg.data;
    await saveDiagramFile(fileData, vscode.Uri.file(`diagram-${viewer.index}.${format}`), format);
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

    // Report each page load; a webview recreated from this HTML gets the current state.
    vscodeApi.postMessage({ type: 'webviewReady' });
})();
</script>
</body>
</html>`;
}
