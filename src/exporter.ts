/**
 * @module exporter
 * @description Markdown -> HTML rendering pipeline.
 *
 * Responsibilities:
 * - renderHtmlAsync: Markdown text -> full HTML document (export & preview, unified)
 *   - Pre-renders PlantUML blocks asynchronously (local or server) before md.render()
 *   - When options.sourceMap is true, adds data-source-line attributes for scroll sync
 * - exportToHtml: .md file -> .html file in the same directory
 * - getOrCreateMd: Cached markdown-it instance factory (with/without source map)
 * - buildHtml: Assemble <html> with theme CSS, CSP meta, and optional script
 *
 * Theme CSS is defined in src/themes/ and registered in PREVIEW_THEMES.
 */
import fs from 'fs';
import path from 'path';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { plantumlPlugin } from './renderer.js';
import type { PlantUmlConfig } from './plantuml.js';
import { renderAllLocal } from './plantuml.js';
import { renderAllServer, type ServerConfig } from './plantuml-server.js';
import { escapeHtml, extractPlantUmlBlocks } from './utils.js';

import {
    githubLight, atomLight, oneLight, solarizedLight,
    vue, penPaperCoffee, coy, vs,
    githubDark, atomDark, oneDark, dracula, solarizedDark, monokai,
} from './themes/index.js';

// -----------------------------------------------------------------------
// Preview theme definitions (each theme is in a separate src/themes/ file)
// -----------------------------------------------------------------------

/** Light preview theme keys, ordered for display. */
export const LIGHT_THEME_KEYS = [
    'github-light', 'atom-light', 'one-light', 'solarized-light',
    'vue', 'pen-paper-coffee', 'coy', 'vs',
] as const;

/** Dark preview theme keys, ordered for display. */
export const DARK_THEME_KEYS = [
    'github-dark', 'atom-dark', 'one-dark', 'dracula',
    'solarized-dark', 'monokai',
] as const;

/** Registry mapping theme key to its CSS string. */
const PREVIEW_THEMES: Record<string, { css: string }> = {
    'github-light':    githubLight,
    'atom-light':      atomLight,
    'one-light':       oneLight,
    'solarized-light': solarizedLight,
    'vue':             vue,
    'pen-paper-coffee': penPaperCoffee,
    'coy':             coy,
    'vs':              vs,
    'github-dark':     githubDark,
    'atom-dark':       atomDark,
    'one-dark':        oneDark,
    'dracula':         dracula,
    'solarized-dark':  solarizedDark,
    'monokai':         monokai,
};

/** Default theme used when the user's setting is invalid or missing. */
const DEFAULT_PREVIEW_THEME = 'github-light';

// -----------------------------------------------------------------------
// markdown-it instance cache (reused as long as jarPath + javaPath + dotPath stay the same)
// -----------------------------------------------------------------------

/** Composite key for the current markdown-it cache (jarPath + javaPath + dotPath + plantumlTheme). */
let mdCacheKey = '';
/** Cached markdown-it instance without source map core rule. */
let cachedMd: MarkdownIt | null = null;
/** Cached markdown-it instance with source map core rule. */
let cachedMdSourceMap: MarkdownIt | null = null;

/**
 * Shared markdown-it options used by all instances.
 *
 * - html: Allow raw HTML pass-through
 * - linkify: Auto-detect URLs and convert to links
 * - highlight: Syntax highlight via highlight.js (190+ languages)
 */
const MD_OPTIONS: MarkdownIt.Options = {
    html: true,
    linkify: true,
    typographer: false,
    /**
     * Syntax-highlight a fenced code block using highlight.js.
     *
     * Returns highlighted HTML when the language is recognized by highlight.js,
     * or an empty string to let markdown-it apply its default escaping.
     *
     * @param {string} str - Raw code block content to highlight.
     * @param {string} lang - Language identifier from the fence info string (e.g. 'typescript', 'python').
     * @returns {string} Highlighted HTML wrapped in `<pre class="hljs"><code>`, or empty string for fallback.
     */
    highlight(str, lang) {
        if (lang && hljs.getLanguage(lang)) {
            try {
                return `<pre class="hljs"><code class="language-${lang}">` +
                    hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                    '</code></pre>';
            } catch {
                // Fall back to markdown-it's default escaping on highlight.js failure
            }
        }
        return ''; // Fall back to markdown-it's default escaping
    }
};

