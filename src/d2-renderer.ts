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
    return D2Ctor!;
}

/**
 * Initialise the shared D2 instance.
 *
 * Called during extension activate(). The D2 constructor starts Wasm loading
 * in a Worker thread asynchronously — this does NOT block the main thread.
 * The first compile()/render() call will await `this.ready`.
 */
export async function initD2(): Promise<void> {
    const Ctor = await getD2Ctor();
    try {
        d2Instance = new Ctor();
    } catch (err) {
        D2Ctor = null;   // clear cache so next call re-imports the module
        throw err;
    }
}

/**
 * Post-process D2 SVG output for HTML embedding.
 *
 * 1. Strips the XML declaration (`<?xml ...?>`) which is invalid in HTML5.
 * 2. Adds explicit `width`/`height` attributes derived from the `viewBox`
 *    when missing, so the SVG has intrinsic dimensions in inline contexts.
 */
function fixupD2Svg(svg: string): string {
    // Strip XML declaration
    let s = svg.replace(/^<\?xml[^?]*\?>\s*/i, '');
    // Add width/height from viewBox if the root <svg> lacks them
    const openTag = s.match(/^<svg\b[^>]*>/i);
    if (openTag && !openTag[0].includes('width=')) {
        const vb = openTag[0].match(/viewBox="[^"]*?([\d.]+)\s+([\d.]+)"/);
        if (vb) {
            s = s.replace(/^<svg\b/i, `<svg width="${vb[1]}" height="${vb[2]}"`);
        }
    }
    return s;
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

    // compile() throws on syntax errors — this does NOT corrupt the instance,
    // so we let the error propagate without discarding d2Instance.
    const result = await d2Instance.compile(source, { layout, themeID });

    if (!result || !result.diagram) {
        throw new Error('D2 compile returned no diagram');
    }

    // CompileResult exposes merged render options as either `renderOptions`
    // (README example) or `options` (API reference). Try both.
    const opts = result.renderOptions
        ?? (result as unknown as Record<string, unknown>).options
        ?? {};

    try {
        const renderResult = await d2Instance.render(
            result.diagram, opts as Record<string, unknown>,
        );

        if (typeof renderResult === 'string') {
            return fixupD2Svg(renderResult);
        }

        // render() returned non-string (Wasm transport race) — retry with fresh instance.
        d2Instance = null;
        await initD2();
        // d2Instance is reassigned inside initD2(); TypeScript cannot track this
        // side-effect across await, so use a type assertion to break narrowing.
        const fresh = d2Instance as D2Instance | null;
        if (!fresh) {
            throw new Error('D2 render failed: could not reinitialise D2 instance');
        }
        const result2 = await fresh.compile(source, { layout, themeID });
        const opts2 = result2.renderOptions
            ?? (result2 as unknown as Record<string, unknown>).options
            ?? {};
        const svg2 = await fresh.render(
            result2.diagram, opts2 as Record<string, unknown>,
        );
        if (typeof svg2 === 'string') {
            return fixupD2Svg(svg2);
        }
        throw new Error('D2 render failed to produce SVG');
    } catch (err) {
        // render failed — instance may be unusable, discard it.
        d2Instance = null;
        throw err;
    }
}

/**
 * Extract a detailed error message from a D2 error.
 *
 * D2 Wasm errors may carry useful details in properties beyond `.message`
 * (e.g. `errs`, `stderr`, `cause`, or be a plain object / string).
 * This function attempts to extract all available information.
 *
 * @param err - The error value thrown by D2 compile/render.
 * @returns Human-readable error message string.
 */
function extractD2ErrorMessage(err: unknown): string {
    if (err == null) return 'Unknown D2 error';
    if (typeof err === 'string') return err;

    const msg = (err as Error).message ?? String(err);

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
    for (const block of blocks) {
        if (signal?.aborted) break;
        try {
            const svg = await renderD2ToSvg(block, themeID, config.d2Layout);
            result.set(block.trim(), svg);
        } catch (err) {
            const msg = extractD2ErrorMessage(err);
            result.set(block.trim(),
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
        if (typeof inst.close === 'function') (inst.close as () => void)();
        else if (typeof inst.terminate === 'function') (inst.terminate as () => void)();
        else if (typeof inst.dispose === 'function') (inst.dispose as () => void)();
    }
    d2Instance = null;
    D2Ctor = null;
}
