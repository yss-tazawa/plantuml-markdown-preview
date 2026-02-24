/**
 * @module themes/solarized-light
 * @description Solarized Light theme.
 *
 * Warm beige background (#fdf6e3), eye-friendly accent colors.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Solarized Light theme. */
export const css = buildThemeCss({
    bg: '#fdf6e3',
    text: '#657b83',
    headingColor: '#586e75',
    border: '#eee8d5',
    link: '#268bd2',
    linkVisited: '#6c71c4',
    codeBg: '#eee8d5',
    codeText: '#586e75',
    trEvenBg: '#f5f0e6',
    blockquoteBorder: '#93a1a1',
    blockquoteColor: '#93a1a1',
    blockquoteBg: '#eee8d5',
    hljsBg: '#fdf6e3',
    hljsComment: '#93a1a1',
    hljsKeyword: '#859900',
    hljsString: '#2aa198',
    hljsNumber: '#268bd2',
    hljsAttr: '#b58900',
    hljsName: '#268bd2',
    hljsTitle: '#268bd2',
    hljsBuiltIn: '#cb4b16',
    hljsSymbol: '#2aa198',
    hljsMeta: '#cb4b16',
    hljsAdditionBg: '#d9f2d0',
    hljsAdditionColor: '#859900',
    hljsDeletionBg: '#fbe3e3',
    hljsDeletionColor: '#dc322f',
});
