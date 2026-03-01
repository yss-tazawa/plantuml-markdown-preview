/**
 * @module scroll-sync
 * @description Generates the Webview-side scroll sync script (runs in the browser context).
 *
 * The generated script handles bidirectional scroll sync between editor and preview:
 * - Builds a sparse anchor array from data-source-line attributes ({line, pixel} pairs)
 * - Binary search + linear interpolation for line <-> pixel conversion
 * - syncMaster state machine ('none' | 'editor' | 'preview') prevents feedback loops
 * - expectingScrollEvent flag distinguishes programmatic scroll from user scroll
 * - Restores scroll position after re-render via INITIAL_LINE / INITIAL_MAX_TOP_LINE
 * - MutationObserver invalidates anchors when DOM content changes
 *
 * NOTE: The Webview JavaScript is embedded as a string template because the VS Code
 * Webview API requires fully serialised HTML. This means the embedded code is not
 * type-checked or linted. Keep changes minimal and well-tested.
 */

/**
 * Generate the scroll sync JavaScript wrapped in a nonce-authorized `<script>` tag.
 *
 * The generated IIFE runs inside the Webview browser context and provides:
 * - Anchor-based scroll map built from data-source-line DOM attributes
 * - Binary search + linear interpolation for line <-> pixel conversion
 * - syncMaster state machine to prevent feedback loops
 * - expectingScrollEvent flag for programmatic scroll detection
 * - Scroll position restore on re-render via INITIAL_LINE / INITIAL_MAX_TOP_LINE
 * - MutationObserver to invalidate anchors when DOM changes
 * - Message handlers: scrollToLine, updateTheme, showLoading, hideLoading
 *
 * @param {number} initialLine - Editor top line to restore after re-render (-1 = no restore).
 * @param {number} initialMaxTopLine - Editor max top line for the tail anchor.
 * @param {string} nonce - CSP nonce string to authorize the inline script.
 * @param {number} renderSeq - Sequence number to discard stale showLoading messages.
 * @param {string} renderingText - Localized "Rendering..." text for the loading overlay.
 * @returns {string} HTML `<script nonce="...">` string ready for insertion before `</body>`.
 */
