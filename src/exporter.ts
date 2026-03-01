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
import { renderAllLocal } from './plantuml.js';
import { renderAllServer } from './plantuml-server.js';
import { escapeHtml, extractPlantUmlBlocks } from './utils.js';
import type { Config } from './config.js';

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
     * @param str - Raw code block content to highlight.
     * @param lang - Language identifier from the fence info string (e.g. 'typescript', 'python').
     * @returns Highlighted HTML wrapped in `<pre class="hljs"><code>`, or empty string for fallback.
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
    /** Webview URI for mermaid.min.js (Webview preview only). */
    mermaidScriptUri?: string;
    /** Mermaid theme name (e.g. 'default', 'dark', 'forest'). */
    mermaidTheme?: string;
    /** Mermaid diagram scale ('auto' or '50%'–'100%'). */
    mermaidScale?: string;
    /** Maximum width of the HTML export body (e.g. '960px', '1200px'). */
    htmlMaxWidth?: string;
    /** HTML export body alignment ('center' or 'left'). */
    htmlAlignment?: string;
}

/**
 * Invalidate the markdown-it cache when path or theme settings change.
 *
 * Compares a composite key of jarPath, javaPath, dotPath, plantumlTheme,
 * renderMode, and serverUrl. When the key differs from the cached one,
 * both markdown-it instances (with and without source map) are discarded.
 *
 * @param config - Current configuration to check against the cache.
 * @returns
 */
