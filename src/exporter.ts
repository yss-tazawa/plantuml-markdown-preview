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
import os from 'os';
import path from 'path';
import url from 'url';
import { execFile } from 'child_process';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { plantumlPlugin } from './renderer.js';
import * as vscode from 'vscode';
import { renderAllLocal } from './plantuml.js';
import { renderAllServer, MAX_LOCAL_SERVER_CONCURRENCY } from './plantuml-server.js';
import { getLocalServerUrl, waitForLocalServer } from './local-server.js';
import { escapeHtml, extractPlantUmlBlocks, extractD2Blocks, errorHtml } from './utils.js';
import { renderAllD2 } from './d2-renderer.js';
import { findBrowser } from './browser-finder.js';
import { MERMAID_THEME_SET, type Config } from './config.js';
import mk from '@traptitech/markdown-it-katex';

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

/** Registry mapping theme key to its CSS string and background color. */
const PREVIEW_THEMES: Record<string, { css: string; bg: string }> = {
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
    /** Tooltip for "Go to top" nav button (preview only). */
    navTopTitle?: string;
    /** Tooltip for "Go to bottom" nav button (preview only). */
    navBottomTitle?: string;
    /** Tooltip for "Reload" nav button (preview only). */
    navReloadTitle?: string;
    /** Tooltip for "TOC" nav button (preview only). */
    navTocTitle?: string;
    /** When true, override scales to auto and remove max-width for fit-to-width layout. */
    fitToWidth?: boolean;
    /** KaTeX CSS <style> block to inject into <head> (already includes @font-face with resolved URIs). */
    katexCssHtml?: string;
    /** When true, relax CSP font-src from 'none' to cspSource for KaTeX fonts. */
    enableMath?: boolean;
    /** When true, add style="visibility:hidden" to <body> for scroll-restore without flash. */
    hideBodyInitially?: boolean;
}

/**
 * Invalidate the markdown-it cache when path or theme settings change.
 *
 * Compares a composite key of plantumlJarPath, javaPath, dotPath, plantumlTheme,
 * renderMode, and plantumlServerUrl. When the key differs from the cached one,
 * both markdown-it instances (with and without source map) are discarded.
 *
 * @param config - Current configuration to check against the cache.
 */
