/**
 * @module renderer
 * @description markdown-it plugin for PlantUML inline rendering.
 *
 * Replaces ```plantuml fence blocks with inline SVG via plantuml.ts.
 * Non-plantuml fence blocks are optionally wrapped with a data-source-line div
 * (when the source_map core rule in exporter.ts sets token.meta.sourceLine).
 */
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs' with { "resolution-mode": "import" };
import { renderToSvg } from './plantuml.js';
import type { Config } from './config.js';

/** Environment object passed to md.render() for pre-rendered diagram lookup. */
export interface RenderEnv {
    preRenderedSvgs?: Map<string, string>;
    preRenderedD2Svgs?: Map<string, string>;
    plantumlScale?: string;
    d2Scale?: string;
}

/**
 * Scale a PlantUML SVG string according to the configured plantumlScale setting.
 *
 * - '100%' or undefined: no change (natural size)
 * - 'auto': add max-width:100% so oversized diagrams shrink to fit the container
 * - Other percentages: multiply the SVG width by the scale factor and let height auto-adjust
 *
 * @param svg - Raw SVG markup from PlantUML.
 * @param scale - Scale setting value (e.g. '80%', 'auto', '100%').
 * @returns Scaled SVG markup.
 */
function scalePlantUmlSvg(svg: string, scale: string | undefined): string {
    if (!scale || scale === '100%') return svg;
    // The regex patterns below assume PlantUML's SVG output writes inline
    // styles as "width:Xpx;height:Ypx;" in that specific order with separate
    // width/height attributes. Tested against PlantUML v1.2024+.
    if (scale === 'auto') {
        // Keep natural width as fixed size; max-width:100% shrinks when container is narrower
        return svg
            .replace(/style="width:(\d+(?:\.\d+)?)px;height:\d+(?:\.\d+)?px;/,
                     'style="max-width:100%;height:auto;')
            .replace(/\bheight="\d+(?:\.\d+)?(?:px)?"/, 'height="auto"');
    }
    const factor = parseFloat(scale) / 100;
    if (isNaN(factor) || factor <= 0) return svg;
    // Scale both the attribute and inline style dimensions
    return svg
        .replace(/style="width:(\d+(?:\.\d+)?)px;height:\d+(?:\.\d+)?px;/, (_, w) =>
            `style="width:${parseFloat(w) * factor}px;height:auto;`)
        .replace(/\bwidth="(\d+(?:\.\d+)?)(?:px)?"/, (_, w) =>
            `width="${parseFloat(w) * factor}px"`)
        .replace(/\bheight="\d+(?:\.\d+)?(?:px)?"/, 'height="auto"');
}

/**
 * Scale a D2 SVG string according to the configured d2Scale setting.
 *
 * D2 outputs a two-level SVG: an outer `<svg viewBox="0 0 W H">` (no width/height)
 * wrapping an inner `<svg width="W" height="H" viewBox="...">`. Scaling works by
 * adding explicit width/height to the outer `<svg>`.
 *
 * - '100%' or undefined: set width from viewBox so diagram has a defined size
 * - 'auto': max-width:100% shrinks oversized diagrams to fit the container
 * - Other percentages: multiply the viewBox width by the scale factor
 *
 * @param svg - Raw SVG markup from D2.
 * @param scale - Scale setting value (e.g. '80%', 'auto', '100%').
 * @returns Scaled SVG markup.
 */
