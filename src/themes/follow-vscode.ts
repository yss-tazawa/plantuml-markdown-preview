/**
 * @module themes/follow-vscode
 * @description VS Code theme that follows the current VS Code color theme.
 *
 * Colors come from the webview's `--vscode-*` variables, like VS Code's built-in
 * Markdown preview, with VS Code Light 2026 / Dark 2026 colors as fallbacks.
 * HTML/PDF export substitutes vscode-light-2026 or vscode-dark-2026.
 */
import { buildThemeCss, buildAlertAccentCss, buildHljsTokenCss, type ThemePalette } from './base.js';
import { palette as light } from './vscode-light-2026.js';
import { palette as dark } from './vscode-dark-2026.js';

/** Body class VS Code sets on dark webviews. */
const DARK = 'body.vscode-dark';
/** Body classes for high contrast dark (high contrast light also has `vscode-high-contrast`). */
const HC_DARK = 'body.vscode-high-contrast:not(.vscode-high-contrast-light)';

/** Palette fields taken from a VS Code variable, and the variable each one reads. */
const FROM_VSCODE = {
    text: 'editor-foreground',
    link: 'textLink-foreground',
    linkVisited: 'textLink-foreground',
    codeBg: 'textPreformat-background',
    codeText: 'textPreformat-foreground',
    preBorder: 'widget-border',
    blockquoteBorder: 'textBlockQuote-border',
    blockquoteColor: 'editor-foreground',
    blockquoteBg: 'textBlockQuote-background',
    hljsBg: 'textCodeBlock-background',
} as const;
/** A palette field taken from a VS Code variable. */
type Field = keyof typeof FROM_VSCODE;
/** Every palette field taken from a VS Code variable. */
const FIELDS = Object.keys(FROM_VSCODE) as Field[];

/** Border color under high contrast. */
const CONTRAST_BORDER = 'var(--vscode-contrastBorder, currentColor)';
/** Fallbacks under high contrast dark, where no 2026 palette applies. */
const HC_DARK_FALLBACK: Record<Field, string> = {
    text: '#ffffff',
    link: dark.link,
    linkVisited: dark.linkVisited,
    codeBg: 'transparent',
    codeText: '#ffffff',
    preBorder: CONTRAST_BORDER,
    blockquoteBorder: CONTRAST_BORDER,
    blockquoteColor: '#ffffff',
    blockquoteBg: 'transparent',
    hljsBg: 'transparent',
};

/** `var()` reading a VS Code variable, then the per-body fallback, then Light 2026. */
function follow(f: Field): string {
    return `var(--vscode-${FROM_VSCODE[f]}, var(--pmp-fb-${f}, ${light[f]}))`;
}

/** Declarations setting every per-body fallback property. */
function fallbacks(values: Record<Field, string>): string {
    return FIELDS.map(f => `--pmp-fb-${f}: ${values[f]};`).join(' ');
}

/** Color palette built from VS Code CSS variables. */
const palette = {
    ...light,
    ...Object.fromEntries(FIELDS.map(f => [f, follow(f)])) as Record<Field, string>,
    bg: `var(--vscode-editor-background, ${light.bg})`,
    border: `var(--pmp-border, ${light.border})`,
    trEvenBg: 'transparent',
    hljsAdditionBg: 'var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2))',
    hljsDeletionBg: 'var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2))',
    thBorder: `var(--pmp-thBorder, ${light.thBorder})`,
} satisfies ThemePalette;

/** Dark syntax colors. */
const darkTokens = dark.hljsTokens;
/** Dark syntax color rules for the dark and high contrast dark body classes. */
const darkTokenCss = buildHljsTokenCss(darkTokens, `${DARK} `) +
    buildHljsTokenCss(darkTokens, `${HC_DARK} `);

/** Rules choosing the dark fallbacks, syntax colors, borders and alert accents per body class. */
const switchCss = `
    ${DARK} { ${fallbacks(dark)} }
    ${HC_DARK} { ${fallbacks(HC_DARK_FALLBACK)} }${darkTokenCss}
    body.vscode-light { --pmp-border: rgba(0, 0, 0, 0.18); --pmp-thBorder: rgba(0, 0, 0, 0.69); }
    body.vscode-dark { --pmp-border: rgba(255, 255, 255, 0.18); --pmp-thBorder: rgba(255, 255, 255, 0.69); }
    body.vscode-high-contrast { --pmp-border: ${CONTRAST_BORDER}; --pmp-thBorder: ${CONTRAST_BORDER}; }
    ${buildAlertAccentCss(true, `${DARK} `)}
    ${buildAlertAccentCss(true, `${HC_DARK} `)}`;

/** Background color for this theme (resolved by the webview). */
export const bg = palette.bg;
/** Complete CSS stylesheet for this theme. */
export const css = buildThemeCss(palette) + switchCss;
