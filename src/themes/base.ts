/**
 * @module themes/base
 * @description Shared CSS template for all preview themes.
 *
 * Each theme file defines only a color palette object and passes it to buildThemeCss(),
 * which generates a complete CSS string covering body, headings, links, code blocks,
 * tables, blockquotes, task lists, footnotes, PlantUML diagrams, and highlight.js syntax colors.
 * The block shapes (sizes, weights, spacing, borders, indents) follow GitHub; the
 * colors come from the palette.
 * Optional palette fields let a theme depart from the shared layout (table header
 * colors, code block border, title weight, link underline, comment and diff tokens,
 * per-token syntax colors); unset fields leave the output unchanged.
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
    /** General border color (headings, horizontal rules, `kbd`). */
    border: string;
    /** Hyperlink color. */
    link: string;
    /** Visited hyperlink color. */
    linkVisited: string;
    /** Inline code background color; also the table header unless `thBg` is set. */
    codeBg: string;
    /** Even table row background color. */
    trEvenBg: string;
    /** Blockquote left-border color. */
    blockquoteBorder: string;
    /** Blockquote text color; also the footnote section text. */
    blockquoteColor: string;
    /** Code block (`.hljs`) background color; the renderer puts every code block in `pre.hljs`. */
    hljsBg: string;
    /** highlight.js comment token color (see `hljsCommentTokens`). */
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
    /** Inline code text color override (defaults to body text color); code blocks use `hljsText`. */
    codeText?: string;
    /** Scrollbar thumb color in the preview (defaults to the body text color at 30%). */
    scrollbarThumb?: string;
    /**
     * Code block border color. Code blocks have no border, as on GitHub, unless this is set
     * or the code block background is the body background (then the general border marks
     * the block's edge).
     */
    preBorder?: string;
    /** Table border color override (defaults to general border). */
    tableBorder?: string;
    /** Code block (`.hljs`) text color (defaults to body text color). */
    hljsText?: string;
    /** Table header background override (defaults to `codeBg`). */
    thBg?: string;
    /**
     * Color of the line under the table header row, i.e. the header cells' bottom
     * border (defaults to the table border).
     */
    thBorder?: string;
    /** Font weight of title / section / function tokens (defaults to `bold`). */
    hljsTitleWeight?: string;
    /** Underline link tokens (defaults to false). */
    hljsLinkUnderline?: boolean;
    /**
     * Token classes, without the `hljs-` prefix, that take `hljsComment` in italics
     * (defaults to `comment`, `prolog`, `doctype` and `cdata`).
     */
    hljsCommentTokens?: readonly string[];
    /** Stretch addition / deletion tokens over the whole line (defaults to false). */
    hljsDiffFullLine?: boolean;
    /**
     * Per-token color overrides, keyed by the highlight.js class without its
     * `hljs-` prefix (e.g. `literal` for `.hljs-literal`). Emitted after the grouped
     * token rules above, so they win over them; tokens not listed keep those colors.
     */
    hljsTokens?: Readonly<Record<string, string>>;
}

/**
 * Build the rules for {@link ThemePalette.hljsTokens}.
 *
 * @param tokens - Token class suffix to color.
 * @param [scope] - Selector prefix (e.g. `body.vscode-dark `) limiting where the rules apply.
 * @returns CSS string with one color rule per token, each on its own line.
 */
export function buildHljsTokenCss(tokens: Readonly<Record<string, string>>, scope = ''): string {
    return Object.entries(tokens)
        .map(([token, color]) => `\n    ${scope}.hljs-${token} { color: ${color}; }`).join('');
}

/** Monospace font stack for inline code, code blocks and `kbd`. */
const MONO_FONT = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

/**
 * GitHub Primer accent colors for alert types, per light/dark theme.
 * Applied to `.markdown-alert-<type>` (left border + title/icon color).
 * Values are GitHub's Primer alert colors.
 */
const ALERT_COLORS = {
    light: { note: '#0969da', tip: '#1a7f37', important: '#8250df', warning: '#9a6700', caution: '#d1242f' },
    dark:  { note: '#2f81f7', tip: '#3fb950', important: '#a371f7', warning: '#d29922', caution: '#f85149' },
} as const;

/**
 * Decide whether a background color is dark, from its perceived luminance.
 * Used to pick the light/dark alert accent set without per-theme config.
 * Falls back to light (false) for any color that isn't a #rgb / #rrggbb hex.
 *
 * @param bg - CSS hex color (e.g. `#ffffff`, `#0d1117`).
 * @returns True when the background is dark.
 */
