/**
 * @module scroll-sync-webview
 * @description Webview-side scroll sync script (runs in the browser context).
 *
 * Handles bidirectional scroll sync between editor and preview:
 * - Builds a sparse anchor array from data-source-line attributes ({line, pixel} pairs)
 * - Binary search + linear interpolation for line <-> pixel conversion
 * - syncMaster state machine ('none' | 'editor' | 'preview') prevents feedback loops
 * - expectingScrollEvent flag distinguishes programmatic scroll from user scroll
 * - Restores scroll position after re-render via INITIAL_LINE / INITIAL_MAX_TOP_LINE
 * - MutationObserver invalidates anchors when DOM content changes
 *
 * Dynamic parameters are passed via data-* attributes on the <script> element.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

// Use a typed reference to window for the loading timeout property.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = window as any as Window & { __loadingTimeout: ReturnType<typeof setTimeout> | null; __renderMermaid?: () => void };

interface Anchor {
    line: number;
    pixel: number;
}

(function () {
    const script = document.currentScript as HTMLScriptElement;
    const INITIAL_LINE = Number(script.dataset.initialLine);
    const INITIAL_MAX_TOP_LINE = Number(script.dataset.initialMaxTopLine);
    const INITIAL_AT_BOTTOM = script.dataset.initialAtBottom === 'true';
    const RENDER_SEQ = Number(script.dataset.renderSeq);
    const RENDERING_TEXT = script.dataset.renderingText!;
    const SYNC_MASTER_TIMEOUT_MS = Number(script.dataset.syncMasterTimeoutMs);

    const vscode = acquireVsCodeApi();

    // --- State ---
    let anchors: Anchor[] | null = null;
    let lastMaxTopLine = -1;
    let lastSentLine = -1;
    let expectingScrollEvent = false;

    // syncMaster state machine: 'none' | 'editor' | 'preview'
    type SyncMasterState = 'none' | 'editor' | 'preview';
    let syncMaster: SyncMasterState = 'none';
    let syncMasterTimer: ReturnType<typeof setTimeout> | null = null;

    // Coalescing state for rapid updateBody messages
    let pendingBodyUpdate: { html: string; hasMermaid: boolean; scrollTo: { line: number; maxTopLine: number; atBottom: boolean } | null } | null = null;
    let bodyUpdateRafId: number | null = null;

    /**
     * Set syncMaster and auto-reset to 'none' after timeout.
     */
    function setSyncMaster(who: 'editor' | 'preview'): void {
        syncMaster = who;
        if (syncMasterTimer) clearTimeout(syncMasterTimer);
        syncMasterTimer = setTimeout(function () { syncMaster = 'none'; syncMasterTimer = null; }, SYNC_MASTER_TIMEOUT_MS);
    }

    // --- Anchor-based scroll map ---

    /**
     * Build a sparse anchor array from data-source-line elements in the DOM.
     * Each anchor is a {line, pixel} pair mapping a source line number to a pixel offset in the preview.
     * Uses getBoundingClientRect() + scrollY for absolute positioning (single API call per element,
     * simpler and more robust than manual offsetParent chain traversal).
     * Appends a synthetic tail anchor at maxTopLine to guarantee editor-bottom = preview-bottom.
     */
    function buildAnchors(maxTopLine: number): Anchor[] | null {
        const elements = document.querySelectorAll('[data-source-line]');
        if (elements.length === 0) return null;

        const list: Anchor[] = [{ line: 0, pixel: 0 }];
        const scrollY = window.scrollY;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            // PlantUML SVG contains its own data-source-line attributes
            // (component, use-case, state diagrams). Skip them — SVG layout
            // is aesthetic, not source-order, so these anchors create
            // non-monotonic pixel values causing scroll stutter + jumps.
            // Diagrams use start/end markers for smooth linear interpolation.
            if (el.closest('svg')) continue;
            const line = parseInt(el.getAttribute('data-source-line')!, 10);
            if (!isNaN(line) && line > 0) {
                const offsetTop = Math.round(el.getBoundingClientRect().top + scrollY);
                if (offsetTop > 0) {
                    list.push({ line: line, pixel: offsetTop });
                }
            }
        }

        // Synthetic tail anchor: editor bottom = preview bottom
        if (maxTopLine > 0) {
            const maxScrollTop = Math.max(0, document.body.scrollHeight - window.innerHeight);
            list.push({ line: maxTopLine, pixel: maxScrollTop });
        }

        list.sort(function (a, b) { return a.line - b.line; });

        // Deduplicate (same line number: keep the later entry)
        const deduped: Anchor[] = [list[0]];
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
     */
    function ensureAnchors(maxTopLine: number): Anchor[] | null {
        if (!anchors || maxTopLine !== lastMaxTopLine) {
            lastMaxTopLine = maxTopLine;
            anchors = buildAnchors(maxTopLine);
        }
        return anchors;
    }

    /**
     * Binary search the anchor array and linearly interpolate source line -> pixel position.
     */
    function lineToPixel(anc: Anchor[], topLine: number): number {
        if (anc.length === 0) return 0;
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
     */
    function pixelToLine(anc: Anchor[], scrollTop: number): number {
        if (anc.length === 0) return 0;
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
     */
    function scrollToSourceLine(topLine: number, maxTopLine: number, atBottom?: boolean): void {
        if (atBottom) {
            const ms = Math.max(0, document.body.scrollHeight - window.innerHeight);
            expectingScrollEvent = true;
            window.scrollTo({ top: ms, behavior: 'instant' });
            requestAnimationFrame(function () { expectingScrollEvent = false; });
            return;
        }
        const anc = ensureAnchors(maxTopLine);
        if (!anc) return;

        const targetY = Math.max(0, Math.round(lineToPixel(anc, topLine)));
        expectingScrollEvent = true;
        window.scrollTo({ top: targetY, behavior: 'instant' });
        // If scrollTo didn't change position, scroll event won't fire; clear via rAF fallback
        requestAnimationFrame(function () { expectingScrollEvent = false; });
    }

    // --- Preview -> Editor sync ---

    /**
     * Calculate the source line from the preview scroll position and notify the editor.
     * Skips notification if the line hasn't changed since last send.
     */
    function previewSyncSource(): void {
        const anc = ensureAnchors(lastMaxTopLine);
        if (!anc) return;

        const line = Math.round(pixelToLine(anc, window.scrollY));
        if (line === lastSentLine) return;
        lastSentLine = line;
        vscode.postMessage({ type: 'revealLine', line: line });
    }

    // --- Event listeners ---

    /**
     * Handle messages from the Extension Host.
     * Dispatches: scrollToLine (editor->preview sync), updateTheme (CSS-only swap),
     * showLoading / hideLoading (render progress overlay).
     */
    window.addEventListener('message', function (event: MessageEvent) {
        const message = event.data;
        if (message && message.type === 'scrollToLine') {
            if (syncMaster === 'preview') return;
            setSyncMaster('editor');
            scrollToSourceLine(message.line, message.maxTopLine, message.atBottom);
        } else if (message && message.type === 'updateTheme' && typeof message.css === 'string') {
            const styleEl = document.getElementById('theme-css');
            if (styleEl) styleEl.textContent = message.css;
            anchors = null;
        } else if (message && message.type === 'showLoading') {
            // RENDER_SEQ is set once during the initial full HTML render and is not
            // updated by incremental postMessage updates.  This is safe because the
            // incremental update path never sends showLoading — only the extension
            // host does, and it always includes the current seq.
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
            // Safety timeout: auto-dismiss overlay if hideLoading is never received
            if (win.__loadingTimeout) clearTimeout(win.__loadingTimeout);
            win.__loadingTimeout = setTimeout(function () {
                const ol = document.getElementById('loading-overlay');
                if (ol) ol.style.display = 'none';
                win.__loadingTimeout = null;
            }, 10000);
        } else if (message && message.type === 'hideLoading') {
            if (win.__loadingTimeout) { clearTimeout(win.__loadingTimeout); win.__loadingTimeout = null; }
            const ol = document.getElementById('loading-overlay');
            if (ol) ol.style.display = 'none';
        } else if (message && message.type === 'updateBody' && typeof message.html === 'string') {
            // Dismiss loading overlay immediately
            if (win.__loadingTimeout) { clearTimeout(win.__loadingTimeout); win.__loadingTimeout = null; }
            const ol = document.getElementById('loading-overlay');
            if (ol) ol.style.display = 'none';

            // Coalesce rapid updates: store latest and apply on next animation frame.
            // This prevents intermediate states from flickering when the user types
            // quickly in a large file (each debounce-triggered render completes fast
            // with postMessage, unlike the old full-HTML-replace which was throttled
            // by webview reload latency).
            pendingBodyUpdate = { html: message.html, hasMermaid: !!message.hasMermaid, scrollTo: message.scrollTo || null };
            if (!bodyUpdateRafId) {
                bodyUpdateRafId = requestAnimationFrame(applyPendingBodyUpdate);
            }
        }
    });

    /**
     * Preview -> Editor scroll sync (50ms throttled, passive).
     * Skips programmatic scrolls (expectingScrollEvent flag) and editor-initiated scrolls.
     * Sends revealLine message to Extension Host with the computed source line.
     */
    let scrollThrottle: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('scroll', function () {
        if (expectingScrollEvent) { expectingScrollEvent = false; return; }
        if (syncMaster === 'editor') return;
        setSyncMaster('preview');
        if (scrollThrottle) return;
        scrollThrottle = setTimeout(function () {
            scrollThrottle = null;
            if (syncMaster !== 'editor') previewSyncSource();
        }, 50);
    }, { passive: true });

    /** Invalidate the anchor cache when DOM content changes (e.g. re-render, theme swap). */
    const observer = new MutationObserver(function () { anchors = null; });
    observer.observe(document.body, { childList: true, subtree: true });

    /**
     * Apply the latest pending body update (coalesced via requestAnimationFrame).
     * Replaces #preview-content innerHTML, invalidates anchors, re-renders
     * Mermaid diagrams if needed, and observes new images.
     */
    function applyPendingBodyUpdate(): void {
        bodyUpdateRafId = null;
        if (!pendingBodyUpdate) return;
        const update = pendingBodyUpdate;
        pendingBodyUpdate = null;

        // NOTE: This ID is defined in src/exporter.ts (buildHtml).
        const container = document.getElementById('preview-content');
        if (container) container.innerHTML = update.html;

        anchors = null;

        if (update.hasMermaid && typeof win.__renderMermaid === 'function') {
            win.__renderMermaid();
        }

        observeImages();

        // Scroll to the requested position after file switch
        if (update.scrollTo) {
            const st = update.scrollTo;
            requestAnimationFrame(function () {
                scrollToSourceLine(st.line, st.maxTopLine, st.atBottom);
            });
        }
    }

    /**
     * Invalidate the anchor cache when any image finishes loading, since its
     * rendered height may change from 0 to its natural size, shifting all
     * subsequent anchors.
     */
    function onImageSettled(): void {
        anchors = null;
        // Re-sync scroll position so the viewport corrects for the layout shift
        if (lastSentLine >= 0 && lastMaxTopLine >= 0) {
            requestAnimationFrame(function () {
                scrollToSourceLine(lastSentLine, lastMaxTopLine);
            });
        } else if (INITIAL_LINE > 0) {
            requestAnimationFrame(function () {
                scrollToSourceLine(INITIAL_LINE, INITIAL_MAX_TOP_LINE);
            });
        }
    }
    function observeImages(): void {
        const imgs = document.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
            if (!imgs[i].complete) {
                imgs[i].addEventListener('load', onImageSettled, { once: true });
                imgs[i].addEventListener('error', onImageSettled, { once: true });
            }
        }
    }
    observeImages();

    /** Restore scroll position after re-render using values embedded by renderPanel(). */
    if (INITIAL_AT_BOTTOM || INITIAL_LINE > 0) {
        window.addEventListener('load', function () {
            requestAnimationFrame(function () {
                scrollToSourceLine(INITIAL_LINE, INITIAL_MAX_TOP_LINE, INITIAL_AT_BOTTOM);
            });
        });
    }
})();
