/**
 * @module d2-renderer
 * @description D2 diagram renderer using @terrastruct/d2 Wasm.
 *
 * Manages the D2 instance lifecycle and provides SVG rendering functions.
 * D2 runs in a Worker thread via Wasm, so the Extension Host main thread
 * is not blocked.
 */
import { type Config, D2_THEME_MAP } from './config.js';
import { computeHash, escapeHtml, LruCache } from './utils.js';

/** LRU cache for D2 SVG outputs. Keyed by SHA-256 of (themeID, layout, source). */
const D2_CACHE_SIZE = 200;
const d2Cache = new LruCache<string>(D2_CACHE_SIZE);

/** Lazily resolved D2 class constructor. */
let D2Ctor: (new () => D2Instance) | null = null;

/** Shared D2 instance (singleton). */
let d2Instance: D2Instance | null = null;

/** In-flight initD2() promise for deduplication of parallel calls. */
let initPromise: Promise<void> | null = null;

/** D2 instance interface matching @terrastruct/d2 API. */
interface D2Instance {
    ready: Promise<void>;
    compile(source: string | { fs: { index: string }; options?: Record<string, unknown> }, options?: Record<string, unknown>): Promise<{ diagram: Record<string, unknown>; renderOptions: Record<string, unknown> }>;
    render(diagram: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;
}

/**
 * Error patterns that indicate the D2 Wasm instance is permanently broken
 * (e.g. Go runtime out-of-memory panic, dead worker). When matched, the
 * instance is recycled before retrying.
 */
const D2_FATAL_ERROR_PATTERNS = [
    /out of memory/i,
    /memory access out of bounds/i,
    /unreachable/i,
    /WebAssembly\.Memory/i,
    /maximum memory size exceeded/i,
    /worker.*(terminated|exited)/i,
    /channel closed/i,
    /transport.*(closed|race)/i,
];

/**
 * Detect whether an error indicates the D2 Wasm instance itself is broken.
 * D2 syntax errors come back as JSON arrays starting with `[{` and are
 * explicitly excluded — only true infrastructure failures should trigger
 * a recycle.
 */
function isD2InstanceFatalError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('[{')) return false;
    return D2_FATAL_ERROR_PATTERNS.some(re => re.test(msg));
}

/**
 * Dynamically import the D2 class from the copied dist/d2/ directory.
 *
 * We use dynamic import because the D2 package uses Node.js ESM with
 * worker_threads and Wasm, which cannot be bundled by esbuild.
 */
async function getD2Ctor(): Promise<new () => D2Instance> {
    if (D2Ctor) return D2Ctor;
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    // __dirname in the bundled CJS output points to dist/
    const d2IndexPath = path.join(__dirname, 'd2', 'index.js');
    // Windows requires file:// URLs for dynamic import of absolute paths.
    const d2IndexUrl = pathToFileURL(d2IndexPath).href;
    const d2Module = await import(/* webpackIgnore: true */ d2IndexUrl);
    D2Ctor = d2Module.D2;
    if (!D2Ctor) throw new Error('D2 module does not export a D2 class');
    return D2Ctor;
}

/**
 * Initialise the shared D2 instance.
 *
 * Called during extension activate(). The D2 constructor starts Wasm loading
 * in a Worker thread asynchronously — this does NOT block the main thread.
 * The first compile()/render() call will await `this.ready`.
 */
export async function initD2(): Promise<void> {
    if (d2Instance) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const Ctor = await getD2Ctor();
        // D2Ctor (the class constructor) remains valid even if instantiation fails,
        // so we do not clear it here — avoids an unnecessary module re-import.
        d2Instance = new Ctor();
    })();
    try {
        await initPromise;
    } finally {
        initPromise = null;
    }
}