/**
 * Configuration for the HTML rendering pipeline.
 *
 * Extends PlantUmlConfig with an additional preview theme property.
 */
export interface ExporterConfig extends PlantUmlConfig {
    /** Preview theme key (e.g. 'github-light', 'dracula'). */
    previewTheme?: string;
    /** Rendering mode: 'local' (Java) or 'server' (HTTP). */
    renderMode: 'local' | 'server';
    /** PlantUML server URL for server mode. */
    serverUrl: string;
}

/** Options for controlling HTML output features. */
export interface RenderOptions {
    /** When true, add data-source-line attributes for scroll sync. */
    sourceMap?: boolean;
    /** HTML string appended before </body> (e.g. scroll sync script). */
    scriptHtml?: string;
    /** CSP nonce for authorizing inline scripts. */
    cspNonce?: string;
    /** Webview CSP source for img-src directive. */
    cspSource?: string;
    /** HTML lang attribute value (e.g. 'en', 'ja'). Defaults to 'en'. */
    lang?: string;
    /** When true, add http: to CSP img-src to allow unencrypted image loading. */
    allowHttpImages?: boolean;
}

/**
 * Invalidate the markdown-it cache when path or theme settings change.
 *
 * Compares a composite key of jarPath, javaPath, dotPath, and plantumlTheme.
 * When the key differs from the cached one, both markdown-it instances
 * (with and without source map) are discarded.
 *
 * @param {ExporterConfig} config - Current configuration to check against the cache.
 */
function invalidateMdCache(config: ExporterConfig): void {
    const key = config.jarPath + '\0' + config.javaPath + '\0' + config.dotPath + '\0' + (config.plantumlTheme || 'default') + '\0' + (config.renderMode || 'local') + '\0' + (config.serverUrl || '');
    if (mdCacheKey !== key) {
        mdCacheKey = key;
        cachedMd = null;
        cachedMdSourceMap = null;
    }
}

/**
 * Return a markdown-it instance with highlight.js and plantumlPlugin applied.
 *
 * When withSourceMap is true, a core rule (`source_map`) is added to attach
 * `data-source-line` attributes to block-level opening tokens and store
 * line numbers in `token.meta.sourceLine` for fence tokens.
 * Cached instances are reused for the same path/theme settings.
 *
 * @param {ExporterConfig} config - Configuration used for PlantUML rendering.
 * @param {boolean} [withSourceMap] - Whether to enable the source_map core rule.
 * @returns {MarkdownIt} Configured markdown-it instance (possibly cached).
 */
function getOrCreateMd(config: ExporterConfig, withSourceMap?: boolean): MarkdownIt {
    invalidateMdCache(config);

    if (withSourceMap) {
        if (cachedMdSourceMap) return cachedMdSourceMap;
    } else {
        if (cachedMd) return cachedMd;
    }

    const md = new MarkdownIt(MD_OPTIONS);
    plantumlPlugin(md, config);

    if (withSourceMap) {
        /**
         * Core rule that attaches data-source-line attributes to block-level tokens.
         *
         * For opening tokens (nesting === 1), sets the `data-source-line` HTML attribute
         * directly on the token. For fence tokens (nesting === 0), stores the line number
         * in `token.meta.sourceLine` so the renderer can wrap the output with the attribute.
         *
         * @param {MarkdownIt.StateCore} state - markdown-it core state containing the token stream.
         */
        md.core.ruler.push('source_map', function (state) {
            for (const token of state.tokens) {
                if (token.map && token.map.length >= 2) {
                    if (token.nesting === 1) {
                        token.attrSet('data-source-line', String(token.map[0]));
                    } else if (token.nesting === 0 && token.type === 'fence') {
                        token.meta = token.meta || {};
                        token.meta.sourceLine = token.map[0];
                    }
                }
            }
        });
        cachedMdSourceMap = md;
    } else {
        cachedMd = md;
    }

    return md;
}

/**
 * Render Markdown to HTML — async variant.
 *
 * Pre-renders all PlantUML blocks asynchronously (local or server mode)
 * before passing them to md.render() via env.preRenderedSvgs, so the
 * synchronous fence rule never needs to call spawnSync.
 *
 * - Server mode: renders all blocks in parallel via PlantUML server.
 * - Local mode: renders blocks sequentially via async spawn to avoid
 *   blocking the extension host event loop.
 *
 * @param source Raw Markdown text.
 * @param title Document title.
 * @param config PlantUML and theme configuration.
 * @param options Optional flags for source map, script injection, and CSP.
 * @param signal Optional AbortSignal to cancel in-flight rendering processes.
 * @returns Complete HTML document string.
 */
