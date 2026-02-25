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
import type { PlantUmlConfig } from './plantuml.js';

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
 * @param {MarkdownIt} md - The markdown-it instance to extend.
 * @param {PlantUmlConfig} config - PlantUML configuration (jarPath, javaPath, etc.).
 * @returns {MarkdownIt} The same markdown-it instance with the fence rule replaced.
 */
export function plantumlPlugin(md: MarkdownIt, config: PlantUmlConfig): MarkdownIt {

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
     * @param {Token[]} tokens - Full token array from the markdown-it parse.
     * @param {number} idx - Index of the current fence token.
     * @param {MarkdownIt.Options} opts - markdown-it rendering options.
     * @param {unknown} env - markdown-it environment sandbox.
     * @param {object} self - Renderer instance with renderToken helper.
     * @returns {string} HTML string for the fence block.
     */
    md.renderer.rules.fence = function (tokens: Token[], idx: number, opts: MarkdownIt.Options, env: unknown, self) {
        const token = tokens[idx];
        const lang = (token.info || '').trim().toLowerCase();
        const sourceLine = token.meta && token.meta.sourceLine != null
            ? token.meta.sourceLine : null;
        const lineAttr = sourceLine != null
            ? ` data-source-line="${sourceLine}"` : '';

        if (lang !== 'plantuml') {
            const defaultOutput = defaultFence(tokens, idx, opts, env, self);
            if (lineAttr) {
                return `<div${lineAttr}>${defaultOutput}</div>\n`;
            }
            return defaultOutput;
        }

        const svg = renderToSvg(token.content, config);
        return `<div class="plantuml-diagram"${lineAttr}>${svg}</div>\n`;
    };

    return md;
}