/**
 * Force-terminate the D2 worker thread and discard the instance.
 *
 * D2 v0.1.33 does not expose a public cleanup method; the only reliable way
 * to free the Worker thread (and the Go heap inside its Wasm) is to reach
 * into the internal `worker` field and call `terminate()`. `D2Ctor` is
 * intentionally preserved so the next `initD2()` skips the dynamic import.
 * `initPromise` is also cleared in case a recycle interrupts a concurrent
 * init — the next initD2() should start fresh, not await a dead promise.
 */
async function forceDisposeD2(): Promise<void> {
    if (d2Instance) {
        const inst = d2Instance as unknown as {
            worker?: { terminate?: () => Promise<number> | number };
        };
        try {
            if (inst.worker && typeof inst.worker.terminate === 'function') {
                await Promise.resolve(inst.worker.terminate());
            }
        } catch (err) {
            console.warn('[d2] worker.terminate() failed:', err);
        }
    }
    d2Instance = null;
    initPromise = null;
}

/**
 * Discard the current D2 instance and create a new one. Called after a
 * fatal Wasm error (e.g. Go runtime OOM) leaves the singleton unusable.
 */
async function recycleD2Instance(): Promise<void> {
    await forceDisposeD2();
    await initD2();
}

/**
 * Post-process D2 SVG output for HTML embedding.
 *
 * 1. Strips the XML declaration (`<?xml ...?>`) which is invalid in HTML5.
 * 2. Adds explicit `width`/`height` attributes derived from the `viewBox`
 *    when missing, so the SVG has intrinsic dimensions in inline contexts.
 * @param svg - Raw SVG markup from the D2 renderer.
 * @returns Post-processed SVG markup ready for HTML embedding.
 */
function fixupD2Svg(svg: string): string {
    // Strip XML declaration
    let s = svg.replace(/^<\?xml[^?]*\?>\s*/i, '');
    // Add width/height from viewBox if the root <svg> lacks them
    const openTag = s.match(/^<svg\b[^>]*>/i);
    if (openTag && !openTag[0].includes('width=')) {
        const vb = openTag[0].match(/viewBox="[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)"/);
        if (vb) {
            s = s.replace(/^<svg\b/i, `<svg width="${vb[1]}" height="${vb[2]}"`);
        }
    }
    return s;
}

/**
 * Extract render options from a D2 CompileResult, handling both `renderOptions`
 * and `options` property names (the D2 Wasm API uses `renderOptions` but some
 * versions expose `options` instead).
 *
 * @param result - D2 compile result object.
 * @returns Render options to pass to `d2Instance.render()`.
 */
function getRenderOptions(result: Record<string, unknown>): Record<string, unknown> {
    return ((result as { renderOptions?: Record<string, unknown> }).renderOptions
        ?? (result as Record<string, unknown>).options
        ?? {}) as Record<string, unknown>;
}

/**
 * Render a D2 source string to SVG.
 *
 * Results are cached by (themeID, layout, source) hash. On fatal Wasm errors
 * (Go runtime OOM, dead worker, transport race) the singleton instance is
 * recycled and the render is retried once.
 *
 * @param source - D2 diagram source code.
 * @param themeID - D2 theme number.
 * @param layout - Layout engine ('dagre' or 'elk').
 * @returns SVG markup string.
 */
