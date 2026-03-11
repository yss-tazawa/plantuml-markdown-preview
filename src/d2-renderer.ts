/**
 * @module d2-renderer
 * @description D2 diagram renderer using @terrastruct/d2 Wasm.
 *
 * Manages the D2 instance lifecycle and provides SVG rendering functions.
 * D2 runs in a Worker thread via Wasm, so the Extension Host main thread
 * is not blocked.
 */
import type { Config } from './config.js';
import { D2_THEME_MAP } from './config.js';

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
    d2Instance = new Ctor();
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
    const result = await d2Instance!.compile(source, { layout, themeID });
    return d2Instance!.render(result.diagram, result.renderOptions);
}

/**
 * Escape HTML special characters for safe embedding in error messages.
 */
function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
            const msg = err instanceof Error ? err.message : String(err);
            result.set(block.trim(), `<div class="d2-error">${escapeHtml(msg)}</div>`);
        }
    }
    return result;
}

/**
 * Dispose the shared D2 instance. Called during extension deactivate().
 */
export function disposeD2(): void {
    d2Instance = null;
    D2Ctor = null;
}