export function buildScrollSyncScript(initialLine: number, initialMaxTopLine: number, nonce: string, renderSeq: number, renderingText: string, syncMasterTimeoutMs: number): string {
    return `<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();
    const INITIAL_LINE = ${initialLine};
    const INITIAL_MAX_TOP_LINE = ${initialMaxTopLine};
    const RENDER_SEQ = ${renderSeq};
    const RENDERING_TEXT = ${JSON.stringify(renderingText)};

    // --- State ---
    let anchors = null;
    let lastMaxTopLine = -1;
    let lastSentLine = -1;
    let expectingScrollEvent = false;

    // syncMaster state machine: 'none' | 'editor' | 'preview'
    let syncMaster = 'none';
    let syncMasterTimer = null;
    /**
     * Set syncMaster and auto-reset to 'none' after 300ms.
     *
     * @param {'editor'|'preview'} who - Origin of the scroll action
     */
    function setSyncMaster(who) {
        syncMaster = who;
        if (syncMasterTimer) clearTimeout(syncMasterTimer);
        syncMasterTimer = setTimeout(function() { syncMaster = 'none'; syncMasterTimer = null; }, ${syncMasterTimeoutMs});
    }

    // --- Anchor-based scroll map ---

    /**
     * Build a sparse anchor array from data-source-line elements in the DOM.
     * Each anchor is a {line, pixel} pair mapping a source line number to a pixel offset in the preview.
     * Uses getBoundingClientRect() + scrollY for absolute positioning (single API call per element,
     * simpler and more robust than manual offsetParent chain traversal).
     * Appends a synthetic tail anchor at maxTopLine to guarantee editor-bottom = preview-bottom.
     *
     * @param {number} maxTopLine - Maximum scroll line of the editor
     * @returns {Array<{line: number, pixel: number}>|null} Sorted anchor array, or null if no elements found
     */
    function buildAnchors(maxTopLine) {
        const elements = document.querySelectorAll('[data-source-line]');
        if (elements.length === 0) return null;

        const list = [{line: 0, pixel: 0}];
        const scrollY = window.scrollY;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const line = parseInt(el.getAttribute('data-source-line'), 10);
            if (!isNaN(line) && line > 0) {
                const offsetTop = Math.round(el.getBoundingClientRect().top + scrollY);
                if (offsetTop > 0) {
                    list.push({line: line, pixel: offsetTop});
                }
            }
        }

        // Synthetic tail anchor: editor bottom = preview bottom
        if (maxTopLine > 0) {
            const maxScrollTop = Math.max(0, document.body.scrollHeight - window.innerHeight);
            list.push({line: maxTopLine, pixel: maxScrollTop});
        }

        list.sort(function(a, b) { return a.line - b.line; });

        // Deduplicate (same line number: keep the later entry)
        const deduped = [list[0]];
        for (let i = 1; i < list.length; i++) {
            if (list[i].line === deduped[deduped.length - 1].line) {
                deduped[deduped.length - 1] = list[i];
            } else {
                deduped.push(list[i]);
            }
        }

        // Ensure pixel values are monotonically increasing
        for (let i = 1; i < deduped.length; i++) {
            if (deduped[i].pixel < deduped[i - 1].pixel) {
                deduped[i].pixel = deduped[i - 1].pixel;
            }
        }

        return deduped;
    }

    /**
     * Return the anchor array with caching (rebuild if not built or maxTopLine changed).
     *
     * @param {number} maxTopLine - Maximum scroll line of the editor
     * @returns {Array<{line: number, pixel: number}>|null} Anchor array
     */
    function ensureAnchors(maxTopLine) {
        if (!anchors || maxTopLine !== lastMaxTopLine) {
            lastMaxTopLine = maxTopLine;
            anchors = buildAnchors(maxTopLine);
        }
        return anchors;
    }

    /**
     * Binary search the anchor array and linearly interpolate source line -> pixel position.
     *
     * @param {Array<{line: number, pixel: number}>} anc - Anchor array
     * @param {number} topLine - Source line number
     * @returns {number} Corresponding pixel position
     */
    function lineToPixel(anc, topLine) {
        if (!anc || anc.length === 0) return 0;
        if (topLine <= anc[0].line) return anc[0].pixel;
        if (topLine >= anc[anc.length - 1].line) return anc[anc.length - 1].pixel;

        let lo = 0, hi = anc.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (anc[mid].line <= topLine) lo = mid;
            else hi = mid;
        }

        const a = anc[lo], b = anc[hi];
        const t = (topLine - a.line) / (b.line - a.line);
        return a.pixel + t * (b.pixel - a.pixel);
    }

    /**
     * Binary search the anchor array and linearly interpolate pixel position -> source line.
     *
     * @param {Array<{line: number, pixel: number}>} anc - Anchor array
     * @param {number} scrollTop - Scroll position (px)
     * @returns {number} Corresponding source line number
     */
    function pixelToLine(anc, scrollTop) {
        if (!anc || anc.length === 0) return 0;
        if (scrollTop <= anc[0].pixel) return anc[0].line;
        if (scrollTop >= anc[anc.length - 1].pixel) return anc[anc.length - 1].line;

        let lo = 0, hi = anc.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (anc[mid].pixel <= scrollTop) lo = mid;
            else hi = mid;
        }

        const a = anc[lo], b = anc[hi];
        if (b.pixel === a.pixel) return a.line;
        const t = (scrollTop - a.pixel) / (b.pixel - a.pixel);
        return a.line + t * (b.line - a.line);
    }

    // --- Editor -> Preview sync ---

    /**
     * Scroll the preview to the position corresponding to the given source line.
     * Uses the expectingScrollEvent flag to distinguish programmatic scrolls.
     *
     * @param {number} topLine - Source line number to scroll to
     * @param {number} maxTopLine - Maximum scroll line of the editor
     */
    function scrollToSourceLine(topLine, maxTopLine) {
        const anc = ensureAnchors(maxTopLine);
        if (!anc) return;

        const targetY = Math.max(0, Math.round(lineToPixel(anc, topLine)));
        expectingScrollEvent = true;
        window.scrollTo({ top: targetY, behavior: 'instant' });
        // If scrollTo didn't change position, scroll event won't fire; clear via rAF fallback
        requestAnimationFrame(function() { expectingScrollEvent = false; });
    }

    // --- Preview -> Editor sync ---

    /**
     * Calculate the source line from the preview scroll position and notify the editor.
     * Skips notification if the line hasn't changed since last send.
     */
    function previewSyncSource() {
        const anc = ensureAnchors(lastMaxTopLine);
        if (!anc) return;

        const line = Math.round(pixelToLine(anc, window.scrollY));
        if (line === lastSentLine) return;
        lastSentLine = line;
        vscode.postMessage({type: 'revealLine', line: line});
    }

    // --- Event listeners ---

    /**
     * Handle messages from the Extension Host.
     * Dispatches: scrollToLine (editor->preview sync), updateTheme (CSS-only swap),
     * showLoading / hideLoading (render progress overlay).
     *
     * @param {MessageEvent} event - postMessage event from the Extension Host
     */
    window.addEventListener('message', function(event) {
        const message = event.data;
        if (message && message.type === 'scrollToLine') {
            if (syncMaster === 'preview') return;
            setSyncMaster('editor');
            scrollToSourceLine(message.line, message.maxTopLine);
        } else if (message && message.type === 'updateTheme' && typeof message.css === 'string') {
            const styleEl = document.getElementById('theme-css');
            if (styleEl) styleEl.textContent = message.css;
            anchors = null;
        } else if (message && message.type === 'showLoading') {
            if (message.seq !== undefined && message.seq !== RENDER_SEQ) return;
            let overlay = document.getElementById('loading-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'loading-overlay';
                overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;z-index:9999;';
                overlay.innerHTML = '<div style="background:var(--vscode-editor-background,#fff);color:var(--vscode-editor-foreground,#333);padding:12px 24px;border-radius:6px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);">' + RENDERING_TEXT + '</div>';
                document.body.appendChild(overlay);
            }
            overlay.style.display = 'flex';
        } else if (message && message.type === 'hideLoading') {
            const ol = document.getElementById('loading-overlay');
            if (ol) ol.style.display = 'none';
        }
    });

    /**
     * Preview -> Editor scroll sync (50ms throttled, passive).
     * Skips programmatic scrolls (expectingScrollEvent flag) and editor-initiated scrolls.
     * Sends revealLine message to Extension Host with the computed source line.
     */
    let scrollThrottle = null;
    window.addEventListener('scroll', function() {
        if (expectingScrollEvent) { expectingScrollEvent = false; return; }
        if (syncMaster === 'editor') return;
        setSyncMaster('preview');
        if (scrollThrottle) return;
        scrollThrottle = setTimeout(function() {
            scrollThrottle = null;
            if (syncMaster !== 'editor') previewSyncSource();
        }, 50);
    }, { passive: true });

    /** Invalidate the anchor cache when DOM content changes (e.g. re-render, theme swap). */
    const observer = new MutationObserver(function() { anchors = null; });
    observer.observe(document.body, { childList: true, subtree: true });

    /**
     * Invalidate the anchor cache when any image finishes loading, since its
     * rendered height may change from 0 to its natural size, shifting all
     * subsequent anchors.
     */
    function onImageSettled() {
        anchors = null;
        // Re-sync scroll position so the viewport corrects for the layout shift
        if (lastSentLine >= 0 && lastMaxTopLine >= 0) {
            requestAnimationFrame(function() {
                scrollToSourceLine(lastSentLine, lastMaxTopLine);
            });
        } else if (INITIAL_LINE > 0) {
            requestAnimationFrame(function() {
                scrollToSourceLine(INITIAL_LINE, INITIAL_MAX_TOP_LINE);
            });
        }
    }
    function observeImages() {
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            if (!imgs[i].complete) {
                imgs[i].addEventListener('load', onImageSettled, { once: true });
                imgs[i].addEventListener('error', onImageSettled, { once: true });
            }
        }
    }
    observeImages();

    /** Restore scroll position after re-render using values embedded by renderPanel(). */
    if (INITIAL_LINE > 0) {
        window.addEventListener('load', function() {
            requestAnimationFrame(function() {
                scrollToSourceLine(INITIAL_LINE, INITIAL_MAX_TOP_LINE);
            });
        });
    }
})();
</script>`;
}