function invalidateMdCache(config: Config): void {
    const key = [
        config.plantumlJarPath,
        config.javaPath,
        config.dotPath,
        config.plantumlTheme || 'default',
        config.renderMode || 'local-server',
        config.plantumlServerUrl || '',
        config.enableMath ? '1' : '0',
    ].join('\0');
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
    if (config.enableMath) {
        md.use(mk, { throwOnError: false, output: 'html' });
    }

    // Add id attributes to headings so that anchor links (#section-name) work
    // in both the preview panel and HTML export.
    /**
     * Core rule that adds id attributes to heading tokens for anchor link navigation.
     *
     * Generates URL-friendly slugs from heading text. When duplicate slugs occur,
     * appends a numeric suffix (e.g. `introduction-1`, `introduction-2`) to ensure
     * each id is unique within the document.
     *
     * @param state - markdown-it core state containing the token stream.
     */
    md.core.ruler.push('heading_ids', function (state) {
        const slugCount = new Map<string, number>();
        for (let i = 0; i < state.tokens.length; i++) {
            const token = state.tokens[i];
            if (token.type === 'heading_open') {
                const inline = state.tokens[i + 1];
                if (inline && inline.type === 'inline' && inline.content) {
                    const slug = inline.content
                        .toLowerCase()
                        .replace(/<[^>]*>/g, '')
                        .replace(/[^\w\s-]/g, '')
                        .replace(/\s+/g, '-')
                        .replace(/-+/g, '-')
                        .replace(/^-|-$/g, '');
                    if (slug) {
                        const count = slugCount.get(slug) ?? 0;
                        slugCount.set(slug, count + 1);
                        token.attrSet('id', count === 0 ? slug : `${slug}-${count}`);
                    }
                }
            }
        }
    });

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
                        token.meta.sourceLineEnd = token.map[1];
                    } else if (token.nesting === 0 && token.type === 'hr') {
                        token.attrSet('data-source-line', String(token.map[0]));
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
 * Render Markdown to body HTML — async variant.
 *
 * Pre-renders all PlantUML blocks asynchronously (local or server mode)
 * before passing them to md.render() via env.preRenderedSvgs, so the
 * synchronous fence rule never needs to call spawnSync.
 *
 * - Server mode: renders all blocks in parallel via PlantUML server.
 * - Local mode: renders blocks sequentially via async spawn to avoid
 *   blocking the extension host event loop.
 *
 * @param source - Raw Markdown text.
 * @param config - PlantUML and theme configuration.
 * @param options - Optional flags for source map, script injection, and CSP.
 * @param signal - Optional AbortSignal to cancel in-flight rendering processes.
 * @returns Object with bodyHtml (rendered HTML string) and hasMermaid flag.
 */
export async function renderBodyAsync(
    source: string, config: Config, options?: RenderOptions, signal?: AbortSignal
): Promise<{ bodyHtml: string; hasMermaid: boolean }> {
    const blocks = extractPlantUmlBlocks(source);
    let preRenderedSvgs: Map<string, string> | undefined;

    if (blocks.length > 0) {
        if (config.renderMode === 'local-server') {
            await waitForLocalServer();
            const localUrl = getLocalServerUrl();
            if (localUrl) {
                const serverConfig = { ...config, plantumlServerUrl: localUrl };
                preRenderedSvgs = await renderAllServer(blocks, serverConfig, signal, MAX_LOCAL_SERVER_CONCURRENCY);
            } else {
                const msg = errorHtml(vscode.l10n.t('Local PlantUML server is not running. Check the output panel for details.'));
                preRenderedSvgs = new Map(blocks.map(b => [b.trim(), msg]));
            }
        } else if (config.renderMode === 'server' && config.plantumlServerUrl) {
            preRenderedSvgs = await renderAllServer(blocks, config, signal);
        } else {
            preRenderedSvgs = await renderAllLocal(blocks, config, signal);
        }
    }

    // --- D2 pre-rendering ---
    const d2Blocks = extractD2Blocks(source);
    let preRenderedD2Svgs: Map<string, string> | undefined;
    if (d2Blocks.length > 0 && !signal?.aborted) {
        preRenderedD2Svgs = await renderAllD2(d2Blocks, config, signal);
    }

    // If the signal fired during async rendering the preRenderedSvgs map may be
    // incomplete.  Proceeding to md.render() would cause the fence rule to fall
    // back to synchronous renderToSvg (spawnSync), freezing the extension host.
    if (signal?.aborted) return { bodyHtml: '', hasMermaid: false };

    const md = getOrCreateMd(config, options?.sourceMap);
    const env: { preRenderedSvgs?: Map<string, string>; preRenderedD2Svgs?: Map<string, string>; plantumlScale?: string; d2Scale?: string } = { preRenderedSvgs, preRenderedD2Svgs, plantumlScale: config.plantumlScale, d2Scale: config.d2Scale };
    const bodyHtml = md.render(source, env);
    return { bodyHtml, hasMermaid: bodyHtml.includes('mermaid-diagram') };
}

/**
 * Render Markdown source to a complete HTML document.
 *
 * Combines {@link renderBodyAsync} and {@link buildHtml} to produce a
 * standalone `<!DOCTYPE html>` page suitable for preview or export.
 *
 * @param source - Raw Markdown text.
 * @param title - Document title for the `<title>` tag.
 * @param config - PlantUML and theme configuration.
 * @param options - Optional flags for source map, script injection, CSP, and Mermaid.
 * @param signal - Optional AbortSignal to cancel in-flight rendering.
 * @returns Complete HTML document string, or empty string if aborted.
 */
export async function renderHtmlAsync(source: string, title: string, config: Config, options?: RenderOptions, signal?: AbortSignal): Promise<string> {
    const { bodyHtml, hasMermaid } = await renderBodyAsync(source, config, options, signal);
    if (signal?.aborted) return '';
    return buildHtml(title, bodyHtml, config.previewTheme, options, hasMermaid);
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
 * @param [fitToWidth] - When true, override diagram scales to auto and apply fit-to-width layout.
 * @returns Absolute path of the generated HTML file.
 */
export async function exportToHtml(mdFilePath: string, config: Config, signal?: AbortSignal, fitToWidth?: boolean): Promise<string> {
    const source = await fs.promises.readFile(mdFilePath, 'utf8');
    const effectiveConfig = fitToWidth ? { ...config, plantumlScale: 'auto', d2Scale: 'auto' } : config;
    const exportOptions: RenderOptions = {
        mermaidTheme: config.mermaidTheme,
        mermaidScale: fitToWidth ? 'auto' : config.mermaidScale,
        htmlMaxWidth: config.htmlMaxWidth,
        htmlAlignment: config.htmlAlignment,
        fitToWidth,
        katexCssHtml: config.enableMath ? await buildKatexCdnCssHtml() : '',
        enableMath: config.enableMath,
    };
    const fullHtml = await renderHtmlAsync(source, path.basename(mdFilePath, '.md'), effectiveConfig, exportOptions, signal);
    const outputPath = mdFilePath.replace(/\.md$/, '.html');
    await fs.promises.writeFile(outputPath, fullHtml, 'utf8');
    return outputPath;
}

/** PDF export timeout in milliseconds. */
const PDF_TIMEOUT_MS = 30_000;

/**
 * Export a Markdown file to PDF using a headless Chromium-based browser.
 *
 * Generates a temporary fit-to-width HTML file, then runs the user's local
 * Chrome / Edge / Chromium in headless mode with `--print-to-pdf`.
 * The temporary HTML file is deleted after conversion.
 *
 * @param mdFilePath - Absolute path to the Markdown file.
 * @param config - PlantUML and theme configuration.
 * @param [signal] - Optional AbortSignal to cancel in-flight rendering.
 * @returns Absolute path of the generated PDF file.
 * @throws When no supported browser is found or when the browser process fails.
 */
export async function exportToPdf(mdFilePath: string, config: Config, signal?: AbortSignal): Promise<string> {
    const browserPath = await findBrowser();
    if (!browserPath) {
        throw new Error(vscode.l10n.t('Chrome, Edge, or Chromium is required for PDF export. No supported browser was found.'));
    }

    // Generate fit-to-width HTML to a temporary file
    const source = await fs.promises.readFile(mdFilePath, 'utf8');
    const effectiveConfig = { ...config, plantumlScale: 'auto', d2Scale: 'auto' };
    const exportOptions: RenderOptions = {
        mermaidTheme: config.mermaidTheme,
        mermaidScale: 'auto',
        htmlMaxWidth: 'none',
        htmlAlignment: config.htmlAlignment,
        fitToWidth: true,
        katexCssHtml: config.enableMath ? await buildKatexCdnCssHtml() : '',
        enableMath: config.enableMath,
    };
    const fullHtml = await renderHtmlAsync(source, path.basename(mdFilePath, '.md'), effectiveConfig, exportOptions, signal);
    if (signal?.aborted) throw new Error('Aborted');

    // Add @page CSS for print margins (insert before </head> to avoid matching </style> in theme CSS)
    const printHtml = fullHtml.replace('</head>', '<style>@page{margin:15mm}</style>\n</head>');

    const tmpHtml = path.join(os.tmpdir(), `plantuml-md-preview-${Date.now()}.html`);
    const outputPath = mdFilePath.replace(/\.md$/, '.pdf');

    try {
        await fs.promises.writeFile(tmpHtml, printHtml, 'utf8');

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const args = [
                '--headless',
                '--disable-gpu',
                `--print-to-pdf=${outputPath}`,
                '--no-pdf-header-footer',
                '--run-all-compositor-stages-before-draw',
                '--virtual-time-budget=5000',
                url.pathToFileURL(tmpHtml).href,
            ];
            const onAbort = () => {
                if (settled) return;
                settled = true;
                proc.kill();
                reject(new Error('Aborted'));
            };
            // timeout: process-level safety net; signal handles user-initiated cancellation
            const proc = execFile(browserPath, args, { timeout: PDF_TIMEOUT_MS }, (err, _stdout, stderr) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                if (err) {
                    const detail = stderr?.trim() || err.message;
                    reject(new Error(vscode.l10n.t('PDF export failed: {0}', detail)));
                } else {
                    resolve();
                }
            });
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });

        return outputPath;
    } finally {
        fs.promises.unlink(tmpHtml).catch(() => {});
    }
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

