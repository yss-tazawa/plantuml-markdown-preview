/**
 * @module themes/vscode-dark-2026
 * @description VS Code Dark 2026 theme.
 *
 * Near-black background (#121314), light gray text (#bbbebf).
 * Colors from VS Code 1.146.0's Dark 2026 theme and built-in preview CSS.
 * Syntax tokens follow the dark rules of the preview's highlight.css.
 */
import { buildThemeCss, type ThemePalette } from './base.js';

/** Color palette for the VS Code Dark 2026 theme (exported for the vscode theme). */
export const palette = {
    bg: '#121314',
    text: '#bbbebf',
    border: '#3d3d3e',
    link: '#48a0c7',
    linkVisited: '#48a0c7',
    codeBg: '#262626',
    codeText: '#8c8c8c',
    preBorder: '#2a2b2c',
    trEvenBg: '#121314',
    blockquoteBorder: '#2a2b2c',
    blockquoteColor: '#bbbebf',
    blockquoteBg: '#242526',
    hljsBg: '#242526',
    hljsComment: '#57a64a',
    hljsKeyword: '#569cd6',
    hljsString: '#d69d85',
    hljsNumber: '#b8d7a3',
    hljsAttr: '#9cdcfe',
    hljsName: '#569cd6',
    hljsTitle: '#dcdcdc',
    hljsBuiltIn: '#4ec9b0',
    hljsSymbol: '#569cd6',
    hljsMeta: '#9b9b9b',
    hljsAdditionBg: '#334d36',
    hljsAdditionColor: '#9bb955',
    hljsDeletionBg: '#633c3a',
    hljsDeletionColor: '#ff0000',
    thBg: 'transparent',
    thBorder: '#b6b6b6',
    hljsTitleWeight: 'normal',
    hljsLinkUnderline: true,
    hljsCommentTokens: ['comment', 'quote'],
    hljsDiffFullLine: true,
    hljsTokens: {
        keyword: '#569cd6',
        literal: '#569cd6',
        symbol: '#569cd6',
        name: '#569cd6',
        link: '#569cd6',
        built_in: '#4ec9b0',
        type: '#4ec9b0',
        number: '#b8d7a3',
        class: '#b8d7a3',
        string: '#d69d85',
        'meta-string': '#d69d85',
        regexp: '#9a5334',
        'template-tag': '#9a5334',
        subst: '#dcdcdc',
        function: '#dcdcdc',
        title: '#dcdcdc',
        params: '#dcdcdc',
        formula: '#dcdcdc',
        comment: '#57a64a',
        quote: '#57a64a',
        doctag: '#608b4e',
        meta: '#9b9b9b',
        'meta-keyword': '#9b9b9b',
        tag: '#9b9b9b',
        variable: '#bd63c5',
        'template-variable': '#bd63c5',
        attr: '#9cdcfe',
        attribute: '#9cdcfe',
        'builtin-name': '#9cdcfe',
        section: 'gold',
        bullet: '#d7ba7d',
        'selector-tag': '#d7ba7d',
        'selector-id': '#d7ba7d',
        'selector-class': '#d7ba7d',
        'selector-attr': '#d7ba7d',
        'selector-pseudo': '#d7ba7d',
    },
} satisfies ThemePalette;
/** Background color for this theme. */
export const bg = palette.bg;
/** Complete CSS stylesheet for this theme. */
export const css = buildThemeCss(palette);
