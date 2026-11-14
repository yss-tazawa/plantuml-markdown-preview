/**
 * @module mermaid-load-error
 * @description What a webview page shows when the Mermaid library cannot be used, shared by
 * the Markdown page and the Mermaid file page.
 *
 * Key behaviors:
 * - One localized text, given to the page as a JavaScript string literal
 * - On the Markdown page, one inline function that shows the text in place of each Mermaid
 *   diagram not shown yet; the page's loader and the preview script both call it
 */
import * as vscode from 'vscode';

/**
 * The text shown in place of a Mermaid diagram when the library cannot be used.
 *
 * @returns A JavaScript string literal, safe inside an inline script element.
 */
export function mermaidLoadErrorLiteral(): string {
    return JSON.stringify(vscode.l10n.t('Mermaid could not be loaded, so this diagram cannot be rendered. Close the preview or Reading View and open it again to retry.'))
        .replace(/</g, '\\u003c');
}

/**
 * Inline script defining `window.__showMermaidLoadError`, which shows `window.__mermaidLoadError`
 * in place of each Mermaid diagram of the Markdown page that has no image or error yet.
 */
export const SHOW_MERMAID_LOAD_ERROR_SCRIPT =
    `window.__showMermaidLoadError=function(){var t=window.__mermaidLoadError;if(!t)return;` +
    `document.querySelectorAll('.mermaid-diagram pre.mermaid').forEach(function(p){` +
    `if(p.querySelector('svg,.mermaid-error'))return;` +
    `var d=document.createElement('div');d.className='mermaid-error';d.textContent=t;p.replaceChildren(d)})};`;
