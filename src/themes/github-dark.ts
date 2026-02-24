/**
 * @module themes/github-dark
 * @description GitHub Dark theme.
 *
 * Dark background (#0d1117), light text (#e6edf3).
 * Code blocks styled after github-dark palette.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the GitHub Dark theme. */
export const css = buildThemeCss({
    bg: '#0d1117',
    text: '#e6edf3',
    border: '#21262d',
    link: '#58a6ff',
    linkVisited: '#bc8cff',
    codeBg: '#161b22',
    preBorder: 'rgba(255, 255, 255, 0.1)',
    tableBorder: '#30363d',
    trEvenBg: '#0d1117',
    blockquoteBorder: '#30363d',
    blockquoteColor: '#8b949e',
    blockquoteBg: '#161b22',
    hljsBg: '#0d1117',
    hljsText: '#c9d1d9',
    hljsComment: '#8b949e',
    hljsKeyword: '#ff7b72',
    hljsString: '#a5d6ff',
    hljsNumber: '#79c0ff',
    hljsAttr: '#79c0ff',
    hljsName: '#7ee787',
    hljsTitle: '#d2a8ff',
    hljsBuiltIn: '#ffa657',
    hljsSymbol: '#58a6ff',
    hljsMeta: '#ffa657',
    hljsAdditionBg: '#033a16',
    hljsAdditionColor: '#aff5b4',
    hljsDeletionBg: '#67060c',
    hljsDeletionColor: '#ffdcd7',
});
