/**
 * @module shown-script-loader
 * @description Inline script that loads a large library into a webview page only after the
 * page is shown, shared by the preview page and the Mermaid file page.
 *
 * Key behaviors:
 * - VS Code keeps a new webview page hidden until its load event, or until a 200ms timer
 *   that cannot run while a large script is parsed; so the library is added after one of
 *   these, and after a frame is drawn, never during the page's parse
 * - Starts at the load event, or after {@link SHOWN_FALLBACK_MS} when the load waits on a
 *   slow resource such as a remote image, whichever comes first, and only once
 * - A hidden page draws no frames, so it adds the library without waiting for one
 */

/** Time after which the library loads even if the page's load event has not fired. */
export const SHOWN_FALLBACK_MS = 300;

/**
 * Build the inline script that adds the library once the page is shown.
 *
 * @param nonce - CSP nonce, given to the added script element.
 * @param src - URI of the library.
 * @param onload - JavaScript run once the library has loaded.
 * @param onerror - JavaScript run when the library fails to load.
 * @returns JavaScript for an inline script element (not wrapped in a script tag).
 */
export function shownScriptLoader(nonce: string, src: string, onload: string, onerror: string): string {
    return `(function(){var started=false;` +
        `function load(){var s=document.createElement('script');s.nonce='${nonce}';s.src='${src}';` +
        `s.onload=function(){${onload}};s.onerror=function(){${onerror}};document.body.appendChild(s)}` +
        `function schedule(){if(started)return;started=true;` +
        `if(document.hidden)setTimeout(load,0);else requestAnimationFrame(function(){setTimeout(load,0)})}` +
        `if(document.readyState==='complete')schedule();` +
        `else{window.addEventListener('load',schedule);setTimeout(schedule,${SHOWN_FALLBACK_MS})}})();`;
}
