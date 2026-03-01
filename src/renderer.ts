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

        if (lang === 'mermaid') {
            const escaped = md.utils.escapeHtml(token.content);
            return `<div class="mermaid-diagram"${lineAttr}><pre class="mermaid">${escaped}</pre></div>\n`;
        }

        if (lang !== 'plantuml') {
            const defaultOutput = defaultFence(tokens, idx, opts, env, self);
            if (lineAttr) {
                return `<div${lineAttr}>${defaultOutput}</div>\n`;
            }
            return defaultOutput;
        }

        // Use pre-rendered SVG from env if available (async pre-render path), otherwise fall back to synchronous local rendering
        const renderEnv = env as Record<string, unknown>;
        const preRenderedSvgs = renderEnv?.preRenderedSvgs instanceof Map ? renderEnv.preRenderedSvgs as Map<string, string> : undefined;
        const preRendered = preRenderedSvgs?.get(token.content.trim());
        const rawSvg = preRendered ?? renderToSvg(token.content, config);
        const svg = scalePlantUmlSvg(rawSvg, (renderEnv?.plantumlScale as string | undefined) ?? config.plantumlScale);
        return `<div class="plantuml-diagram"${lineAttr}>${svg}</div>\n`;
    };

    return md;
}