function invalidateMdCache(config: Config): void {
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
 * @param config - Configuration used for PlantUML rendering.
 * @param [withSourceMap] - Whether to enable the source_map core rule.
 * @returns Configured markdown-it instance (possibly cached).
 */
function getOrCreateMd(config: Config, withSourceMap?: boolean): MarkdownIt {
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
         * @param state - markdown-it core state containing the token stream.
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
export async function renderHtmlAsync(source: string, title: string, config: Config, options?: RenderOptions, signal?: AbortSignal): Promise<string> {
    const blocks = extractPlantUmlBlocks(source);
    let preRenderedSvgs: Map<string, string> | undefined;

    if (blocks.length > 0) {
        if (config.renderMode === 'server' && config.serverUrl) {
            preRenderedSvgs = await renderAllServer(blocks, config, signal);
        } else {
            preRenderedSvgs = await renderAllLocal(blocks, config, signal);
        }
    }

    // If the signal fired during async rendering the preRenderedSvgs map may be
    // incomplete.  Proceeding to md.render() would cause the fence rule to fall
    // back to synchronous renderToSvg (spawnSync), freezing the extension host.
    if (signal?.aborted) return '';

    const md = getOrCreateMd(config, options?.sourceMap);
    const env: { preRenderedSvgs?: Map<string, string>; plantumlScale?: string } = { preRenderedSvgs, plantumlScale: config.plantumlScale };
    const bodyHtml = md.render(source, env);
    return buildHtml(title, bodyHtml, config.previewTheme, options);
}

/**
 * Export a Markdown file to a standalone HTML file with PlantUML SVG inline embedding.
 *
 * Reads the .md file asynchronously, renders it to HTML (without source map or scripts),
 * and writes the result to the same directory with a .html extension.
 *
 * @param mdFilePath - Absolute path to the Markdown file.
 * @param config - PlantUML and theme configuration.
 * @param [signal] - Optional AbortSignal to cancel in-flight rendering processes.
 * @returns Absolute path of the generated HTML file.
 */
export async function exportToHtml(mdFilePath: string, config: Config, signal?: AbortSignal): Promise<string> {
    const source = await fs.promises.readFile(mdFilePath, 'utf8');
    const exportOptions: RenderOptions = {
        mermaidTheme: config.mermaidTheme,
        mermaidScale: config.mermaidScale,
        htmlMaxWidth: config.htmlMaxWidth,
        htmlAlignment: config.htmlAlignment,
    };
    const fullHtml = await renderHtmlAsync(source, path.basename(mdFilePath, '.md'), config, exportOptions, signal);
    const outputPath = mdFilePath.replace(/\.md$/, '.html');
    await fs.promises.writeFile(outputPath, fullHtml, 'utf8');
    return outputPath;
}

/**
 * Build an optional `<style>` override for HTML export layout.
 *
 * Generates CSS overrides for max-width and alignment when they differ
 * from the base theme defaults (960px centered).
 *
 * @param [htmlMaxWidth] - Body max-width value (e.g. '1200px', 'none').
 * @param [htmlAlignment] - Body alignment ('center' or 'left').
 * @returns Style tag string, or empty string when no overrides are needed.
 */
function buildLayoutOverrideStyle(htmlMaxWidth?: string, htmlAlignment?: string): string {
    const overrides: string[] = [];
    if (htmlMaxWidth && htmlMaxWidth !== '960px') overrides.push(`max-width: ${htmlMaxWidth}`);
    if (htmlAlignment === 'left') overrides.push('margin: 0');
    return overrides.length ? `\n  <style>body { ${overrides.join('; ')}; }</style>` : '';
}

/**
 * Assemble a complete HTML document from rendered body HTML.
 *
 * Inserts theme CSS via `<style id="theme-css">`, optional CSP meta tag
 * (nonce-based script-src), and optional script HTML before `</body>`.
 *
 * @param title - Document title for the <title> tag.
 * @param body - Rendered HTML body content.
 * @param [previewTheme] - Theme key for CSS selection.
 * @param [options] - CSP nonce, script HTML, and CSP source.
 * @returns Complete `<!DOCTYPE html>` document string.
 */
function buildHtml(title: string, body: string, previewTheme?: string, options?: RenderOptions): string {
    const theme = PREVIEW_THEMES[previewTheme || ''] || PREVIEW_THEMES[DEFAULT_PREVIEW_THEME];
    const { scriptHtml, cspNonce, cspSource, lang, allowHttpImages, mermaidScriptUri, mermaidTheme, mermaidScale, htmlMaxWidth, htmlAlignment } = options || {};
    const cspMeta = cspNonce
        ? `\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src ${cspSource || "'self'"} https:${allowHttpImages ? ' http:' : ''} data:; script-src 'nonce-${cspNonce}'${cspSource ? ` ${cspSource}` : ''};">`
        : '';
    const validMermaidThemes = new Set(['default', 'dark', 'forest', 'neutral', 'base']);
    const mermaidThemeValue = validMermaidThemes.has(mermaidTheme || '') ? mermaidTheme! : 'default';
    const scaleNum = mermaidScale && mermaidScale !== 'auto' ? parseFloat(mermaidScale) / 100 : 0;
    const mermaidInitScript = `mermaid.initialize({startOnLoad:false,theme:'${mermaidThemeValue}'});(async function(){var scale=${scaleNum};var els=document.querySelectorAll('pre.mermaid');for(var i=0;i<els.length;i++){var el=els[i];try{var r=await mermaid.render('m'+i,el.textContent||'');el.innerHTML=r.svg}catch(e){var msg=(e.message||String(e)).replace(/</g,'&lt;').replace(/>/g,'&gt;');el.innerHTML='<div class="mermaid-error">'+msg+'</div>'}if(scale>0){var svg=el.querySelector('svg');if(svg){var mw=svg.style.maxWidth;var natW=mw?parseFloat(mw):parseFloat(svg.getAttribute('width'));if(!isNaN(natW)){svg.setAttribute('width',(natW*scale)+'px');svg.style.maxWidth='none';svg.removeAttribute('height');svg.style.height='auto'}}}el.style.visibility='visible'}})();`;
    const hasMermaid = body.includes('mermaid-diagram');
    let mermaidHtml = '';
    if (mermaidScriptUri && cspNonce && hasMermaid) {
        // Webview preview: load from local bundled file
        mermaidHtml = `\n<script nonce="${cspNonce}" src="${mermaidScriptUri}"></script>\n<script nonce="${cspNonce}">${mermaidInitScript}</script>`;
    } else if (hasMermaid && !cspNonce) {
        // HTML export: load from CDN
        mermaidHtml = `\n<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n<script>${mermaidInitScript}</script>`;
    }
    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${cspMeta}
  <title>${escapeHtml(title)}</title>
  <style id="theme-css">
${theme.css}
  </style>${buildLayoutOverrideStyle(htmlMaxWidth, htmlAlignment)}
</head>
<body${cspNonce ? ' class="preview"' : ''}>
${body}${mermaidHtml}
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
 * @param themeName - Theme key to look up.
 * @returns Complete CSS string for the theme.
 */
export function getThemeCss(themeName: string): string {
    const theme = PREVIEW_THEMES[themeName] || PREVIEW_THEMES[DEFAULT_PREVIEW_THEME];
    return theme.css;
}
