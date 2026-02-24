/**
 * @module exporter
 * @description Markdown -> HTML rendering pipeline.
 *
 * Responsibilities:
 * - renderHtml: Markdown text -> full HTML document (export & preview, unified)
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
import { escapeHtml } from './utils.js';

import * as githubLight from './themes/github-light.js';
import * as githubDark from './themes/github-dark.js';
import * as oneDark from './themes/one-dark.js';
import * as dracula from './themes/dracula.js';
import * as solarizedLight from './themes/solarized-light.js';
import * as solarizedDark from './themes/solarized-dark.js';

// -----------------------------------------------------------------------
// Preview theme definitions (each theme is in a separate src/themes/ file)
// -----------------------------------------------------------------------

/** Registry mapping theme key to its CSS string. */
const PREVIEW_THEMES: Record<string, { css: string }> = {
    'github-light':    githubLight,
    'github-dark':     githubDark,
    'one-dark':        oneDark,
    'dracula':         dracula,
    'solarized-light': solarizedLight,
    'solarized-dark':  solarizedDark,
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
    const key = config.jarPath + '\0' + config.javaPath + '\0' + config.dotPath + '\0' + (config.plantumlTheme || 'default');
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
 * Render Markdown text to a complete HTML document string.
 *
 * Combines markdown-it rendering with theme CSS, optional CSP headers,
 * and optional inline script (scroll sync).
 *
 * @param {string} source - Raw Markdown text to render.
 * @param {string} title - Document title (used in <title> and as panel heading).
 * @param {ExporterConfig} config - PlantUML and theme configuration.
 * @param {RenderOptions} [options] - Optional flags for source map, script injection, and CSP.
 * @returns {string} Complete HTML document string.
 */
export function renderHtml(source: string, title: string, config: ExporterConfig, options?: RenderOptions): string {
    const bodyHtml = getOrCreateMd(config, options?.sourceMap).render(source);
    return buildHtml(title, bodyHtml, config.previewTheme, options);
}

/**
 * Export a Markdown file to a standalone HTML file with PlantUML SVG inline embedding.
 *
 * Reads the .md file synchronously, renders it to HTML (without source map or scripts),
 * and writes the result to the same directory with a .html extension.
 *
 * @param {string} mdFilePath - Absolute path to the Markdown file.
 * @param {ExporterConfig} config - PlantUML and theme configuration.
 * @returns {string} Absolute path of the generated HTML file.
 */
export function exportToHtml(mdFilePath: string, config: ExporterConfig): string {
    const source = fs.readFileSync(mdFilePath, 'utf8');
    const fullHtml = renderHtml(source, path.basename(mdFilePath, '.md'), config);
    const outputPath = mdFilePath.replace(/\.md$/, '.html');
    fs.writeFileSync(outputPath, fullHtml, 'utf8');
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
    const { scriptHtml, cspNonce, cspSource, lang } = options || {};
    const cspMeta = cspNonce
        ? `\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${cspSource || "'self'"} https: data:; script-src 'nonce-${cspNonce}';">`
        : '';
    return `<!DOCTYPE html>
<html lang="${lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${cspMeta}
  <title>${escapeHtml(title)}</title>
  <style id="theme-css">
${theme.css}
  </style>
</head>
<body>
${body}
${scriptHtml || ''}
</body>
</html>`;
}

/**
 * Return an array of all registered preview theme keys.
 *
 * @returns {string[]} Theme key strings (e.g. ['github-light', 'github-dark', ...]).
 */
export function getThemeKeys(): string[] {
    return Object.keys(PREVIEW_THEMES);
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
