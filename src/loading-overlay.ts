/**
 * @module loading-overlay
 * @description Markup of the render progress overlay, shared by the preview page HTML and
 * the webview script that shows and hides it.
 *
 * Key behaviors:
 * - Dims the page and shows the "Rendering..." text in a box at its center, even while the
 *   page body is hidden for its scroll restore
 * - Escapes the text itself, so both sides pass it as plain text
 */

/** Element ID of the overlay. */
export const LOADING_OVERLAY_ID = 'loading-overlay';

/**
 * Build the overlay element.
 *
 * @param text - Text in the box, as plain text.
 * @returns HTML of the overlay, shown.
 */
export function loadingOverlayHtml(text: string): string {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div id="${LOADING_OVERLAY_ID}" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;z-index:9999;visibility:visible;">` +
        `<div style="background:var(--vscode-editor-background,#fff);color:var(--vscode-editor-foreground,#333);padding:12px 24px;border-radius:6px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);">${escaped}</div></div>`;
}
