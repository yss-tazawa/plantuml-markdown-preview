/**
 * @module exporter
 * @description Markdown -> HTML rendering pipeline.
 *
 * Responsibilities:
 * - renderHtmlAsync: Markdown text -> full HTML document (export & preview, unified)
 *   - Pre-renders PlantUML blocks asynchronously (local or server) before md.render()
 *   - When options.sourceMap is true, adds data-source-line attributes for scroll sync
 * - exportToHtml: Markdown file -> .html file in the same directory
 * - getOrCreateMd: Cached markdown-it instance factory (with/without source map)
 * - buildHtml: Assemble <html> with theme CSS, CSP meta, and optional script
 *
 * Theme CSS is defined in src/themes/ and registered in PREVIEW_THEMES.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';
import crypto from 'crypto';
import { spawn } from 'child_process';
import http from 'http';
import MarkdownIt, { type Options as MarkdownItOptions } from 'markdown-it';
import hljs from 'highlight.js';
import { plantumlPlugin, type RenderEnv } from './renderer.js';
import * as vscode from 'vscode';
import { renderAllLocal } from './plantuml.js';
import { renderAllServer, MAX_LOCAL_SERVER_CONCURRENCY } from './plantuml-server.js';
import { getLocalServerUrl, waitForLocalServer, ensureLocalServerStarted, localServerUnavailableMessage, handleServerEvent } from './local-server.js';
import { escapeHtml, extractPlantUmlBlocks, extractD2Blocks, errorHtml } from './utils.js';
import { renderAllD2 } from './d2-renderer.js';
import { findBrowser } from './browser-finder.js';
import { exportOutputPath, fileNameWithoutExtension } from './markdown-files.js';
import { MERMAID_THEME_SET, type Config, type PdfPaperSize, type TableWrap } from './config.js';
import katexPlugin, { type MarkdownKatexOptions } from '@vscode/markdown-it-katex';
import taskLists from 'markdown-it-task-lists';
import { strikethroughPlugin, trimAutolinkTrailing, listLooseClassPlugin, footnotePlugin, alertPlugin } from './markdown-rules.js';
import { loadingOverlayHtml } from './loading-overlay.js';
import { shownScriptLoader } from './shown-script-loader.js';
import { mermaidLoadErrorLiteral, SHOW_MERMAID_LOAD_ERROR_SCRIPT } from './mermaid-load-error.js';
import { JUMP_TOP_GAP } from './webview/jump-top-gap.js';

// KaTeX plugin options. throwOnError:false renders invalid math as a katex-error
// display instead of throwing.
const KATEX_OPTIONS: MarkdownKatexOptions = {
    throwOnError: false,
};

import {
    githubLight, atomLight, oneLight, solarizedLight,
    vue, penPaperCoffee, coy, vs,
    githubDark, atomDark, oneDark, dracula, solarizedDark, monokai,
    vscodeLight2026, vscodeDark2026, followVscode,
} from './themes/index.js';

// -----------------------------------------------------------------------
// Preview theme definitions (each theme is in a separate src/themes/ file)
// -----------------------------------------------------------------------

/** Preview theme keys that follow the current VS Code color theme. */
export const VSCODE_THEME_KEYS = ['follow-vscode'] as const;

/** Light preview theme keys, ordered for display. */
export const LIGHT_THEME_KEYS = [
    'github-light', 'atom-light', 'one-light', 'solarized-light',
    'vue', 'pen-paper-coffee', 'coy', 'vs', 'vscode-light-2026',
] as const;

/** Dark preview theme keys, ordered for display. */
export const DARK_THEME_KEYS = [
    'github-dark', 'atom-dark', 'one-dark', 'dracula',
    'solarized-dark', 'monokai', 'vscode-dark-2026',
] as const;

/** Registry mapping theme key to its CSS string and background color. */
const PREVIEW_THEMES: Record<string, { css: string; bg: string }> = {
    'follow-vscode':     followVscode,
    'github-light':      githubLight,
    'atom-light':        atomLight,
    'one-light':         oneLight,
    'solarized-light':   solarizedLight,
    'vue':               vue,
    'pen-paper-coffee':  penPaperCoffee,
    'coy':               coy,
    'vs':                vs,
    'github-dark':       githubDark,
    'atom-dark':         atomDark,
    'one-dark':          oneDark,
    'dracula':           dracula,
    'solarized-dark':    solarizedDark,
    'monokai':           monokai,
    'vscode-light-2026': vscodeLight2026,
    'vscode-dark-2026':  vscodeDark2026,
};

/** Default theme used when the user's setting is invalid or missing. */
const DEFAULT_PREVIEW_THEME = 'github-light';

