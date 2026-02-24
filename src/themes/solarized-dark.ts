/**
 * @module themes/solarized-dark
 * @description Solarized Dark theme.
 *
 * Deep teal background (#002b36), eye-friendly accent colors.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Solarized Dark theme. */
export const css = buildThemeCss({
    bg: '#002b36',
    text: '#839496',
    headingColor: '#93a1a1',
    border: '#073642',
    link: '#268bd2',
    linkVisited: '#6c71c4',
    codeBg: '#073642',
    trEvenBg: '#00313d',
    blockquoteBorder: '#586e75',
    blockquoteColor: '#586e75',
    blockquoteBg: '#073642',
    hljsBg: '#002b36',
    hljsComment: '#586e75',
    hljsKeyword: '#859900',
    hljsString: '#2aa198',
    hljsNumber: '#268bd2',
    hljsAttr: '#b58900',
    hljsName: '#268bd2',
    hljsTitle: '#268bd2',
    hljsBuiltIn: '#cb4b16',
    hljsSymbol: '#2aa198',
    hljsMeta: '#cb4b16',
    hljsAdditionBg: '#0d4b1c',
    hljsAdditionColor: '#859900',
    hljsDeletionBg: '#3b0a0a',
    hljsDeletionColor: '#dc322f',
});
