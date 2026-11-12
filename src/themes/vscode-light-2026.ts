/**
 * @module themes/vscode-light-2026
 * @description VS Code Light 2026 theme.
 *
 * White background (#ffffff), dark text (#202020).
 * Colors from VS Code 1.146.0's Light 2026 theme and built-in preview CSS.
 * Syntax tokens follow the light rules of the preview's highlight.css.
 */
import { buildThemeCss, type ThemePalette } from './base.js';

/** Color palette for the VS Code Light 2026 theme (exported for the vscode theme). */
export const palette = {
    bg: '#ffffff',
    text: '#202020',
    border: '#d1d1d1',
    link: '#0069cc',
    linkVisited: '#0069cc',
    codeBg: '#e0e0e0',
    codeText: '#3b3b3b',
    preBorder: '#e2e2e5',
    trEvenBg: '#ffffff',
    blockquoteBorder: '#f0f1f2',
    blockquoteColor: '#202020',
    blockquoteBg: '#eaeaea',
    hljsBg: '#ececec',
    hljsComment: '#008000',
    hljsKeyword: '#0000ff',
    hljsString: '#a31515',
    hljsNumber: '#008000',
    hljsAttr: '#ff0000',
    hljsName: '#0000ff',
    hljsTitle: '#808080',
    hljsBuiltIn: '#007acc',
    hljsSymbol: '#00b0e8',
    hljsMeta: '#2b91af',
    hljsAdditionBg: '#d6dbcb',
    hljsAdditionColor: '#9bb955',
    hljsDeletionBg: '#e3caca',
    hljsDeletionColor: '#ff0000',
    thBg: 'transparent',
    thBorder: '#4f4f4f',
    hljsTitleWeight: 'normal',
    hljsLinkUnderline: true,
    hljsCommentTokens: ['comment', 'quote'],
    hljsDiffFullLine: true,
    hljsTokens: {
        keyword: '#0000ff',
        literal: '#a31515',
        symbol: '#00b0e8',
        name: '#0000ff',
        link: '#00b0e8',
        built_in: '#007acc',
        type: '#a31515',
        number: '#008000',
        class: '#008000',
        string: '#a31515',
        'meta-string': '#d69d85',
        regexp: '#9a5334',
        'template-tag': '#a31515',
        subst: '#2b91af',
        function: 'inherit',
        title: '#808080',
        params: 'inherit',
        formula: '#dcdcdc',
        comment: '#008000',
        quote: '#008000',
        doctag: '#808080',
        meta: '#2b91af',
        'meta-keyword': '#2b91af',
        tag: '#0000ff',
        variable: '#008000',
        'template-variable': '#a31515',
        attr: '#ff0000',
        attribute: '#a31515',
        'builtin-name': '#007acc',
        section: '#a31515',
        bullet: '#00b0e8',
        'selector-tag': '#0000ff',
        'selector-id': '#d7ba7d',
        'selector-class': '#d7ba7d',
        'selector-attr': '#2b91af',
        'selector-pseudo': '#2b91af',
    },
} satisfies ThemePalette;
/** Background color for this theme. */
export const bg = palette.bg;
/** Complete CSS stylesheet for this theme. */
export const css = buildThemeCss(palette);