function isDarkBg(bg: string): boolean {
    const hex = bg.trim().replace(/^#/, '');
    const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return false;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    // Rec. 601 relative luminance; < 128 reads as a dark background.
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

/**
 * Build the per-type accent rules for GitHub-style alerts.
 *
 * @param dark - True for the dark accent set, false for the light one.
 * @param [scope] - Selector prefix (e.g. `body.vscode-dark `) limiting where the rules apply.
 * @returns CSS string with a border and title color rule per alert type.
 */
export function buildAlertAccentCss(dark: boolean, scope = ''): string {
    const c = dark ? ALERT_COLORS.dark : ALERT_COLORS.light;
    return (Object.keys(c) as (keyof typeof c)[]).map(type => `
    ${scope}.markdown-alert-${type} { border-left-color: ${c[type]}; }
    ${scope}.markdown-alert-${type} > .markdown-alert-title { color: ${c[type]}; }`).join('');
}

/**
 * Build the CSS for GitHub-style alerts (`> [!NOTE]` etc.), theme-aware.
 * Structure matches the markup of alertPlugin (markdown-rules.ts); colors come from
 * {@link ALERT_COLORS} based on the theme background.
 *
 * @param bg - Theme background color, used to choose the light/dark accents.
 * @returns CSS string for the `.markdown-alert*` classes.
 */
function buildAlertCss(bg: string): string {
    const dark = isDarkBg(bg);
    const c = dark ? ALERT_COLORS.dark : ALERT_COLORS.light;
    const perType = buildAlertAccentCss(dark);
    return `
    .markdown-alert {
      padding: 0.5em 1em;
      margin: 0 0 16px;
      border-left: 0.25em solid ${c.note};
      color: inherit;
    }
    .markdown-alert > :first-child { margin-top: 0; }
    .markdown-alert > :last-child { margin-bottom: 0; }
    .markdown-alert-title {
      display: flex;
      align-items: center;
      font-weight: 500;
      line-height: 1;
      margin-bottom: 1em;
    }
    .markdown-alert-title .octicon {
      margin-right: 0.5em;
      fill: currentColor;
      overflow: visible;
      vertical-align: text-bottom;
    }${perType}`;
}

/**
 * Generate a complete theme CSS string from a color palette.
 *
 * Produces CSS rules for body layout, headings, links, inline/block code,
 * tables, blockquotes, horizontal rules, task lists, footnotes, images, PlantUML diagrams,
 * and highlight.js syntax token classes, with GitHub's block shapes. Optional
 * palette fields fall back to their corresponding base values, except `preBorder`:
 * without it code blocks have no border unless their background is the body background.
 *
 * @param p - Theme color palette defining all visual tokens.
 * @returns Complete CSS string (without wrapping `<style>` tags).
 */
export function buildThemeCss(p: ThemePalette): string {
    const headingColor = p.headingColor ? ` color: ${p.headingColor};` : '';
    const codeText = p.codeText || p.text;
    const preBorderColor = p.preBorder ?? (p.hljsBg === p.bg ? p.border : undefined);
    const preBorder = preBorderColor ? `\n      border: 1px solid ${preBorderColor};` : '';
    const tableBorder = p.tableBorder || p.border;
    const hljsText = p.hljsText || p.text;
    const thBg = p.thBg || p.codeBg;
    const scrollbarThumb = p.scrollbarThumb ?? `color-mix(in srgb, ${p.text} 30%, transparent)`;
    const thBorder = p.thBorder ? ` border-bottom-color: ${p.thBorder};` : '';
    const hljsTitleWeight = p.hljsTitleWeight || 'bold';
    const hljsCommentSelector = (p.hljsCommentTokens ?? ['comment', 'prolog', 'doctype', 'cdata'])
        .map(token => `.hljs-${token}`).join(', ');
    const hljsOverrides = (p.hljsLinkUnderline ? '\n    .hljs-link { text-decoration: underline; }' : '')
        + (p.hljsDiffFullLine ? '\n    .hljs-addition, .hljs-deletion { display: inline-block; width: 100%; }' : '')
        + buildHljsTokenCss(p.hljsTokens ?? {});

    return `
    *, *::before, *::after { box-sizing: border-box; }
    html { background-color: ${p.bg}; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                   'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      max-width: 960px; /* matches GitHub / VS Code markdown preview width */
      margin: 0 auto;
      padding: 46px 30px 4rem; /* as much room as Typora (GitHub theme): 30px at the sides, 30px + 16px above the first heading */
      line-height: 1.5;
      word-wrap: break-word;
      color: ${p.text};
      background-color: ${p.bg};
    }
    /* Block shapes (sizes, weights, spacing, borders, indents, line heights) follow GitHub (github-markdown-css 5.8.1); colors stay the theme's.
       Horizontal rules are half as thick as GitHub's.
       Paragraphs, quotes, lists, definition lists, tables, code blocks, details, diagrams and display math have no top margin and 16px below, as on GitHub,
       so a block right after something without a margin (a tight list item's text, a summary, a table cell) does not get extra room. */
    #preview-content > :first-child { margin-top: 0 !important; }
    #preview-content > :last-child { margin-bottom: 0 !important; }
    h1 { font-size: 2em; border-bottom: 1px solid ${p.border}; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid ${p.border}; padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    h4 { font-size: 1em; }
    h5 { font-size: 0.875em; }
    h6 { font-size: 0.85em; }
    h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; scroll-margin-top: 1.5em;${headingColor} }
    p { margin: 0 0 16px; }
    /* Paragraphs inside list items have no margin; lists whose items are separated by blank lines (loose lists) get paragraph spacing. */
    li > p { margin: 0; }
    ul.list-loose > li > p, ol.list-loose > li > p { margin: 1em 0; }
    ul.list-loose > li:first-child > p:first-child, ol.list-loose > li:first-child > p:first-child { margin-top: 0; }
    ul.list-loose > li:last-child > p:last-child, ol.list-loose > li:last-child > p:last-child { margin-bottom: 0; }
    ul, ol { margin: 0 0 16px; padding-left: 2em; }
    ul ul, ul ol, ol ul, ol ol { margin: 0; }
    ol ol, ul ol { list-style-type: lower-roman; }
    ul ul ol, ul ol ol, ol ul ol, ol ol ol { list-style-type: lower-alpha; }
    /* A list numbered by its type attribute (a raw ol with type="a" etc.) keeps that style, over the nesting rules above (same as GitHub). */
    ol[type] { list-style-type: revert-layer; }
    li + li { margin-top: 0.25em; }
    b, strong { font-weight: 600; }
    a { color: ${p.link}; text-decoration: none; }
    /* VS Code puts its own stylesheet in every webview. In current versions it sits in a layer, so only values the theme
       leaves unset show through (a quote background, the kbd color, the underline of code in links); in older versions
       without the layer its a:hover and a code also win. These rules set the values themselves; exported pages look the
       same either way. */
    a:hover { color: ${p.link}; text-decoration: underline; }
    /* An anchor without a link target (raw <a name>) reads as body text, as on GitHub; links in diagrams keep their own look. */
    a:not([href]):not(:where(svg *)) { color: inherit; text-decoration: none; }
    a:visited { color: ${p.linkVisited}; }
    code, tt {
      font-family: ${MONO_FONT};
      font-size: 0.85em;
      white-space: break-spaces;
      color: ${codeText};
      background: ${p.codeBg};
      padding: 0.2em 0.4em;
      border-radius: 6px;
    }
    /* The code block carries the code font size and line height, so the line pitch is the code size x 1.45 as on GitHub.
       Long words are not broken (word-wrap is reset here instead of inheriting the body's break-word), as on GitHub. */
    pre {
      font-family: ${MONO_FONT};
      font-size: 0.85em;
      line-height: 1.45;
      word-wrap: normal;
      margin: 0 0 16px;
      border-radius: 6px;${preBorder}
      padding: 16px;
      overflow-x: auto;
    }
    h1 code, h2 code, h3 code, h4 code, h5 code, h6 code,
    h1 tt, h2 tt, h3 tt, h4 tt, h5 tt, h6 tt { padding: 0 0.2em; font-size: inherit; }
    pre code { background: none; padding: 0; font-size: inherit; color: inherit; white-space: inherit; }
    /* A tt in a code block drops only the background and padding; it keeps the inline size and white-space, as on GitHub. */
    pre tt { background: none; padding: 0; color: inherit; }
    del code { text-decoration: inherit; }
    code br, tt br { display: none; }
    a code, a tt { color: ${codeText}; text-decoration: none; }
    samp { font-family: ${MONO_FONT}; font-size: 0.85em; }
    /* With source lines, a code block is wrapped in a div ending in a line marker that stops margin collapsing,
       so the wrapper takes the code block's margin (with the specificity of a bare div, so first and last child rules still win). */
    div:where([data-source-line]:not([class])) { margin: 0 0 16px; }
    div:where([data-source-line]:not([class])) > pre { margin: 0; }
    kbd {
      display: inline-block;
      padding: 4px;
      font: 11px ${MONO_FONT};
      line-height: 10px;
      vertical-align: middle;
      color: inherit;
      background-color: ${p.codeBg};
      border: 1px solid ${p.border};
      border-radius: 6px;
      box-shadow: inset 0 -1px 0 ${p.border};
    }
    /* No left and right margins, so that align="center" keeps its auto margins.
       CJK text breaks only where words break (keep-all), so a wide table keeps its width and scrolls instead of
       narrowing to the screen one character per line (a deliberate exception to GitHub). */
    table { border-collapse: collapse; display: block; width: max-content; max-width: 100%; overflow: auto; margin-top: 0; margin-bottom: 16px; font-variant: tabular-nums; word-break: keep-all; }
    th, td { border: 1px solid ${tableBorder}; padding: 6px 13px; }
    /* Header cells without an align attribute are left-aligned like the cells below them (GitHub centers them); align attributes still apply. */
    th:not([align]) { text-align: left; }
    td > :last-child { margin-bottom: 0; }
    th { background: ${thBg}; font-weight: 600;${thBorder} }
    /* Stripes count only body rows with body cells, so the row after the header row is always white, even in an HTML
       table whose header row is not in a <thead> (GitHub counts the header row there; a deliberate exception to GitHub).
       Rows in <thead> and <tfoot> are not striped. */
    tbody > tr:nth-child(even of :has(> td)) { background: ${p.trEvenBg}; }
    blockquote {
      border-left: 0.25em solid ${p.blockquoteBorder};
      margin: 0 0 16px;
      padding: 0 1em;
      color: ${p.blockquoteColor};
      background: none;
    }
    blockquote > :first-child { margin-top: 0; }
    blockquote > :last-child { margin-bottom: 0; }
    ${buildAlertCss(p.bg)}
    hr { height: 0.125em; padding: 0; border: none; background-color: ${p.border}; margin: 24px 0; overflow: hidden; }
    details { margin: 0 0 16px; }
    details summary { cursor: pointer; }
    summary h1, summary h2, summary h3, summary h4, summary h5, summary h6 { display: inline-block; }
    summary h1, summary h2 { padding-bottom: 0; border-bottom: 0; }
    small { font-size: 90%; }
    /* Superscripts and subscripts do not raise the line, as on GitHub (footnote references are superscripts too). */
    sub, sup { font-size: 75%; line-height: 0; position: relative; vertical-align: baseline; }
    sub { bottom: -0.25em; }
    sup { top: -0.5em; }
    dl { padding: 0; margin: 0 0 16px; }
    dl dt { padding: 0; margin-top: 1em; font-size: 1em; font-style: italic; font-weight: 600; }
    dl dd { padding: 0 1em; margin: 0 0 1em; }
    /* Form controls take the body font, so the checkbox's em margins are body ems, and drop the browser's own margins, as on GitHub. */
    input { font: inherit; margin: 0; }
    /* Task list checkboxes hang in the bullet's place; the space after the checkbox stays, as on GitHub.
       The checkbox keeps the browser's own size (13px square). */
    .task-list-item { list-style-type: none; }
    .task-list-item-checkbox { margin: 0 0.2em 0.25em -1.4em; vertical-align: middle; }
    /* Footnotes: the section is 12px text below a 1px line. */
    section.footnotes { font-size: 12px; color: ${p.blockquoteColor}; border-top: 1px solid ${p.border}; }
    .footnotes ol { padding-left: 16px; }
    .footnotes ol ul { display: inline-block; padding-left: 16px; margin-top: 16px; }
    .footnotes-list { margin: 0; }
    .footnote-item::marker { color: ${p.link}; }
    /* The definition a reference jumps to gets a frame and the body text color, as on GitHub: :target in an
       exported page, .footnote-target in the preview (the webview script marks it; the webview never sets :target). */
    .footnote-item { position: relative; }
    .footnote-item:is(:target, .footnote-target)::before { position: absolute; inset: -8px -8px -8px -24px; pointer-events: none; content: ""; border: 2px solid ${p.link}; border-radius: 6px; }
    .footnote-item:is(:target, .footnote-target) { color: ${p.text}; }
    /* Footnote paragraphs and the paragraphs of loose lists in them are spaced by the body size (16px), not the 12px text. */
    .footnote-item > p, .footnote-item ul.list-loose > li > p, .footnote-item ol.list-loose > li > p { margin: 16px 0; }
    img { max-width: 100%; height: auto; box-sizing: content-box; border-style: none; }
    img[align=right] { padding-left: 20px; }
    img[align=left] { padding-right: 20px; }
    .plantuml-diagram { margin: 0 0 16px; text-align: left; width: fit-content; }
    .plantuml-diagram svg { height: auto; }
    .mermaid-diagram { margin: 0 0 16px; text-align: left; width: fit-content; }
    .mermaid-diagram pre.mermaid { visibility: hidden; overflow: visible; border: none; margin: 0; padding: 0; font-size: inherit; line-height: inherit; }
    .mermaid-diagram svg { visibility: visible; height: auto; }
    .mermaid-error { visibility: visible; color: #d32f2f; border-left: 3px solid #d32f2f; padding: 0.5em; white-space: pre-wrap; font-size: 0.85em; }
    .d2-diagram { margin: 0 0 16px; text-align: left; }
    .d2-diagram pre.d2 { margin: 0; }
    .d2-diagram svg { height: auto; }
    .d2-error { color: #d32f2f; border-left: 3px solid #d32f2f; padding: 0.5em; white-space: pre-wrap; font-size: 0.85em; }
    .katex { color: inherit; }
    .katex-display { margin: 1em 0; overflow-x: auto; overflow-y: hidden; }
    .katex-block { margin: 0 0 16px; }
    .katex-block > .katex-display { margin: 0; }
    body.preview { margin: 0; max-width: none; padding: 46px 30px 1em; }
    /* Scrollbars in the preview take the theme's colors (a thumb of the text color at 30%), not the VS Code color theme's,
       which VS Code's webview stylesheet sets on html. The page's own scrollbar has a track of the page background: a clear
       one would show the editor behind the webview, not the page. Boxes inside inherit a clear track from body, so each box
       shows its own background. VS Code versions too old for scrollbar-color keep their own scrollbars. Exported pages keep
       the browser's own scrollbars. */
    html:has(> body.preview) { scrollbar-color: ${scrollbarThumb} ${p.bg}; }
    body.preview { scrollbar-color: ${scrollbarThumb} transparent; }
    /* In print (PDF export, or printing an exported HTML file) the page margin takes the place of the room above the document. */
    @media print { body { padding-top: 0; } }
    .hljs { background: ${p.hljsBg}; color: ${hljsText}; }
    ${hljsCommentSelector} { color: ${p.hljsComment}; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag { color: ${p.hljsKeyword}; }
    .hljs-string, .hljs-doctag { color: ${p.hljsString}; }
    .hljs-number, .hljs-literal { color: ${p.hljsNumber}; }
    .hljs-attr, .hljs-attribute { color: ${p.hljsAttr}; }
    .hljs-name, .hljs-tag, .hljs-selector-id, .hljs-selector-class { color: ${p.hljsName}; }
    .hljs-title, .hljs-section, .hljs-function { color: ${p.hljsTitle}; font-weight: ${hljsTitleWeight}; }
    .hljs-built_in, .hljs-type { color: ${p.hljsBuiltIn}; }
    .hljs-symbol, .hljs-bullet, .hljs-link { color: ${p.hljsSymbol}; }
    .hljs-meta { color: ${p.hljsMeta}; }
    .hljs-addition { background: ${p.hljsAdditionBg}; color: ${p.hljsAdditionColor}; }
    .hljs-deletion { background: ${p.hljsDeletionBg}; color: ${p.hljsDeletionColor}; }${hljsOverrides}
    .hljs-strong { font-weight: bold; }
    .hljs-emphasis { font-style: italic; }
    #toc-sidebar { background-color: ${p.bg}; color: ${p.text}; }
    #toc-sidebar::before { background-color: ${p.border}; }
    #toc-sidebar .toc-toggle { color: ${p.text}; }
    #toc-sidebar a { color: ${p.link}; }
    #toc-sidebar a:hover { background: ${p.codeBg}; }
    #toc-sidebar a.active { color: ${p.link}; border-left-color: ${p.link}; }
    #nav-toolbar button { color: ${p.text}; }
    #nav-toolbar button:hover, #nav-toolbar button.active { background: ${p.codeBg}; }`;
}