function scaleD2Svg(svg: string, scale: string | undefined): string {
    if (typeof svg !== 'string') return '';
    // Extract viewBox dimensions from the outer <svg> tag
    const vbMatch = svg.match(/<svg[^>]*\bviewBox="(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/);
    if (!vbMatch) return svg;
    const vbWidth = parseFloat(vbMatch[3]);
    const vbHeight = parseFloat(vbMatch[4]);
    if (!vbWidth || !vbHeight) return svg;

    // Strip any existing width/height attributes added by fixupD2Svg so we
    // can apply the scaled values cleanly (duplicate attrs would be ignored).
    let s = svg.replace(/(<svg\b[^>]*?)\s+width="[^"]*"/, '$1');
    s = s.replace(/(<svg\b[^>]*?)\s+height="[^"]*"/, '$1');

    if (scale === 'auto') {
        // Set natural width but allow shrinking via max-width
        return s.replace(
            /(<svg\b[^>]*)(>)/,
            `$1 width="${vbWidth}" height="${vbHeight}" style="max-width:100%;height:auto;"$2`
        );
    }

    const factor = (scale ? parseFloat(scale) : 100) / 100;
    if (isNaN(factor) || factor <= 0) return s;
    const scaledWidth = vbWidth * factor;
    // Preserve aspect ratio: compute height from the factor
    const scaledHeight = vbHeight * factor;
    return s.replace(
        /(<svg\b[^>]*)(>)/,
        `$1 width="${scaledWidth}" height="${scaledHeight}"$2`
    );
}

/**
 * markdown-it plugin that replaces ```plantuml fence blocks with inline SVG output.
 *
 * Overrides the default `fence` renderer rule:
 * - PlantUML blocks: rendered to SVG via renderToSvg() and wrapped in a
 *   `<div class="plantuml-diagram">` container.
 * - Non-PlantUML blocks: delegated to the original fence rule, optionally
 *   wrapped in a `<div data-source-line="N">` for scroll sync (when the
 *   source_map core rule in exporter.ts sets token.meta.sourceLine).
 *
 * @param md - The markdown-it instance to extend.
 * @param config - PlantUML configuration (jarPath, javaPath, etc.).
 * @returns The same markdown-it instance with the fence rule replaced.
 */
export function plantumlPlugin(md: MarkdownIt, config: Config): MarkdownIt {

    /** Original fence renderer rule, used as fallback for non-PlantUML blocks. */
    const defaultFence = md.renderer.rules.fence || function (tokens: Token[], idx: number, opts: MarkdownIt.Options, _env: unknown, self: { renderToken: (tokens: Token[], idx: number, opts: MarkdownIt.Options) => string }) {
        return self.renderToken(tokens, idx, opts);
    };

    /**
     * Custom fence renderer rule.
     *
     * Routes PlantUML blocks to renderToSvg() and wraps them in a diagram container.
     * Non-PlantUML blocks are delegated to the original fence rule, optionally wrapped
     * with a `data-source-line` div when source map mode is active.
     *
     * @param tokens - Full token array from the markdown-it parse.
     * @param idx - Index of the current fence token.
     * @param opts - markdown-it rendering options.
     * @param env - markdown-it environment sandbox.
     * @param self - Renderer instance with renderToken helper.
     * @returns HTML string for the fence block.
     */
    md.renderer.rules.fence = function (tokens: Token[], idx: number, opts: MarkdownIt.Options, env: unknown, self) {
        const token = tokens[idx];
        const lang = (token.info || '').trim().toLowerCase();
        const sourceLine = token.meta && token.meta.sourceLine != null
            ? token.meta.sourceLine : null;
        const lineAttr = sourceLine != null
            ? ` data-source-line="${sourceLine}"` : '';

        // End-of-fence marker: invisible span at the bottom of the block for scroll sync anchor density
        const sourceLineEnd = token.meta && token.meta.sourceLineEnd != null
            ? token.meta.sourceLineEnd : null;
        const endLineMarker = sourceLineEnd != null
            ? `<span data-source-line="${sourceLineEnd}" style="display:block;height:0;overflow:hidden;"></span>`
            : '';

        /** Pre-render environment passed by the async rendering pipeline. */
        const renderEnv = env as RenderEnv | undefined;

        if (lang === 'mermaid') {
            const escaped = md.utils.escapeHtml(token.content);
            return `<div class="mermaid-diagram"${lineAttr} data-vscode-context='{"webviewSection":"diagram","preventDefaultContextMenuItems":false}'><pre class="mermaid">${escaped}</pre>${endLineMarker}</div>\n`;
        }

        if (lang === 'd2') {
            const rawD2 = renderEnv?.preRenderedD2Svgs?.get(token.content.trim());
            if (rawD2) {
                // Error HTML from renderAllD2 should not be scaled
                const isError = rawD2.startsWith('<div class="d2-error">');
                const svg = isError ? rawD2 : scaleD2Svg(rawD2, renderEnv?.d2Scale ?? config.d2Scale);
                return `<div class="d2-diagram"${lineAttr} data-vscode-context='{"webviewSection":"diagram","preventDefaultContextMenuItems":${isError ? 'false' : 'true'}}'>${svg}${endLineMarker}</div>\n`;
            }
            const escaped = md.utils.escapeHtml(token.content);
            return `<div class="d2-diagram"${lineAttr}><pre class="d2">${escaped}</pre>${endLineMarker}</div>\n`;
        }

        if (lang !== 'plantuml') {
            const defaultOutput = defaultFence(tokens, idx, opts, env, self);
            if (lineAttr) {
                return `<div${lineAttr}>${defaultOutput}${endLineMarker}</div>\n`;
            }
            return defaultOutput;
        }

        // Use pre-rendered SVG from env if available (async pre-render path), otherwise fall back to synchronous local rendering
        const preRendered = renderEnv?.preRenderedSvgs?.get(token.content.trim());
        const rawSvg = preRendered ?? renderToSvg(token.content, config);
        const svg = scalePlantUmlSvg(rawSvg, renderEnv?.plantumlScale ?? config.plantumlScale);
        const hasInclude = /^\s*!include(?:_once|_many|sub)?\s+/m.test(token.content);
        return `<div class="plantuml-diagram"${lineAttr}${hasInclude ? ' data-has-include' : ''} data-vscode-context='{"webviewSection":"diagram","preventDefaultContextMenuItems":false}'>${svg}${endLineMarker}</div>\n`;
    };

    return md;
}