/**
 * Resolve the theme used when writing HTML or PDF outside VS Code.
 *
 * The `follow-vscode` theme reads VS Code's CSS variables, which an exported file does not
 * have, so it is replaced by the fixed VS Code 2026 theme matching the color theme
 * kind at export time (high contrast counts as its light or dark side).
 *
 * @param themeName - Configured preview theme key.
 * @param [kind] - Color theme kind; defaults to the active VS Code color theme.
 * @returns Theme key to export with.
 */
export function resolveExportTheme(themeName: string, kind?: vscode.ColorThemeKind): string {
    if (themeName !== 'follow-vscode') return themeName;
    const k = kind ?? vscode.window.activeColorTheme.kind;
    return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight
        ? 'vscode-light-2026'
        : 'vscode-dark-2026';
}

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
const MD_OPTIONS: MarkdownItOptions = {
    html: true,
    linkify: true,
    typographer: false,
    /**
     * Syntax-highlight a fenced code block using highlight.js.
     *
     * Returns highlighted HTML when the language is recognized by highlight.js,
     * and otherwise (no language, an unknown one, or a highlight.js failure) the
     * escaped code in the same wrapper, so every code block gets the `.hljs`
     * background and text color of the theme.
     *
     * @param str - Raw code block content to highlight.
     * @param lang - Language identifier from the fence info string (e.g. 'typescript', 'python').
     * @returns HTML wrapped in `<pre class="hljs"><code>`.
     */
    highlight(str, lang) {
        if (lang && hljs.getLanguage(lang)) {
            try {
                return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">` +
                    hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                    '</code></pre>';
            } catch {
                // Fall through to the plain wrapper on highlight.js failure
            }
        }
        const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        return `<pre class="hljs"><code${langClass}>${escapeHtml(str)}</code></pre>`;
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
    /** When true, override scales to auto and apply 100% fit-to-width layout. When a number, apply max-width in pixels. */
    fitToWidth?: boolean | number;
    /** Alignment when fitToWidth is a number. 'center' (default) or 'left'. */
    fitToWidthAlign?: 'center' | 'left';
    /**
     * How wide tables wrap (HTML export only; unset keeps the theme's `words`). `characters` breaks CJK text
     * between characters again, so wide tables narrow to the body width. `none` never wraps cell text (only
     * `<br>` breaks lines) and lets tables grow past the body to the right, up to the window, then scroll.
     */
    tableWrap?: TableWrap;
    /** KaTeX CSS <style> block to inject into <head> (already includes @font-face with resolved URIs). */
    katexCssHtml?: string;
    /** When true, relax CSP font-src from 'none' to cspSource for KaTeX fonts. */
    enableMath?: boolean;
    /** When true, add style="visibility:hidden" to <body> for scroll-restore without flash. */
    hideBodyInitially?: boolean;
    /** When set, the page starts under the loading overlay with this text, shown before its scripts load. */
    loadingText?: string;
    /** Preview zoom (%) applied as CSS `zoom` on #preview-content (preview only; exports never pass it). */
    previewZoom?: number;
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
 * Cached instances are reused for the same path/theme settings, and recreated when the
 * cache is empty or was discarded by {@link invalidateMdCache}.
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
    // GitHub-style autolink ends, `~`/`~~` strikethrough, footnotes and loose-list class (see markdown-rules.ts).
    trimAutolinkTrailing(md);
    md.use(strikethroughPlugin);
    // GFM task lists as read-only checkboxes: enabled: false keeps the `disabled` attribute,
    // since the preview never edits the document.
    md.use(taskLists, { enabled: false, label: false });
    md.use(footnotePlugin);
    md.use(listLooseClassPlugin);
    plantumlPlugin(md, config);
    if (config.enableMath) {
        md.use(katexPlugin, KATEX_OPTIONS);
    }
    // GitHub-style alerts (> [!NOTE] etc.). Emits the same markup GitHub uses
    // (div.markdown-alert + p.markdown-alert-title); styled per theme in themes/base.ts.
    md.use(alertPlugin);

    /**
     * Indented code block renderer: the same `<pre class="hljs"><code>` wrapper the
     * highlight option gives fenced blocks, so both take the theme's code block colors.
     *
     * @param tokens - Full token array from the markdown-it parse.
     * @param idx - Index of the current code_block token.
     * @returns HTML string for the code block.
     */
    md.renderer.rules.code_block = function (tokens, idx) {
        return `<pre class="hljs"><code>${escapeHtml(tokens[idx].content)}</code></pre>\n`;
    };

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
                        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
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
         * Tokens inside the footnote section get no line: markdown-it-footnote moves the
         * definitions to the end of the document, and their lines would pin every later
         * line to the end in scroll sync.
         *
         * @param state - markdown-it core state containing the token stream.
         */
        md.core.ruler.push('source_map', function (state) {
            let inFootnotes = false;
            for (const token of state.tokens) {
                if (token.type === 'footnote_block_open') inFootnotes = true;
                else if (token.type === 'footnote_block_close') inFootnotes = false;
                if (inFootnotes) continue;
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
            // In lazy mode this render request is the first-start trigger (idempotent).
            ensureLocalServerStarted(config);
            await waitForLocalServer();
            const localUrl = getLocalServerUrl();
            if (localUrl) {
                const serverConfig = { ...config, plantumlServerUrl: localUrl };
                preRenderedSvgs = await renderAllServer(blocks, serverConfig, signal, MAX_LOCAL_SERVER_CONCURRENCY);
            } else {
                const msg = errorHtml(localServerUnavailableMessage(config));
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
    const env: RenderEnv = { preRenderedSvgs, preRenderedD2Svgs, plantumlScale: config.plantumlScale, d2Scale: config.d2Scale };
    const bodyHtml = md.render(source, env);
    return { bodyHtml, hasMermaid: bodyHtml.includes('mermaid-diagram') };
}

/**
 * Report an export of a document with PlantUML diagrams to the local server as an
 * event ({@link handleServerEvent}), before its render: a server that stopped
 * retrying starts again, and the render waits for that start.
 *
 * @param source - Markdown text being exported.
 * @param config - Current extension settings.
 */
export function handleExportEvent(source: string, config: Config): void {
    if (extractPlantUmlBlocks(source).length > 0) handleServerEvent(config, { checkJava: true });
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
 * Build the export output path next to the source file.
 *
 * @param mdFilePath - Absolute path to the Markdown file.
 * @param extension - Output extension with the dot.
 * @returns Absolute output path.
 * @throws When the output path is the source file itself, so the export never overwrites its source.
 */
function requireOutputPath(mdFilePath: string, extension: string): string {
    const outputPath = exportOutputPath(mdFilePath, extension);
    if (!outputPath) {
        throw new Error(vscode.l10n.t('The output file would overwrite the source file: {0}', mdFilePath));
    }
    return outputPath;
}

/**
 * Export a Markdown file to a standalone HTML file with PlantUML SVG inline embedding.
 *
 * Reads the Markdown file asynchronously, renders it to HTML (without source map or scripts),
 * and writes the result to the same directory with a .html extension.
 *
 * @param mdFilePath - Absolute path to the Markdown file.
 * @param config - PlantUML and theme configuration.
 * @param [signal] - Optional AbortSignal to cancel in-flight rendering processes.
 * @param [fitToWidth] - When true, override diagram scales to auto and apply 100% fit-to-width layout. When a number, apply max-width in pixels.
 * @param [fitToWidthAlign] - Alignment when fitToWidth is a number. 'center' (default) or 'left'.
 * @returns Absolute path of the generated HTML file.
 */
export async function exportToHtml(mdFilePath: string, config: Config, signal?: AbortSignal, fitToWidth?: boolean | number, fitToWidthAlign?: 'center' | 'left'): Promise<string> {
    const outputPath = requireOutputPath(mdFilePath, '.html');
    const source = await fs.promises.readFile(mdFilePath, 'utf8');
    handleExportEvent(source, config);
    const exportOptions: RenderOptions = {
        mermaidTheme: config.mermaidTheme,
        mermaidScale: config.mermaidScale,
        htmlMaxWidth: config.htmlMaxWidth,
        htmlAlignment: config.htmlAlignment,
        fitToWidth,
        fitToWidthAlign,
        // The responsive export (fitToWidth true) fits everything to the window, tables included.
        tableWrap: fitToWidth === true ? 'characters' : config.htmlTableWrap,
        katexCssHtml: config.enableMath ? await buildKatexCdnCssHtml() : '',
        enableMath: config.enableMath,
    };
    const exportConfig = { ...config, previewTheme: resolveExportTheme(config.previewTheme) };
    const fullHtml = await renderHtmlAsync(source, fileNameWithoutExtension(mdFilePath), exportConfig, exportOptions, signal);
    if (signal?.aborted || !fullHtml) throw new Error('Aborted');
    await fs.promises.writeFile(outputPath, fullHtml, 'utf8');
    return outputPath;
}

/** PDF export timeout in milliseconds. */
const PDF_TIMEOUT_MS = 30_000;

/** Page margin of the PDF, in millimeters (the `@page` rule of pdfPageCss). */
const PDF_MARGIN_MM = 15;

/**
 * Paper of each `pdfPaperSize` value: its name in the CSS `@page` `size` property and its
 * portrait width and height in millimeters. The printed content width is the paper width
 * (the height when landscape) less the page margins.
 */
const PDF_PAPERS: Readonly<Record<PdfPaperSize, { readonly cssName: string; readonly widthMm: number; readonly heightMm: number }>> = {
    A4: { cssName: 'A4', widthMm: 210, heightMm: 297 },
    Letter: { cssName: 'letter', widthMm: 215.9, heightMm: 279.4 },
    Legal: { cssName: 'legal', widthMm: 215.9, heightMm: 355.6 },
    A3: { cssName: 'A3', widthMm: 297, heightMm: 420 },
    A5: { cssName: 'A5', widthMm: 148, heightMm: 210 },
};

/**
 * Build the `@page` rule of the PDF: the paper, its orientation and the page margins.
 * printToPDF is called with preferCSSPageSize, so this rule alone decides the paper and the
 * orientation (printToPDF's own landscape flag has no effect then).
 *
 * @param paperSize - Paper size to print on.
 * @param landscape - Whether the page is landscape.
 * @returns The `@page` rule.
 */
export function pdfPageCss(paperSize: PdfPaperSize, landscape: boolean): string {
    const size = PDF_PAPERS[paperSize].cssName + (landscape ? ' landscape' : '');
    return `@page{size:${size};margin:${PDF_MARGIN_MM}mm}`;
}

/**
 * Print-only CSS for the PDF. Paper cannot scroll, so content that scrolls sideways on screen
 * has to fit the page instead. Text keeps its size where it can: long code lines wrap (not the
 * Mermaid source, whose labels would inherit it), and PDF_FIT_SCRIPT breaks long words only in
 * the body cells of a table that does not fit (`pdf-break`; header cells stay whole).
 * Tables and display math that still overflow are shrunk by PDF_FIT_SCRIPT, like diagrams.
 * CJK text in tables breaks between characters again (`word-break: normal`), as on GitHub: the theme
 * keeps it whole (`keep-all`) so that wide tables scroll on screen. This also covers tables inside
 * diagrams, which the theme rule reaches too.
 * The body drops the preview's own padding, so the page margins of pdfPageCss are the only room
 * around the text and the content is exactly as wide as pdfContentWidthPx.
 * HTML export keeps the screen shapes (content-wide tables that scroll).
 */
export const PDF_PRINT_CSS = 'body{padding:0}pre:not(.mermaid):not(:where(svg *)){white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible}'
    + 'table:not(:where(svg *)){overflow:visible}table{word-break:normal}td.pdf-break:not(:where(svg *)){overflow-wrap:anywhere}'
    + '.katex-display:not(:where(svg *)){overflow:visible}';

/**
 * Script run in the page before printing, evaluated with the printed content width in CSS
 * pixels as `w`. It lays the page out at that width and, for each table that is wider than
 * the page, lets long words break in its widest body cells first, one column width at a time,
 * stopping as soon as the table fits (short words in narrow columns stay whole). A table that
 * breaking cannot fit (its header cells are too wide) breaks no words at all; it is shrunk with
 * `zoom`, as is a display formula that is too wide (a numbered formula is measured with room for
 * its number, so the number never overlaps it). The zoom is measured again because borders do
 * not shrink below 1px. The width is given back at the end. A table inside a table is fitted with
 * the outer one; a formula inside a table cell is fitted after the table, so the table may shrink a
 * little more than needed (rare).
 */
export const PDF_FIT_SCRIPT = `(w => {
    if (!(w > 0)) return false;
    const root = document.documentElement;
    const prev = root.style.width;
    root.style.width = w + 'px';
    try {
        const boxes = document.querySelectorAll('#preview-content table:not(:where(svg *)), #preview-content .katex-display:not(:where(svg *))');
        for (const el of boxes) {
            // A nested table is fitted with the table it is in.
            if (el.tagName === 'TABLE' && el.parentElement && el.parentElement.closest('#preview-content table')) continue;
            // A numbered formula (\\tag) has its number absolutely placed at the right, outside scrollWidth:
            // measure the formula (all its lines) plus twice the number's width, so the number never overlaps
            // the shrunk formula. KaTeX 0.16 names them .tag and .base, KaTeX 0.19 .katex-tag and .katex-base.
            const tag = el.matches('.katex-display') ? el.querySelector('.katex-html > :is(.tag, .katex-tag)') : null;
            const ratio = () => {
                if (!tag) return el.scrollWidth / el.clientWidth;
                const rects = [...el.querySelectorAll('.katex-html > :is(.base, .katex-base)')].map(b => b.getBoundingClientRect());
                if (!rects.length) return 1;
                const left = Math.min(...rects.map(r => r.left));
                const right = Math.max(...rects.map(r => r.right));
                return (right - left + 2 * tag.getBoundingClientRect().width) / el.getBoundingClientRect().width;
            };
            const over = () => el.clientWidth > 0 && (tag ? ratio() > 1.001 : el.scrollWidth > el.clientWidth + 1);
            if (el.tagName === 'TABLE') {
                let rest = [...el.querySelectorAll('td:not(:where(svg *))')];
                while (over() && rest.length) {
                    // Measure all widths first: marking a cell changes the widths of the others in its column.
                    const widths = rest.map(c => c.offsetWidth);
                    const widest = Math.max(...widths);
                    for (const c of rest.filter((_, i) => widths[i] >= widest - 1)) c.classList.add('pdf-break');
                    rest = rest.filter(c => !c.classList.contains('pdf-break'));
                }
                // Breaking did not make it fit (its header cells are too wide): unbreak and shrink instead.
                if (over()) for (const c of el.querySelectorAll('td.pdf-break')) c.classList.remove('pdf-break');
            }
            let zoom = 1;
            for (let i = 0; i < 3 && over(); i++) {
                zoom /= ratio();
                el.style.zoom = String(zoom);
            }
        }
    } finally {
        root.style.width = prev;
    }
    return true;
})`;

/**
 * Width in CSS pixels that the printed content is laid out at: the paper width (the height
 * when landscape) less the page margins, divided by the print scale (Chrome lays the page out
 * at paper size / scale). The paper is the one pdfPageCss sets.
 *
 * @param scale - Print scale passed to printToPDF.
 * @param landscape - Whether the page is landscape.
 * @param paperSize - Paper size to print on.
 * @returns Content width in CSS pixels.
 */
export function pdfContentWidthPx(scale: number, landscape: boolean, paperSize: PdfPaperSize): number {
    const paper = PDF_PAPERS[paperSize];
    const paperMm = landscape ? paper.heightMm : paper.widthMm;
    return (((paperMm - PDF_MARGIN_MM * 2) / 25.4) * 96) / scale;
}

/**
 * Make an HTTP GET request and return the response body as a string.
 */
function httpGet(reqUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(reqUrl, res => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Minimal CDP client over raw WebSocket (no external dependency).
 * Supports sending multiple commands on a single connection.
 */
class CdpConnection {
    private socket!: import('net').Socket;
    private buf = Buffer.alloc(0);
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    private msgBuf = ''; // accumulates text across continuation frames

    static connect(wsUrl: string): Promise<CdpConnection> {
        return new Promise((resolve, reject) => {
            const conn = new CdpConnection();
            const parsed = new URL(wsUrl);
            const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
            const req = http.request({
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                headers: {
                    'Upgrade': 'websocket',
                    'Connection': 'Upgrade',
                    'Sec-WebSocket-Key': key,
                    'Sec-WebSocket-Version': '13',
                },
            });
            req.on('upgrade', (_res, socket) => {
                conn.socket = socket;
                socket.on('data', (chunk: Buffer) => conn.onData(chunk));
                socket.on('error', e => {
                    for (const p of conn.pending.values()) p.reject(e);
                    conn.pending.clear();
                });
                resolve(conn);
            });
            req.on('error', reject);
            req.end();
        });
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            const payload = Buffer.from(JSON.stringify({ id, method, params }));
            // Build masked WebSocket frame (client must mask)
            let header: Buffer;
            if (payload.length < 126) {
                header = Buffer.alloc(6);
                header[0] = 0x81;
                header[1] = 0x80 | payload.length;
            } else if (payload.length < 65536) {
                header = Buffer.alloc(8);
                header[0] = 0x81;
                header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
            } else {
                header = Buffer.alloc(14);
                header[0] = 0x81;
                header[1] = 0x80 | 127;
                // Write 64-bit length (high 32 bits then low 32 bits)
                header.writeUInt32BE(0, 2);
                header.writeUInt32BE(payload.length, 6);
            }
            // Mask key = 0 (simplest valid mask)
            const maskOffset = header.length - 4;
            header[maskOffset] = 0; header[maskOffset + 1] = 0;
            header[maskOffset + 2] = 0; header[maskOffset + 3] = 0;
            this.socket.write(Buffer.concat([header, payload]));
        });
    }

    close(): void { this.socket.destroy(); }

    private onData(chunk: Buffer): void {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (this.buf.length >= 2) {
            const fin = (this.buf[0] & 0x80) !== 0;
            const opcode = this.buf[0] & 0x0f;
            let payloadLen = this.buf[1] & 0x7f;
            let offset = 2;
            if (payloadLen === 126) {
                if (this.buf.length < 4) return;
                payloadLen = this.buf.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (this.buf.length < 10) return;
                // Read 64-bit length (ignore high 32 bits — safe for < 4GB)
                payloadLen = this.buf.readUInt32BE(6);
                offset = 10;
            }
            if (this.buf.length < offset + payloadLen) return;
            const frame = this.buf.subarray(offset, offset + payloadLen);
            this.buf = this.buf.subarray(offset + payloadLen);

            if (opcode === 0x1 || opcode === 0x0) {
                // Text frame or continuation frame
                this.msgBuf += frame.toString();
                if (fin) {
                    try {
                        const msg = JSON.parse(this.msgBuf);
                        const p = this.pending.get(msg.id);
                        if (p) {
                            this.pending.delete(msg.id);
                            if (msg.error) p.reject(new Error(msg.error.message));
                            else p.resolve(msg.result ?? {});
                        }
                    } catch { /* ignore */ }
                    this.msgBuf = '';
                }
            }
            // Ignore ping/pong/close frames
        }
    }
}

/**
 * Export a Markdown file to PDF using Chrome DevTools Protocol.
 *
 * Launches Chrome/Edge/Chromium in headless mode with a remote debugging port,
 * connects via CDP, navigates to the HTML, and calls Page.printToPDF with
 * a scale parameter so text and diagrams shrink uniformly.
 *
 * @param mdFilePath - Absolute path to the Markdown file.
 * @param config - PlantUML and theme configuration.
 * @param [signal] - Optional AbortSignal to cancel in-flight rendering.
 * @param [landscape] - When true, use landscape orientation.
 * @returns Absolute path of the generated PDF file.
 * @throws When no supported browser is found or when the browser process fails.
 */
export async function exportToPdf(mdFilePath: string, config: Config, signal?: AbortSignal, landscape?: boolean): Promise<string> {
    const outputPath = requireOutputPath(mdFilePath, '.pdf');
    const browserPath = await findBrowser();
    if (!browserPath) {
        throw new Error(vscode.l10n.t('Chrome, Edge, or Chromium is required for PDF export. No supported browser was found.'));
    }

    // Generate fit-to-width HTML to a temporary file
    const source = await fs.promises.readFile(mdFilePath, 'utf8');
    handleExportEvent(source, config);
    const exportOptions: RenderOptions = {
        mermaidTheme: config.mermaidTheme,
        mermaidScale: config.mermaidScale,
        htmlMaxWidth: 'none',
        htmlAlignment: 'left',
        fitToWidth: true,
        katexCssHtml: config.enableMath ? await buildKatexCdnCssHtml() : '',
        enableMath: config.enableMath,
    };
    const exportConfig = { ...config, previewTheme: resolveExportTheme(config.previewTheme) };
    const fullHtml = await renderHtmlAsync(source, fileNameWithoutExtension(mdFilePath), exportConfig, exportOptions, signal);
    if (signal?.aborted || !fullHtml) throw new Error('Aborted');

    const isLandscape = landscape ?? false;
    const printHtml = fullHtml.replace('</head>', `<style>${pdfPageCss(config.pdfPaperSize, isLandscape)}${PDF_PRINT_CSS}</style>\n</head>`);

    const tmpHtml = path.join(os.tmpdir(), `plantuml-md-preview-${Date.now()}.html`);

    // Launch Chrome with remote debugging
    const args = [
        '--headless',
        '--disable-gpu',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        url.pathToFileURL(tmpHtml).href,
    ];

    let proc: ReturnType<typeof spawn> | undefined;
    try {
        await fs.promises.writeFile(tmpHtml, printHtml, 'utf8');

        // Start Chrome and extract the DevTools WebSocket URL from stderr
        proc = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

        let onAbort: (() => void) | undefined;
        const wsUrl = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Chrome did not start in time')), PDF_TIMEOUT_MS);
            let stderrBuf = '';
            proc!.stderr!.on('data', (chunk: Buffer) => {
                stderrBuf += chunk.toString();
                const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (m) { clearTimeout(timer); resolve(m[1]); }
            });
            proc!.on('error', e => { clearTimeout(timer); reject(e); });
            proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited with code ${code}`)); });
            if (signal) {
                onAbort = () => { clearTimeout(timer); proc!.kill(); reject(new Error('Aborted')); };
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }
        }).finally(() => {
            if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        });

        // Get the page target's WebSocket debugger URL
        const debugPort = new URL(wsUrl).port;
        const targetsJson = await httpGet(`http://127.0.0.1:${debugPort}/json`);
        const targets = JSON.parse(targetsJson) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find(t => t.type === 'page');
        if (!page?.webSocketDebuggerUrl) throw new Error('No page target found');

        const cdp = await CdpConnection.connect(page.webSocketDebuggerUrl);
        try {
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');
            // Wait for page load and Mermaid rendering to complete
            await cdp.send('Runtime.evaluate', {
                expression: 'new Promise(r => { if (document.readyState === "complete") r(); else window.addEventListener("load", r); })',
                awaitPromise: true,
            });
            await cdp.send('Runtime.evaluate', {
                expression: 'window.__renderMermaidDone || Promise.resolve()',
                awaitPromise: true,
            });
            // Extra wait for any remaining async rendering (KaTeX, etc.)
            await new Promise(r => setTimeout(r, 500));

            // Fit tables and formulas still wider than the page, then print to PDF with scale
            // (the setting is a percentage, printToPDF and the content width take a factor)
            const pdfScale = (config.pdfScale || 100) / 100;
            // Measure with the final fonts (KaTeX's come from the CDN), but do not wait forever when offline.
            await cdp.send('Runtime.evaluate', {
                expression: 'Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 5000))]).then(() => true)',
                awaitPromise: true,
            });
            // The PDF is still printed when fitting fails (wide content is then cut off at the page edge).
            try {
                const fit = await cdp.send('Runtime.evaluate', {
                    expression: `${PDF_FIT_SCRIPT}(${pdfContentWidthPx(pdfScale, isLandscape, config.pdfPaperSize)})`,
                });
                if (fit.exceptionDetails) console.warn('[exporter] PDF fit failed:', JSON.stringify(fit.exceptionDetails));
                else if ((fit.result as { value?: unknown } | undefined)?.value !== true) console.warn('[exporter] PDF fit skipped: no print width');
            } catch (err) {
                console.warn('[exporter] PDF fit failed:', err);
            }
            const result = await cdp.send('Page.printToPDF', {
                printBackground: true,
                preferCSSPageSize: true,
                scale: pdfScale,
            });

            // Write the base64-encoded PDF data to disk
            const pdfData = Buffer.from(result.data as string, 'base64');
            await fs.promises.writeFile(outputPath, pdfData);
        } finally {
            cdp.close();
        }

        return outputPath;
    } finally {
        proc?.kill();
        await fs.promises.unlink(tmpHtml).catch(() => {});
    }
}

/**
 * In a page without the preview script (an export, a revision preview), an in-page link stops its target
 * JUMP_TOP_GAP below the top, as the preview script does while it jumps (src/webview/jump-top-gap.ts).
 */
const NO_SCRIPT_IN_PAGE_JUMP_STYLE = `
  <style>#preview-content [id]{scroll-margin-top:${JUMP_TOP_GAP}px}</style>`;

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
 * Build the `<style>` for the HTML export's table wrapping (htmlTableWrap).
 *
 * `characters` gives CJK text in tables back its breaks between characters (the theme keeps it whole
 * with `keep-all`). `none` stops wrapping in cells (inline code included, which sets its own white-space)
 * and lets a table directly in the body grow to the right past the body, keeping its left edge on the
 * body's: up to 30px (the body's side padding) before the window's right edge. The body is centered in
 * the window, or on its left edge with `left`. Tables in lists and quotes keep the width of their box,
 * so that the page never scrolls sideways. Tables in diagrams are left alone.
 *
 * @param [tableWrap] - The table wrapping mode; `words` or unset adds nothing.
 * @param [left] - Whether the body is on the left edge of the window rather than centered.
 * @returns Style tag string, or empty string for `words`.
 */
function buildTableWrapStyle(tableWrap?: TableWrap, left?: boolean): string {
    if (tableWrap === 'characters') return '\n  <style>table{word-break:normal}</style>';
    if (tableWrap !== 'none') return '';
    const room = left ? '100vw - 60px' : '(100vw + 100%) / 2 - 30px';
    return `\n  <style>#preview-content > table{max-width:max(100%, calc(${room}))}`
        + 'table:not(:where(svg *)) :is(th, td){white-space:nowrap}'
        + 'table:not(:where(svg *)) :is(th, td) :is(code, tt){white-space:pre}</style>';
}

/** KaTeX version injected at build time from package.json via esbuild define. */
declare const __KATEX_VERSION__: string;
/** Mermaid major version injected at build time from package.json via esbuild define. */
declare const __MERMAID_MAJOR__: string;

/**
 * URL of mermaid.min.js that HTML export loads from the CDN.
 *
 * @returns The CDN URL for the bundled Mermaid major version.
 */
function mermaidCdnUrl(): string {
    return `https://cdn.jsdelivr.net/npm/mermaid@${__MERMAID_MAJOR__}/dist/mermaid.min.js`;
}

/**
 * Build a KaTeX CSS `<style>` block for HTML export using CDN font URLs.
 * Reads katex.min.css from dist/ and replaces relative font paths with CDN URLs.
 *
 * @returns `<style>` block containing the patched KaTeX CSS, or an empty string
 *          if the CSS file could not be read.
 */
async function buildKatexCdnCssHtml(): Promise<string> {
    try {
        let css = await fs.promises.readFile(path.join(__dirname, 'katex.min.css'), 'utf-8');
        css = css.replace(/url\(fonts\//g, `url(https://cdn.jsdelivr.net/npm/katex@${__KATEX_VERSION__}/dist/fonts/`);
        return `\n  <style id="katex-css">${css}</style>`;
    } catch { console.warn('[exporter] katex.min.css not found, math CSS disabled for export'); return ''; }
}

/**
 * Assemble a complete HTML document from rendered body HTML.
 *
 * Inserts theme CSS via `<style id="theme-css">`, a CSP meta tag (nonce-based for the
 * Webview, script-src only for export), and optional script HTML before `</body>`.
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
        fitToWidth, fitToWidthAlign, tableWrap, katexCssHtml, enableMath, hideBodyInitially, loadingText, previewZoom,
    } = options || {};
    // Written into the page so its first paint is already zoomed; 100% writes nothing.
    const zoomStyle = typeof previewZoom === 'number' && Number.isFinite(previewZoom) && previewZoom !== 100
        ? ` style="zoom:${previewZoom / 100}"` : '';
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
        `mermaid.initialize({startOnLoad:false,theme:window.__mermaidTheme||'${mermaidThemeValue}'});` +
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
        // Webview preview: load from local bundled file once the page is shown (with its loading
        // overlay; see shown-script-loader). __renderMermaidDone stands for the load and the render.
        // When the library cannot be used, the page shows why in place of each diagram, and
        // __mermaidLoadError keeps the text for diagrams that come later (scroll-sync-webview).
        const loadError = `window.__mermaidLoadError=${mermaidLoadErrorLiteral()};window.__showMermaidLoadError();`;
        const loader =
            `window.__renderMermaidDone=new Promise(function(resolve,reject){` +
            shownScriptLoader(cspNonce, mermaidScriptUri,
                `try{${mermaidInitScript}window.__renderMermaidDone.then(resolve,reject)}catch(e){${loadError}reject(e)}`,
                `${loadError}reject(new Error('mermaid failed to load'))`) +
            // The preview script also handles the failure; a page without it (a revision's snapshot) must not leave it unhandled.
            `});window.__renderMermaidDone.catch(function(){});`;
        mermaidHtml = `\n<script nonce="${cspNonce}">${SHOW_MERMAID_LOAD_ERROR_SCRIPT}${loader}</script>`;
    } else if (includeMermaid && !cspNonce) {
        // HTML export: load from CDN
        mermaidHtml = `\n<script src="${mermaidCdnUrl()}"></script>\n<script>${mermaidInitScript}</script>`;
    }
    // HTML/PDF export: only the two Mermaid scripts above may run (none without Mermaid), so scripts,
    // event attributes and javascript: links in the Markdown and in diagram SVGs do not, as in the
    // preview. Only scripts are restricted; images, fonts and media load as before.
    const exportCspMeta = cspNonce ? '' : `\n  <meta http-equiv="Content-Security-Policy" content="script-src ${includeMermaid
        ? `${mermaidCdnUrl()} 'sha256-${crypto.createHash('sha256').update(mermaidInitScript, 'utf8').digest('base64')}'`
        : "'none'"};">`;
    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${cspMeta}${exportCspMeta}
  <title>${escapeHtml(title)}</title>
  <style id="theme-css">
${theme.css}
  </style>${katexCssHtml || ''}${buildLayoutOverrideStyle(htmlMaxWidth, htmlAlignment)}${fitToWidth ? `
  <style>${typeof fitToWidth === 'number' ? `body{max-width:${fitToWidth}px;margin:${fitToWidthAlign === 'left' ? '0' : '0 auto'}}` : `body{max-width:none;margin:0}.plantuml-diagram svg{max-width:100%;height:auto!important}.d2-diagram svg{max-width:100%;height:auto!important}pre.mermaid svg{max-width:100%!important;height:auto}img{max-width:100%;height:auto}`}</style>` : ''}${buildTableWrapStyle(tableWrap, typeof fitToWidth === 'number' ? fitToWidthAlign === 'left' : htmlAlignment === 'left')}${cspNonce ? `
  <style>
#nav-toolbar{position:fixed;top:8px;right:8px;display:flex;gap:2px;z-index:100}
#nav-toolbar button{width:32px;height:32px;border:none;border-radius:4px;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s,opacity 0.15s;padding:0;opacity:0.45}
#nav-toolbar button:hover{opacity:0.85}
#toc-sidebar{position:fixed;top:0;right:0;width:260px;height:100%;z-index:99;overflow-y:auto;padding:44px 0 16px;box-sizing:border-box;display:none;font-size:13px;line-height:1.6}
#toc-sidebar::before{content:'';position:absolute;left:0;top:44px;bottom:16px;width:1px}
#toc-sidebar.open{display:block}
#toc-sidebar ul{list-style:none;margin:0;padding:0}
#toc-sidebar li{position:relative;margin:0}
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
  </style>` : ''}${scriptHtml ? '' : NO_SCRIPT_IN_PAGE_JUMP_STYLE}
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
<div id="preview-content"${zoomStyle}>
${body}
</div>${loadingText !== undefined ? `\n${loadingOverlayHtml(loadingText)}` : ''}${mermaidHtml}
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