export async function renderHtmlAsync(source: string, title: string, config: ExporterConfig, options?: RenderOptions, signal?: AbortSignal): Promise<string> {
    const blocks = extractPlantUmlBlocks(source);
    let preRenderedSvgs: Map<string, string> | undefined;

    if (blocks.length > 0) {
        if (config.renderMode === 'server' && config.serverUrl) {
            const serverConfig: ServerConfig = {
                serverUrl: config.serverUrl,
                plantumlTheme: config.plantumlTheme,
            };
            preRenderedSvgs = await renderAllServer(blocks, serverConfig, signal);
        } else {
            preRenderedSvgs = await renderAllLocal(blocks, config, signal);
        }
    }

    // If the signal fired during async rendering the preRenderedSvgs map may be
    // incomplete.  Proceeding to md.render() would cause the fence rule to fall
    // back to synchronous renderToSvg (spawnSync), freezing the extension host.
    if (signal?.aborted) return '';

    const md = getOrCreateMd(config, options?.sourceMap);
    const env: { preRenderedSvgs?: Map<string, string> } = { preRenderedSvgs };
    const bodyHtml = md.render(source, env);
    return buildHtml(title, bodyHtml, config.previewTheme, options);
}

/**
 * Export a Markdown file to a standalone HTML file with PlantUML SVG inline embedding.
 *
 * Reads the .md file asynchronously, renders it to HTML (without source map or scripts),
 * and writes the result to the same directory with a .html extension.
 *
 * @param {string} mdFilePath - Absolute path to the Markdown file.
 * @param {ExporterConfig} config - PlantUML and theme configuration.
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel in-flight rendering processes.
 * @returns {Promise<string>} Absolute path of the generated HTML file.
 */
export async function exportToHtml(mdFilePath: string, config: ExporterConfig, signal?: AbortSignal): Promise<string> {
    const source = await fs.promises.readFile(mdFilePath, 'utf8');
    const fullHtml = await renderHtmlAsync(source, path.basename(mdFilePath, '.md'), config, undefined, signal);
    const outputPath = mdFilePath.replace(/\.md$/, '.html');
    await fs.promises.writeFile(outputPath, fullHtml, 'utf8');
    return outputPath;
}

/**
 * Assemble a complete HTML document from rendered body HTML.
 *
 * Inserts theme CSS via `<style id="theme-css">`, optional CSP meta tag
 * (nonce-based script-src), and optional script HTML before `</body>`.
 *
 * @param {string} title - Document title for the <title> tag.
 * @param {string} body - Rendered HTML body content.
 * @param {string} [previewTheme] - Theme key for CSS selection.
 * @param {RenderOptions} [options] - CSP nonce, script HTML, and CSP source.
 * @returns {string} Complete `<!DOCTYPE html>` document string.
 */
function buildHtml(title: string, body: string, previewTheme?: string, options?: RenderOptions): string {
    const theme = PREVIEW_THEMES[previewTheme || ''] || PREVIEW_THEMES[DEFAULT_PREVIEW_THEME];
    const { scriptHtml, cspNonce, cspSource, lang, allowHttpImages } = options || {};
    const cspMeta = cspNonce
        ? `\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src ${cspSource || "'self'"} https:${allowHttpImages ? ' http:' : ''} data:; script-src 'nonce-${cspNonce}';">`
        : '';
    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${cspMeta}
  <title>${escapeHtml(title)}</title>
  <style id="theme-css">
${theme.css}
  </style>
</head>
<body${cspNonce ? ' class="preview"' : ''}>
${body}
${scriptHtml || ''}
</body>
</html>`;
}

/**
 * Clear the cached markdown-it instances.
 *
 * Called from deactivate() to release memory when the extension is unloaded.
 */
export function clearMdCache(): void {
    mdCacheKey = '';
    cachedMd = null;
    cachedMdSourceMap = null;
}

/**
 * Return the CSS string for the given preview theme.
 *
 * Falls back to the default theme (github-light) if the given name is not found.
 *
 * @param {string} themeName - Theme key to look up.
 * @returns {string} Complete CSS string for the theme.
 */
export function getThemeCss(themeName: string): string {
    const theme = PREVIEW_THEMES[themeName] || PREVIEW_THEMES[DEFAULT_PREVIEW_THEME];
    return theme.css;
}
