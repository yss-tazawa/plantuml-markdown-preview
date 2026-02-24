/**
 * @module themes/base
 * @description Shared CSS template for all preview themes.
 *
 * Each theme file defines only a color palette object and passes it to buildThemeCss(),
 * which generates a complete CSS string covering body, headings, links, code blocks,
 * tables, blockquotes, PlantUML diagrams, and highlight.js syntax colors.
 */

/**
 * Color palette for generating a complete theme CSS string.
 *
 * Required properties cover body, headings, links, code blocks, tables,
 * blockquotes, and highlight.js token colors. Optional properties provide
 * overrides when a theme needs values different from the base defaults.
 */
export interface ThemePalette {
    /** Body background color. */
    bg: string;
    /** Body text color. */
    text: string;
    /** General border color (headings, horizontal rules). */
    border: string;
    /** Hyperlink color. */
    link: string;
    /** Visited hyperlink color. */
    linkVisited: string;
    /** Inline code and table header background color. */
    codeBg: string;
    /** Even table row background color. */
    trEvenBg: string;
    /** Blockquote left-border color. */
    blockquoteBorder: string;
    /** Blockquote text color. */
    blockquoteColor: string;
    /** Blockquote background color. */
    blockquoteBg: string;
    /** highlight.js code block background color. */
    hljsBg: string;
    /** highlight.js comment / prolog / doctype token color. */
    hljsComment: string;
    /** highlight.js keyword / selector-tag token color. */
    hljsKeyword: string;
    /** highlight.js string / doctag token color. */
    hljsString: string;
    /** highlight.js number / literal token color. */
    hljsNumber: string;
    /** highlight.js attribute token color. */
    hljsAttr: string;
    /** highlight.js tag / name / selector token color. */
    hljsName: string;
    /** highlight.js title / section / function token color. */
    hljsTitle: string;
    /** highlight.js built-in / type token color. */
    hljsBuiltIn: string;
    /** highlight.js symbol / bullet / link token color. */
    hljsSymbol: string;
    /** highlight.js meta token color. */
    hljsMeta: string;
    /** highlight.js diff addition background color. */
    hljsAdditionBg: string;
    /** highlight.js diff addition text color. */
    hljsAdditionColor: string;
    /** highlight.js diff deletion background color. */
    hljsDeletionBg: string;
    /** highlight.js diff deletion text color. */
    hljsDeletionColor: string;
    /** Heading text color override (defaults to body text color). */
    headingColor?: string;
    /** Inline code text color override (defaults to body text color). */
    codeText?: string;
    /** Pre/code block border color override (defaults to general border). */
    preBorder?: string;
    /** Table border color override (defaults to general border). */
    tableBorder?: string;
    /** highlight.js base text color override (defaults to body text color). */
    hljsText?: string;
}

/**
 * Generate a complete theme CSS string from a color palette.
 *
 * Produces CSS rules for body layout, headings, links, inline/block code,
 * tables, blockquotes, horizontal rules, images, PlantUML diagrams,
 * and highlight.js syntax token classes. Optional palette fields fall back
 * to their corresponding base values.
 *
 * @param {ThemePalette} p - Theme color palette defining all visual tokens.
 * @returns {string} Complete CSS string (without wrapping `<style>` tags).
 */
export function buildThemeCss(p: ThemePalette): string {
    const headingColor = p.headingColor ? ` color: ${p.headingColor};` : '';
    const codeText = p.codeText || p.text;
    const preBorder = p.preBorder || p.border;
    const tableBorder = p.tableBorder || p.border;
    const hljsText = p.hljsText || p.text;

    return `
    *, *::before, *::after { box-sizing: border-box; }
    html { background-color: ${p.bg}; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                   'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1.5rem 4rem;
      line-height: 1.7;
      color: ${p.text};
      background-color: ${p.bg};
    }
    h1 { font-size: 2em; border-bottom: 2px solid ${p.border}; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid ${p.border}; padding-bottom: 0.2em; }
    h3 { font-size: 1.25em; }
    h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em;${headingColor} }
    p { margin: 0.8em 0; }
    a { color: ${p.link}; }
    a:visited { color: ${p.linkVisited}; }
    code {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.875em;
      color: ${codeText};
      background: ${p.codeBg};
      padding: 0.2em 0.4em;
      border-radius: 3px;
    }
    pre {
      border: 1px solid ${preBorder};
      border-radius: 6px;
      padding: 1em 1.2em;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; font-size: 0.875em; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid ${tableBorder}; padding: 0.5em 1em; text-align: left; }
    th { background: ${p.codeBg}; font-weight: 600; }
    tr:nth-child(even) { background: ${p.trEvenBg}; }
    blockquote {
      border-left: 4px solid ${p.blockquoteBorder};
      margin: 0;
      padding: 0.5em 1em;
      color: ${p.blockquoteColor};
      background-color: ${p.blockquoteBg};
    }
    hr { border: none; border-top: 2px solid ${p.border}; margin: 2em 0; }
    img { max-width: 100%; height: auto; }
    .plantuml-diagram { margin: 1.5em 0; text-align: center; }
    .plantuml-diagram svg { max-width: 100%; height: auto; }
    .hljs { background: ${p.hljsBg}; color: ${hljsText}; }
    .hljs-comment, .hljs-prolog, .hljs-doctype, .hljs-cdata { color: ${p.hljsComment}; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag { color: ${p.hljsKeyword}; }
    .hljs-string, .hljs-doctag { color: ${p.hljsString}; }
    .hljs-number, .hljs-literal { color: ${p.hljsNumber}; }
    .hljs-attr, .hljs-attribute { color: ${p.hljsAttr}; }
    .hljs-name, .hljs-tag, .hljs-selector-id, .hljs-selector-class { color: ${p.hljsName}; }
    .hljs-title, .hljs-section, .hljs-function { color: ${p.hljsTitle}; font-weight: bold; }
    .hljs-built_in, .hljs-type { color: ${p.hljsBuiltIn}; }
    .hljs-symbol, .hljs-bullet, .hljs-link { color: ${p.hljsSymbol}; }
    .hljs-meta { color: ${p.hljsMeta}; }
    .hljs-addition { background: ${p.hljsAdditionBg}; color: ${p.hljsAdditionColor}; }
    .hljs-deletion { background: ${p.hljsDeletionBg}; color: ${p.hljsDeletionColor}; }
    .hljs-strong { font-weight: bold; }
    .hljs-emphasis { font-style: italic; }`;
}