export async function renderD2ToSvg(source: string, themeID: number, layout: string): Promise<string> {
    const cacheKey = computeHash(String(themeID), layout, source);
    const cached = d2Cache.get(cacheKey);
    if (cached !== undefined) return cached;

    // attempt 0: initial render. attempt 1: post-recycle retry.
    // Every loop body path returns or throws — the loop never falls through.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!d2Instance) await initD2();
        if (!d2Instance) throw new Error('D2 instance failed to initialize');

        try {
            await d2Instance.ready;
            const result = await d2Instance.compile(source, { layout, themeID });
            if (!result || !result.diagram) {
                throw new Error('D2 compile returned no diagram');
            }
            const renderResult = await d2Instance.render(
                result.diagram, getRenderOptions(result),
            );
            if (typeof renderResult === 'string') {
                const svg = fixupD2Svg(renderResult);
                d2Cache.set(cacheKey, svg);
                return svg;
            }
            // Non-string result indicates a Wasm transport race; treat as fatal
            // so the catch block recycles the instance.
            throw new Error('D2 render: transport race (non-string result)');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Syntax errors and incomplete-input markers must surface to the
            // caller without recycling the instance.
            if (msg.startsWith('[{') || msg.includes('returned no diagram')) {
                throw err;
            }
            if (isD2InstanceFatalError(err) && attempt === 0) {
                console.warn(`[d2] recycling instance after fatal error: ${msg}`);
                try {
                    await recycleD2Instance();
                } catch (recycleErr) {
                    throw new Error(
                        `D2 recycle failed: ${recycleErr instanceof Error ? recycleErr.message : recycleErr}`
                    );
                }
                continue;
            }
            throw err;
        }
    }
    // Unreachable: every iteration above either returns, throws, or continues
    // (and continue only happens on attempt 0). Required for the type checker.
    throw new Error('D2 render: unreachable');
}

/**
 * Extract a detailed error message from a D2 error.
 *
 * D2 Wasm compile errors encode details as a JSON array in `err.message`:
 *   `[{"range":"...","errmsg":"index:2:1: connection missing destination"}]`
 * This function parses that format to produce human-readable lines.
 * Falls back to `String(err)` for non-JSON or non-Error values.
 *
 * @param err - The error value thrown by D2 compile/render.
 * @returns Human-readable error message string.
 */
function extractD2ErrorMessage(err: unknown): string {
    if (err == null) return 'Unknown D2 error';
    if (typeof err === 'string') return err;

    const msg = err instanceof Error ? err.message : String(err);

    // D2 Wasm compile errors encode details as a JSON array in err.message:
    //   [{"range":"index,1:0:0-1:4:12","errmsg":"index:2:1: connection missing destination"}]
    // Parse this to show human-readable lines.
    try {
        const parsed = JSON.parse(msg);
        if (Array.isArray(parsed)) {
            const lines = parsed
                .map((e: Record<string, unknown>) =>
                    typeof e.errmsg === 'string' ? e.errmsg : JSON.stringify(e))
                .filter(Boolean);
            if (lines.length > 0) return lines.join('\n');
        }
    } catch {
        // Not JSON — use as-is
    }

    return msg;
}

/**
 * Render all D2 blocks to SVG and return a Map keyed by trimmed source.
 *
 * @param blocks - Array of raw D2 source strings extracted from Markdown.
 * @param config - Extension configuration (d2Theme, d2Layout).
 * @param signal - Optional AbortSignal to cancel rendering.
 * @returns Map from trimmed source to SVG (or error HTML).
 */
export async function renderAllD2(
    blocks: string[], config: Config, signal?: AbortSignal
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const themeID = D2_THEME_MAP.get(config.d2Theme) ?? 0;
    const unique = [...new Set(blocks.map(b => b.trim()))];
    for (const trimmed of unique) {
        if (signal?.aborted) break;
        try {
            const svg = await renderD2ToSvg(trimmed, themeID, config.d2Layout);
            result.set(trimmed, svg);
        } catch (err) {
            const msg = extractD2ErrorMessage(err);
            result.set(trimmed,
                `<div class="d2-error"><strong>D2 Error:</strong><pre>${escapeHtml(msg)}</pre></div>`);
        }
    }
    return result;
}

/**
 * Dispose the shared D2 instance. Called during extension deactivate().
 *
 * Fires off worker termination via {@link forceDisposeD2} but does not await
 * it — `deactivate()` is synchronous, and the host process is exiting anyway.
 */
export function disposeD2(): void {
    void forceDisposeD2();
    D2Ctor = null;
    d2Cache.clear();
}