/** KaTeX version injected at build time from package.json via esbuild define. */
declare const __KATEX_VERSION__: string;
/** Mermaid major version injected at build time from package.json via esbuild define. */
declare const __MERMAID_MAJOR__: string;

/**
 * Build a KaTeX CSS `<style>` block for HTML export using CDN font URLs.
 * Reads katex.min.css from dist/ and replaces relative font paths with CDN URLs.
 * @returns KaTeX CSS style block string. Empty string on read failure.
 */
async function buildKatexCdnCssHtml(): Promise<string> {
    try {
        let css = await fs.promises.readFile(path.join(__dirname, 'katex.min.css'), 'utf-8');
        css = css.replace(/url\(fonts\//g, `url(https://cdn.jsdelivr.net/npm/katex@${__KATEX_VERSION__}/dist/fonts/`);
        return `\n  <style id="katex-css">${css}</style>`;
    } catch { return ''; }
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
 * @param [hasMermaid] - Whether the body contains Mermaid diagrams.
 * @returns Complete `<!DOCTYPE html>` document string.
 */
function buildHtml(title: string, body: string, previewTheme?: string, options?: RenderOptions, hasMermaid?: boolean): string {
    const theme = PREVIEW_THEMES[previewTheme || ''] || PREVIEW_THEMES[DEFAULT_PREVIEW_THEME];
    const {
        scriptHtml, cspNonce, cspSource, lang, allowHttpImages,
        mermaidScriptUri, mermaidTheme, mermaidScale,
        htmlMaxWidth, htmlAlignment,
        navTopTitle, navBottomTitle, navReloadTitle, navTocTitle,
        fitToWidth, katexCssHtml, enableMath, hideBodyInitially,
    } = options || {};
    const fontSrc = enableMath && cspSource ? cspSource : "'none'";
    const cspMeta = cspNonce
        ? `\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src ${fontSrc}; img-src ${cspSource || "'self'"} https:${allowHttpImages ? ' http:' : ''} data:; script-src 'nonce-${cspNonce}'${cspSource ? ` ${cspSource}` : ''};">`
        : '';
    const mermaidThemeValue = MERMAID_THEME_SET.has(mermaidTheme || '') ? mermaidTheme! : 'default';
    const scaleNum = mermaidScale && mermaidScale !== 'auto' ? parseFloat(mermaidScale) / 100 : 0;
    // Mermaid initialization & rendering inline script (minified).
    // 1. mermaid.initialize() — set theme, disable startOnLoad
    // 2. window.__renderMermaid() — iterate pre.mermaid elements, render SVG via mermaid.render(),
    //    apply scale factor to SVG width, show error message on failure
    // 3. Invoke immediately after definition
    const mermaidInitScript =
        `mermaid.initialize({startOnLoad:false,theme:'${mermaidThemeValue}'});` +
        `window.__renderMermaid=async function(){` +
        `var prefix='m'+Date.now()+'_';` +
        `var scale=${scaleNum};` +
        `var els=document.querySelectorAll('pre.mermaid');` +
        `for(var i=0;i<els.length;i++){` +
        `var el=els[i];` +
        `try{var r=await mermaid.render(prefix+i,el.textContent||'');el.innerHTML=r.svg}` +
        `catch(e){var msg=(e.message||String(e)).replace(/</g,'&lt;').replace(/>/g,'&gt;');` +
        `el.innerHTML='<div class="mermaid-error">'+msg+'</div>'}` +
        `/* Remove temp divs mermaid leaves on body (not cleaned up on error) */` +
        `document.querySelectorAll('body>[id^=\"d'+prefix+'\"]').forEach(function(x){x.remove()});` +
        `if(scale>0){var svg=el.querySelector('svg');` +
        `if(svg){var mw=svg.style.maxWidth;` +
        `var natW=mw?parseFloat(mw):parseFloat(svg.getAttribute('width'));` +
        `if(!isNaN(natW)){svg.setAttribute('width',(natW*scale)+'px');` +
        `svg.style.maxWidth='none';svg.removeAttribute('height');svg.style.height='auto'}}}` +
        `el.style.visibility='visible'}};` +
        `window.__renderMermaidDone=window.__renderMermaid();`;
    const includeMermaid = hasMermaid ?? body.includes('mermaid-diagram');
    let mermaidHtml = '';
    if (mermaidScriptUri && cspNonce && includeMermaid) {
        // Webview preview: load from local bundled file
        mermaidHtml = `\n<script nonce="${cspNonce}" src="${mermaidScriptUri}"></script>\n<script nonce="${cspNonce}">${mermaidInitScript}</script>`;
    } else if (includeMermaid && !cspNonce) {
        // HTML export: load from CDN
        mermaidHtml = `\n<script src="https://cdn.jsdelivr.net/npm/mermaid@${__MERMAID_MAJOR__}/dist/mermaid.min.js"></script>\n<script>${mermaidInitScript}</script>`;
    }
    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${cspMeta}
  <title>${escapeHtml(title)}</title>
  <style id="theme-css">
${theme.css}
  </style>${katexCssHtml || ''}${buildLayoutOverrideStyle(htmlMaxWidth, htmlAlignment)}${fitToWidth ? `
  <style>.plantuml-diagram svg{max-width:100%;height:auto}pre.mermaid svg{max-width:100%;height:auto}img{max-width:100%;height:auto}table{width:100%;table-layout:fixed}table td,table th{word-break:break-word;overflow-wrap:break-word}</style>` : ''}${cspNonce ? `
  <style>
#nav-toolbar{position:fixed;top:8px;right:8px;display:flex;gap:2px;z-index:100}
#nav-toolbar button{width:32px;height:32px;border:none;border-radius:4px;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s,opacity 0.15s;padding:0;opacity:0.45}
#nav-toolbar button:hover{opacity:0.85}
#toc-sidebar{position:fixed;top:0;right:0;width:260px;height:100%;z-index:99;overflow-y:auto;padding:44px 0 16px;box-sizing:border-box;display:none;font-size:13px;line-height:1.6}
#toc-sidebar::before{content:'';position:absolute;left:0;top:44px;bottom:16px;width:1px}
#toc-sidebar.open{display:block}
#toc-sidebar ul{list-style:none;margin:0;padding:0}
#toc-sidebar li{position:relative}
#toc-sidebar li>ul{display:none}
#toc-sidebar li.open>ul{display:block}
#toc-sidebar .toc-toggle{position:absolute;top:0;left:2px;width:20px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0.5;font-size:10px;user-select:none;z-index:1}
#toc-sidebar .toc-toggle:hover{opacity:0.8}
#toc-sidebar a{display:block;padding:1px 12px 1px 20px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid transparent;opacity:0.75}
#toc-sidebar a:hover{opacity:1}
#toc-sidebar a.active{opacity:1}
#toc-sidebar>ul>li>a{padding-left:20px}
#toc-sidebar li ul .toc-toggle{left:14px}
#toc-sidebar li ul a{padding-left:32px}
#toc-sidebar li ul li ul .toc-toggle{left:26px}
#toc-sidebar li ul li ul a{padding-left:44px}
#toc-sidebar li ul li ul li ul .toc-toggle{left:38px}
#toc-sidebar li ul li ul li ul a{padding-left:56px}
#toc-sidebar li ul li ul li ul li ul .toc-toggle{left:50px}
#toc-sidebar li ul li ul li ul li ul a{padding-left:68px}
  </style>` : ''}
</head>
<body${cspNonce ? ' class="preview"' : ''}${hideBodyInitially ? ' style="visibility:hidden"' : ''}>
${cspNonce ? `<div id="nav-toolbar">
  <button id="nav-top" title="${escapeHtml(navTopTitle || 'Go to top')}"><svg width="20" height="20" viewBox="0 0 16 16"><path d="M3.5 10L8 5.5 12.5 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <button id="nav-bottom" title="${escapeHtml(navBottomTitle || 'Go to bottom')}"><svg width="20" height="20" viewBox="0 0 16 16"><path d="M3.5 6L8 10.5 12.5 6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <button id="nav-reload" title="${escapeHtml(navReloadTitle || 'Reload')}"><svg width="20" height="20" viewBox="0 0 16 16"><path d="M13 8A5 5 0 1 1 8 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M8 0.5L11 3 8 5.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <button id="nav-toc" title="${escapeHtml(navTocTitle || 'Table of Contents')}"><svg width="20" height="20" viewBox="0 0 16 16"><circle cx="3" cy="4" r="1.2" fill="currentColor"/><line x1="6" y1="4" x2="13" y2="4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="3" cy="8" r="1.2" fill="currentColor"/><line x1="6" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="3" cy="12" r="1.2" fill="currentColor"/><line x1="6" y1="12" x2="13" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
</div>
<div id="toc-sidebar"><ul id="toc-list"></ul></div>
` : ''}<!-- NOTE: This ID is also referenced in src/webview/scroll-sync-webview.ts (applyPendingBodyUpdate). -->
<div id="preview-content">
${body}
</div>${mermaidHtml}
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

/**
 * Get the background color of a preview theme by name.
 *
 * @param themeName - Theme key (e.g. 'github-light'). Falls back to the default theme if unknown.
 * @returns CSS background color string (e.g. '#ffffff').
 */
export function getThemeBgColor(themeName: string): string {
    const theme = PREVIEW_THEMES[themeName] || PREVIEW_THEMES[DEFAULT_PREVIEW_THEME];
    return theme.bg;
}
