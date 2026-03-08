/**
 * @module scroll-sync
 * @description Generates the <script> tag that loads the Webview-side scroll sync script.
 *
 * The actual scroll sync logic lives in src/webview/scroll-sync-webview.ts,
 * which is bundled by esbuild into dist/scroll-sync-webview.js.
 * Dynamic parameters are passed via data-* attributes on the <script> element.
 */
import { escapeHtml } from './utils.js';

/**
 * Generate a `<script>` tag that loads the external scroll sync script with data-* parameters.
 *
 * @param initialLine - Editor top line to restore after re-render (-1 = no restore).
 * @param initialMaxTopLine - Editor max top line for the tail anchor.
 * @param nonce - CSP nonce string to authorize the script.
 * @param renderingText - Localized "Rendering..." text for the loading overlay.
 * @param syncMasterTimeoutMs - Timeout in ms before syncMaster resets to 'none'.
 * @param scrollSyncUri - Webview URI for the bundled scroll-sync-webview.js.
 * @param [initialAtBottom=false] - If true, snap preview to bottom on initial render.
 * @param [enableDiagramViewer=true] - If true, diagrams are clickable to open in a viewer.
 * @returns HTML `<script>` tag string ready for insertion before `</body>`.
 */
export function getScrollSyncScriptTag(
    initialLine: number,
    initialMaxTopLine: number,
    nonce: string,
    renderingText: string,
    syncMasterTimeoutMs: number,
    scrollSyncUri: string,
    initialAtBottom = false,
    enableDiagramViewer = true
): string {
    return `<script nonce="${nonce}" src="${escapeHtml(scrollSyncUri)}" data-initial-line="${initialLine}" data-initial-max-top-line="${initialMaxTopLine}" data-initial-at-bottom="${initialAtBottom}" data-rendering-text="${escapeHtml(renderingText)}" data-sync-master-timeout-ms="${syncMasterTimeoutMs}" data-enable-diagram-viewer="${enableDiagramViewer}"></script>`;
}
