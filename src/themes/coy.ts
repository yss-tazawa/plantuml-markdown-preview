/**
 * @module themes/coy
 * @description Coy theme.
 *
 * Near-white background (#fdfdfd), distinctive left-border code blocks.
 * Inspired by the Prism.js Coy theme.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Coy theme. */
export const css = buildThemeCss({
    bg: '#fdfdfd',
    text: '#333333',
    border: '#e8e8e8',
    link: '#6196cc',
    linkVisited: '#7c6aba',
    codeBg: '#f5f2f0',
    trEvenBg: '#f9f9f9',
    blockquoteBorder: '#e8e8e8',
    blockquoteColor: '#777777',
    blockquoteBg: '#f5f2f0',
    hljsBg: '#fdfdfd',
    hljsComment: '#708090',
    hljsKeyword: '#0077aa',
    hljsString: '#669900',
    hljsNumber: '#990055',
    hljsAttr: '#0077aa',
    hljsName: '#dd4a68',
    hljsTitle: '#dd4a68',
    hljsBuiltIn: '#999999',
    hljsSymbol: '#6196cc',
    hljsMeta: '#999999',
    hljsAdditionBg: '#e6ffed',
    hljsAdditionColor: '#669900',
    hljsDeletionBg: '#ffeef0',
    hljsDeletionColor: '#dd4a68',
});
