/**
 * @module d2-renderer
 * @description D2 diagram renderer using @terrastruct/d2 Wasm.
 *
 * Manages the D2 instance lifecycle and provides SVG rendering functions.
 * D2 runs in a Worker thread via Wasm, so the Extension Host main thread
 * is not blocked.
 */
import { type Config, D2_THEME_MAP } from './config.js';
import { escapeHtml } from './utils.js';

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
 * Dynamically import the D2 class from the copied dist/d2/ directory.
 *
 * We use dynamic import because the D2 package uses Node.js ESM with
 * worker_threads and Wasm, which cannot be bundled by esbuild.
 */
async function getD2Ctor(): Promise<new () => D2Instance> {
    if (D2Ctor) return D2Ctor;
    const path = await import('node:path');
    // __dirname in the bundled CJS output points to dist/
    const d2IndexPath = path.join(__dirname, 'd2', 'index.js');
    const d2Module = await import(/* webpackIgnore: true */ d2IndexPath);
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
 * @param source - D2 diagram source code.
 * @param themeID - D2 theme number.
 * @param layout - Layout engine ('dagre' or 'elk').
 * @returns SVG markup string.
 */
export async function renderD2ToSvg(source: string, themeID: number, layout: string): Promise<string> {
    if (!d2Instance) {
        await initD2();
    }
    if (!d2Instance) {
        throw new Error('D2 instance failed to initialize');
    }

    // Ensure Wasm initialization is complete before compiling.
    await d2Instance.ready;

    // compile() throws on syntax errors — this does NOT corrupt the instance,
    // so we let the error propagate without discarding d2Instance.
    const result = await d2Instance.compile(source, { layout, themeID });

    if (!result || !result.diagram) {
        throw new Error('D2 compile returned no diagram');
    }

    const renderResult = await d2Instance.render(
        result.diagram, getRenderOptions(result),
    );

    if (typeof renderResult === 'string') {
        return fixupD2Svg(renderResult);
    }

    // render() returned non-string (Wasm transport race) — retry with fresh instance.
    d2Instance = null;
    try {
        await initD2();
    } catch (initErr) {
        throw new Error(`D2 render failed: could not reinitialise D2 instance: ${initErr instanceof Error ? initErr.message : initErr}`);
    }
    // d2Instance is reassigned inside initD2(); TypeScript cannot track this
    // side-effect across await, so use a type assertion to break narrowing.
    const fresh = d2Instance as D2Instance | null;
    if (!fresh) {
        throw new Error('D2 render failed: could not reinitialise D2 instance');
    }
    const result2 = await fresh.compile(source, { layout, themeID });
    if (!result2 || !result2.diagram) {
        throw new Error('D2 compile returned no diagram on retry');
    }
    const svg2 = await fresh.render(
        result2.diagram, getRenderOptions(result2),
    );
    if (typeof svg2 === 'string') {
        return fixupD2Svg(svg2);
    }
    throw new Error('D2 render failed to produce SVG');
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
 */
export function disposeD2(): void {
    if (d2Instance) {
        // Attempt to terminate the internal Worker thread if the API exposes a cleanup method
        const inst = d2Instance as unknown as Record<string, unknown>;
        try {
            if (typeof inst.close === 'function') (inst.close as () => void)();
            else if (typeof inst.terminate === 'function') (inst.terminate as () => void)();
            else if (typeof inst.dispose === 'function') (inst.dispose as () => void)();
            else console.warn('[d2] No cleanup method found on D2 instance');
        } catch (err) {
            console.warn('[d2] cleanup failed:', err);
        }
    }
    d2Instance = null;
    D2Ctor = null;
}
