/**
 * @module themes/atom-dark
 * @description Atom Dark theme.
 *
 * Dark background (#1d1f21), muted text (#c5c8c6).
 * Inspired by Atom's Tomorrow Night color palette.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Atom Dark theme. */
export const css = buildThemeCss({
    bg: '#1d1f21',
    text: '#c5c8c6',
    headingColor: '#e0e0e0',
    border: '#373b41',
    link: '#81a2be',
    linkVisited: '#b294bb',
    codeBg: '#2d2f31',
    trEvenBg: '#252729',
    blockquoteBorder: '#373b41',
    blockquoteColor: '#969896',
    blockquoteBg: '#2d2f31',
    hljsBg: '#2d2f31',
    hljsComment: '#969896',
    hljsKeyword: '#b294bb',
    hljsString: '#b5bd68',
    hljsNumber: '#de935f',
    hljsAttr: '#de935f',
    hljsName: '#cc6666',
    hljsTitle: '#81a2be',
    hljsBuiltIn: '#f0c674',
    hljsSymbol: '#81a2be',
    hljsMeta: '#f0c674',
    hljsAdditionBg: '#1b3a1b',
    hljsAdditionColor: '#b5bd68',
    hljsDeletionBg: '#3b1818',
    hljsDeletionColor: '#cc6666',
});
