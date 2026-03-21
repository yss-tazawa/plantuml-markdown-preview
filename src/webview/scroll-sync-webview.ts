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
interface ExtendedWindow extends Window {
    __loadingTimeout: ReturnType<typeof setTimeout> | null;
    __renderMermaid?: () => Promise<void>;
    __renderMermaidDone?: Promise<void>;
}
const win = window as unknown as ExtendedWindow;

interface Anchor {
    line: number;
    pixel: number;
}

(function () {
    const script = document.currentScript as HTMLScriptElement;
    const INITIAL_LINE = Number(script.dataset.initialLine);
    const INITIAL_MAX_TOP_LINE = Number(script.dataset.initialMaxTopLine);
    const INITIAL_AT_BOTTOM = script.dataset.initialAtBottom === 'true';
    const RENDERING_TEXT = script.dataset.renderingText!;
    const SYNC_MASTER_TIMEOUT_MS = Number(script.dataset.syncMasterTimeoutMs);
    const ENABLE_DIAGRAM_VIEWER = script.dataset.enableDiagramViewer !== 'false';
    /** Offset (px) for TOC active-heading detection: clears the fixed nav-toolbar. */
    const TOC_SCROLL_OFFSET = 60;

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
    let pendingBodyUpdate: { html: string; hasMermaid: boolean; scrollTo: { line: number; maxTopLine: number; atBottom: boolean } | null; themeCss: string | null } | null = null;
    let bodyUpdateTimerId: ReturnType<typeof setTimeout> | null = null;

    /**
     * Set syncMaster and auto-reset to 'none' after timeout.
     * @param who - Origin of the current scroll action ('editor' or 'preview').
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
     * @param maxTopLine - Maximum editor top line for the synthetic tail anchor.
     * @returns Sorted, deduplicated anchor array with monotonic pixel values, or null if no anchors exist.
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
     * @param maxTopLine - Maximum editor top line for the synthetic tail anchor.
     * @returns Cached or freshly built anchor array, or null if no anchors exist.
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
     * @param anc - Sorted anchor array.
     * @param topLine - Source line number to convert.
     * @returns Interpolated pixel offset in the preview.
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
     * @param anc - Sorted anchor array.
     * @param scrollTop - Current scroll position in pixels.
     * @returns Interpolated source line number.
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
     * @param topLine - Editor top line to scroll to.
     * @param maxTopLine - Maximum editor top line for anchor computation.
     * @param [atBottom] - When true, snap to the bottom of the preview.
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

    /**
     * Convert SVG HTML to PNG and either save (send data URL to extension host)
     * or copy (write PNG blob to clipboard).
     *
     * NOTE: This canvas conversion logic is duplicated in pan-zoom-script.ts
     * (handleDiagramAction). The two run in separate webview contexts and
     * cannot share code directly.
     *
     * @param action - 'save' sends data URL to extension host; 'copy' writes to clipboard
     * @param svgHtml - innerHTML string containing an SVG element to convert
     */
    function handleSvgAsPng(action: 'save' | 'copy', svgHtml: string): void {
        var tmp = document.createElement('div');
        tmp.innerHTML = svgHtml;
        var svgEl = tmp.querySelector('svg');
        if (!svgEl) {
            if (action === 'copy') {
                vscode.postMessage({ type: 'copyDiagramFromPreview', success: false, format: 'png' });
            } else {
                vscode.postMessage({ type: 'exportDiagramFromPreview', data: '' });
            }
            return;
        }
        var svgData = new XMLSerializer().serializeToString(svgEl);
        var vb = svgEl.getAttribute('viewBox');
        var w = 100, h = 100;
        if (vb) {
            var parts = vb.split(/[\s,]+/);
            if (parts.length === 4) { w = parseFloat(parts[2]); h = parseFloat(parts[3]); }
        }
        if (!w || !h) {
            w = parseFloat(svgEl.getAttribute('width') || '') || 100;
            h = parseFloat(svgEl.getAttribute('height') || '') || 100;
        }
        var dpr = 2;
        var canvas = document.createElement('canvas');
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
            if (action === 'copy') {
                vscode.postMessage({ type: 'copyDiagramFromPreview', success: false, format: 'png' });
            } else {
                vscode.postMessage({ type: 'exportDiagramFromPreview', data: '' });
            }
            return;
        }
        var img = new Image();
        img.onload = function () {
            ctx!.drawImage(img, 0, 0, canvas.width, canvas.height);
            if (action === 'copy') {
                canvas.toBlob(function (blob) {
                    if (!blob) {
                        vscode.postMessage({ type: 'copyDiagramFromPreview', success: false, format: 'png' });
                        return;
                    }
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () {
                        vscode.postMessage({ type: 'copyDiagramFromPreview', success: true, format: 'png' });
                    }, function () {
                        vscode.postMessage({ type: 'copyDiagramFromPreview', success: false, format: 'png' });
                    });
                }, 'image/png');
            } else {
                try {
                    vscode.postMessage({ type: 'exportDiagramFromPreview', data: canvas.toDataURL('image/png') });
                } catch (e) {
                    vscode.postMessage({ type: 'exportDiagramFromPreview', data: '' });
                }
            }
        };
        img.onerror = function () {
            if (action === 'copy') {
                vscode.postMessage({ type: 'copyDiagramFromPreview', success: false, format: 'png' });
            } else {
                vscode.postMessage({ type: 'exportDiagramFromPreview', data: '' });
            }
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
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
            requestAnimationFrame(notifyDiagramViewers);
        } else if (message && message.type === 'reinitMermaid' && typeof message.theme === 'string') {
            // Re-initialize Mermaid with a new theme so the next __renderMermaid() uses it.
            if (typeof (window as any).mermaid !== 'undefined') {
                (window as any).mermaid.initialize({ startOnLoad: false, theme: message.theme });
            }
        } else if (message && message.type === 'showLoading') {
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
            pendingBodyUpdate = { html: message.html, hasMermaid: !!message.hasMermaid, scrollTo: message.scrollTo || null, themeCss: message.themeCss || null };
            if (!bodyUpdateTimerId) {
                bodyUpdateTimerId = setTimeout(applyPendingBodyUpdate, 0);
            }
        } else if (message && message.type === 'patchDiagrams') {
            // Fast path: update only changed diagrams without full innerHTML replacement.
            // Track scroll offset changes caused by SVG height changes above the viewport.
            var savedScrollY = window.scrollY;

            /**
             * Replace a diagram element's innerHTML and compensate scroll position
             * if the element is above the current viewport.
             */
            function patchElement(el: Element, newHtml: string): void {
                var rect = el.getBoundingClientRect();
                var oldH = el.scrollHeight;
                el.innerHTML = newHtml;
                // If the element is above the viewport, adjust scroll to compensate
                if (rect.bottom < 0) {
                    var delta = el.scrollHeight - oldH;
                    if (delta !== 0) savedScrollY += delta;
                }
            }

            // PlantUML: replace SVG directly
            if (Array.isArray(message.plantuml)) {
                var pumlDiagrams = document.querySelectorAll('.plantuml-diagram');
                for (var pi = 0; pi < message.plantuml.length; pi++) {
                    var pp = message.plantuml[pi];
                    if (pp.index >= 0 && pp.index < pumlDiagrams.length) {
                        patchElement(pumlDiagrams[pp.index], pp.svg);
                    }
                }
            }
            // D2: replace SVG directly
            if (Array.isArray(message.d2)) {
                var d2Diagrams = document.querySelectorAll('.d2-diagram');
                for (var di = 0; di < message.d2.length; di++) {
                    var dp = message.d2[di];
                    if (dp.index >= 0 && dp.index < d2Diagrams.length) {
                        patchElement(d2Diagrams[dp.index], dp.svg);
                    }
                }
            }
            // Mermaid: re-render changed blocks client-side
            if (Array.isArray(message.mermaid) && message.mermaid.length > 0 && typeof win.__renderMermaid === 'function') {
                var mermaidDiagrams = document.querySelectorAll('.mermaid-diagram');
                var mermaidLib = (window as any).mermaid;
                var mPrefix = 'mp' + Date.now() + '_';
                var mScale = typeof message.mermaidScale === 'number' ? message.mermaidScale : 0;
                (async function () {
                    for (var mi = 0; mi < message.mermaid.length; mi++) {
                        var mp = message.mermaid[mi];
                        if (mp.index < 0 || mp.index >= mermaidDiagrams.length) continue;
                        var pre = mermaidDiagrams[mp.index].querySelector('pre.mermaid');
                        if (!pre) continue;
                        var mRect = mermaidDiagrams[mp.index].getBoundingClientRect();
                        var mOldH = mermaidDiagrams[mp.index].scrollHeight;
                        try {
                            var r = await mermaidLib.render(mPrefix + mi, mp.source);
                            pre.innerHTML = r.svg;
                        } catch (e: any) {
                            var emsg = (e.message || String(e)).replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            pre.innerHTML = '<div class="mermaid-error">' + emsg + '</div>';
                        }
                        // Clean up temp divs mermaid leaves on body
                        document.querySelectorAll('body>[id^="d' + mPrefix + '"]').forEach(function (x) { x.remove(); });
                        // Apply scale (same logic as __renderMermaid init script)
                        if (mScale > 0) {
                            var svg = pre.querySelector('svg');
                            if (svg) {
                                var mw = svg.style.maxWidth;
                                var natW = mw ? parseFloat(mw) : parseFloat(svg.getAttribute('width') || '');
                                if (!isNaN(natW)) {
                                    svg.setAttribute('width', (natW * mScale) + 'px');
                                    svg.style.maxWidth = 'none';
                                    svg.removeAttribute('height');
                                    svg.style.height = 'auto';
                                }
                            }
                        }
                        // Compensate scroll for height change above viewport
                        if (mRect.bottom < 0) {
                            var mDelta = mermaidDiagrams[mp.index].scrollHeight - mOldH;
                            if (mDelta !== 0) window.scrollBy(0, mDelta);
                        }
                    }
                })().catch(function () { /* suppress unhandled rejection */ });
            }
            // Restore scroll position after synchronous patches (PlantUML/D2)
            if (savedScrollY !== window.scrollY) {
                window.scrollTo({ top: savedScrollY, behavior: 'instant' });
            }
            anchors = null;
            updateDiagramCursors();
            notifyDiagramViewers();
        } else if (message && message.type === 'exportDiagramAsPng' && typeof message.svg === 'string') {
            handleSvgAsPng('save', message.svg);
        } else if (message && message.type === 'copyDiagramAsPng' && typeof message.svg === 'string') {
            handleSvgAsPng('copy', message.svg);
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
    window.addEventListener('unload', function () { observer.disconnect(); });

    /** Delegated contextmenu handler: store diagram context for Save as PNG/SVG commands. */
    if (ENABLE_DIAGRAM_VIEWER) {
        document.body.addEventListener('contextmenu', function (event) {
            var target = event.target as Element | null;
            if (!target) return;
            var diagram = target.closest('.plantuml-diagram, .mermaid-diagram, .d2-diagram');
            if (!diagram) return;
            var diagrams = document.querySelectorAll('.plantuml-diagram, .mermaid-diagram, .d2-diagram');
            var index = -1;
            for (var i = 0; i < diagrams.length; i++) {
                if (diagrams[i] === diagram) { index = i; break; }
            }
            if (index < 0) return;
            var diagramType = diagram.classList.contains('plantuml-diagram') ? 'plantuml'
                : diagram.classList.contains('mermaid-diagram') ? 'mermaid' : 'd2';
            var plantumlIndex = -1;
            if (diagramType === 'plantuml') {
                var pumlDiagrams = document.querySelectorAll('.plantuml-diagram');
                for (var j = 0; j < pumlDiagrams.length; j++) {
                    if (pumlDiagrams[j] === diagram) { plantumlIndex = j; break; }
                }
            }
            vscode.postMessage({
                type: 'saveDiagramContext',
                svg: (diagram as HTMLElement).innerHTML,
                diagramIndex: index + 1,
                diagramType: diagramType,
                plantumlIndex: plantumlIndex,
                bgColor: getComputedStyle(document.body).backgroundColor
            });
        });
    }

    /** Set data-vscode-context on diagram container elements for context menus.
     *  Preserves the preventDefaultContextMenuItems value set at render time. */
    function updateDiagramCursors(): void {
        if (!ENABLE_DIAGRAM_VIEWER) return;
        var diagrams = document.querySelectorAll('.plantuml-diagram, .mermaid-diagram, .d2-diagram');
        for (var i = 0; i < diagrams.length; i++) {
            var el = diagrams[i] as HTMLElement;
            var type = el.classList.contains('plantuml-diagram') ? 'plantuml'
                : el.classList.contains('mermaid-diagram') ? 'mermaid' : 'd2';
            var hasInclude = el.hasAttribute('data-has-include');
            // Preserve the preventDefaultContextMenuItems value from renderer if already set
            var preventDefault = false;
            var existing = el.getAttribute('data-vscode-context');
            if (existing) {
                try { var parsed = JSON.parse(existing); preventDefault = !!parsed.preventDefaultContextMenuItems; } catch { /* ignore */ }
            }
            var ctx: Record<string, unknown> = { webviewSection: 'diagram', diagramType: type, preventDefaultContextMenuItems: preventDefault };
            if (hasInclude) ctx.hasInclude = true;
            el.setAttribute('data-vscode-context', JSON.stringify(ctx));
        }
    }

    /** Notify extension host of current SVGs so open diagram viewers can update. */
    function notifyDiagramViewers(): void {
        const diagrams = document.querySelectorAll('.plantuml-diagram, .mermaid-diagram, .d2-diagram');
        const bgColor = getComputedStyle(document.body).backgroundColor;
        for (let i = 0; i < diagrams.length; i++) {
            vscode.postMessage({
                type: 'updateDiagramViewer',
                diagramIndex: i + 1,
                svg: diagrams[i].innerHTML,
                bgColor
            });
        }
        vscode.postMessage({ type: 'diagramCount', count: diagrams.length });
    }

    /**
     * Apply the latest pending body update (coalesced via setTimeout).
     * Replaces #preview-content innerHTML, invalidates anchors, re-renders
     * Mermaid diagrams if needed, and observes new images.
     */
    function applyPendingBodyUpdate(): void {
        bodyUpdateTimerId = null;
        if (!pendingBodyUpdate) return;
        const update = pendingBodyUpdate;
        pendingBodyUpdate = null;

        // NOTE: This ID is defined in src/exporter.ts (buildHtml).
        const container = document.getElementById('preview-content');
        if (container) container.innerHTML = update.html;

        if (update.themeCss) {
            const styleEl = document.getElementById('theme-css');
            if (styleEl) styleEl.textContent = update.themeCss;
        }

        anchors = null;

        if (update.hasMermaid && typeof win.__renderMermaid === 'function') {
            win.__renderMermaid().then(function () {
                updateDiagramCursors();
                notifyDiagramViewers();
            }).catch(function () {
                updateDiagramCursors();
                notifyDiagramViewers();
            });
        } else {
            updateDiagramCursors();
            notifyDiagramViewers();
        }

        observeImages();

        // Rebuild TOC if sidebar is open
        if (tocSidebar && tocSidebar.classList.contains('open')) {
            buildToc();
            highlightToc();
        }

        // Restore scroll position after body replacement.
        // scrollTo (explicit) takes priority; otherwise re-sync to the last
        // known position so layout shifts from changed SVGs don't move the viewport.
        if (update.scrollTo) {
            const st = update.scrollTo;
            requestAnimationFrame(function () {
                scrollToSourceLine(st.line, st.maxTopLine, st.atBottom);
            });
        } else if (lastSentLine >= 0 && lastMaxTopLine >= 0) {
            requestAnimationFrame(function () {
                scrollToSourceLine(lastSentLine, lastMaxTopLine);
            });
        }
    }

    /**
     * Invalidate the anchor cache when any image finishes loading or errors.
     * Image rendered height may change from 0 to its natural size, shifting
     * all subsequent anchors. Re-syncs scroll position to correct layout shift.
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
    /** Attach load/error listeners to incomplete images so anchors are rebuilt when they settle. */
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

    // --- Navigation toolbar (top-right) ---
    const navTop = document.getElementById('nav-top');
    const navBottom = document.getElementById('nav-bottom');
    const navToc = document.getElementById('nav-toc');
    const tocSidebar = document.getElementById('toc-sidebar');
    const tocList = document.getElementById('toc-list');

    if (navTop) navTop.addEventListener('click', function () {
        setSyncMaster('preview');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    if (navBottom) navBottom.addEventListener('click', function () {
        setSyncMaster('preview');
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });

    const navReload = document.getElementById('nav-reload');
    if (navReload) navReload.addEventListener('click', function () {
        vscode.postMessage({ type: 'reload' });
    });

    // --- TOC sidebar ---
    interface TocNode { id: string; text: string; level: number; children: TocNode[] }

    /**
     * Build a tree of heading nodes from #preview-content for the TOC sidebar.
     * @returns Nested tree of TocNode objects representing the heading hierarchy.
     */
    function buildTocTree(): TocNode[] {
        const container = document.getElementById('preview-content');
        if (!container) return [];
        const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const root: TocNode[] = [];
        const stack: { level: number; children: TocNode[] }[] = [{ level: 0, children: root }];
        for (let i = 0; i < headings.length; i++) {
            const h = headings[i];
            const level = parseInt(h.tagName[1], 10);
            const id = h.id || ('toc-heading-' + i);
            if (!h.id) h.id = id;
            const node: TocNode = { id, text: h.textContent || '', level, children: [] };
            // Pop stack until we find a parent with lower level
            while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
            stack[stack.length - 1].children.push(node);
            stack.push({ level, children: node.children });
        }
        return root;
    }

    /**
     * Escape a string for use inside an HTML attribute value.
     * @param s - Raw string to escape.
     * @returns Escaped string safe for attribute insertion.
     */
    function escAttr(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

    /**
     * Convert a TocNode tree into nested HTML list items.
     * @param nodes - Array of TocNode objects to render.
     * @returns HTML string of nested `<li>` elements.
     */
    function renderTocHtml(nodes: TocNode[]): string {
        let html = '';
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const hasChildren = n.children.length > 0;
            const escaped = n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            html += '<li class="open">';
            if (hasChildren) html += '<span class="toc-toggle">▼</span>';
            html += '<a href="#' + escAttr(n.id) + '" data-toc-id="' + escAttr(n.id) + '">' + escaped + '</a>';
            if (hasChildren) html += '<ul>' + renderTocHtml(n.children) + '</ul>';
            html += '</li>';
        }
        return html;
    }

    /** Build the TOC sidebar DOM from current headings and attach toggle handlers. */
    function buildToc(): void {
        if (!tocList) return;
        const tree = buildTocTree();
        tocList.innerHTML = renderTocHtml(tree);
        // Attach toggle handlers
        const toggles = tocList.querySelectorAll('.toc-toggle');
        for (let i = 0; i < toggles.length; i++) {
            toggles[i].addEventListener('click', function (e) {
                e.stopPropagation();
                const li = (e.target as HTMLElement).parentElement!;
                li.classList.toggle('open');
                const toggle = e.target as HTMLElement;
                toggle.textContent = li.classList.contains('open') ? '▼' : '▶';
            });
        }
    }

    /** Highlight the TOC entry corresponding to the current scroll position. */
    function highlightToc(): void {
        if (!tocList || !tocSidebar || !tocSidebar.classList.contains('open')) return;
        const links = tocList.querySelectorAll('a[data-toc-id]');
        if (links.length === 0) return;
        let activeId = '';
        const scrollY = window.scrollY + TOC_SCROLL_OFFSET;
        for (let i = links.length - 1; i >= 0; i--) {
            const id = (links[i] as HTMLElement).dataset.tocId!;
            const el = document.getElementById(id);
            if (el && el.getBoundingClientRect().top + window.scrollY <= scrollY) {
                activeId = id;
                break;
            }
        }
        for (let i = 0; i < links.length; i++) {
            const link = links[i] as HTMLElement;
            if (link.dataset.tocId === activeId) {
                link.classList.add('active');
                // Scroll the active item into view within the sidebar
                const sidebar = tocSidebar!;
                const linkTop = link.offsetTop;
                const linkBottom = linkTop + link.offsetHeight;
                if (linkTop < sidebar.scrollTop || linkBottom > sidebar.scrollTop + sidebar.clientHeight) {
                    link.scrollIntoView({ block: 'nearest' });
                }
            } else {
                link.classList.remove('active');
            }
        }
    }

    if (navToc && tocSidebar) {
        navToc.addEventListener('click', function () {
            const isOpen = tocSidebar!.classList.toggle('open');
            navToc!.classList.toggle('active', isOpen);
            if (isOpen) {
                buildToc();
                highlightToc();
            }
        });
        // Click TOC item → scroll to heading
        tocSidebar.addEventListener('click', function (e) {
            const target = (e.target as HTMLElement).closest('a[data-toc-id]') as HTMLElement | null;
            if (!target) return;
            e.preventDefault();
            const id = target.dataset.tocId!;
            const el = document.getElementById(id);
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        });
        // Highlight active TOC item on scroll (throttled)
        let tocHighlightThrottle: ReturnType<typeof setTimeout> | null = null;
        window.addEventListener('scroll', function () {
            if (tocHighlightThrottle) return;
            tocHighlightThrottle = setTimeout(function () {
                tocHighlightThrottle = null;
                highlightToc();
            }, 100);
        }, { passive: true });
    }

    /** Restore scroll position after re-render using values embedded by renderPanel().
     *  Body is already hidden via style="visibility:hidden" on the <body> tag
     *  (set by hideBodyInitially in buildHtml) so the user never sees position 0. */
    if (INITIAL_AT_BOTTOM || INITIAL_LINE > 0) {
        var restoreScroll = function () {
            requestAnimationFrame(function () {
                scrollToSourceLine(INITIAL_LINE, INITIAL_MAX_TOP_LINE, INITIAL_AT_BOTTOM);
                document.body.style.visibility = '';
            });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', restoreScroll);
        } else {
            restoreScroll();
        }
    }

    /** Set diagram cursor styles on initial HTML load. */
    document.addEventListener('DOMContentLoaded', function () {
        var done = win.__renderMermaidDone;
        if (done && typeof done.then === 'function') {
            done.then(function () {
                updateDiagramCursors();
                notifyDiagramViewers();
            });
        } else {
            updateDiagramCursors();
            notifyDiagramViewers();
        }
    });
})();
