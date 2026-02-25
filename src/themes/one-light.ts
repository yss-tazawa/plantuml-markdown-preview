/**
 * @module themes/one-light
 * @description One Light theme.
 *
 * Off-white background (#fafafa), balanced color palette.
 * Inspired by Atom One Light.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the One Light theme. */
export const css = buildThemeCss({
    bg: '#fafafa',
    text: '#383a42',
    border: '#e0e0e0',
    link: '#4078f2',
    linkVisited: '#a626a4',
    codeBg: '#eaeaec',
    trEvenBg: '#f0f0f2',
    blockquoteBorder: '#e0e0e0',
    blockquoteColor: '#a0a1a7',
    blockquoteBg: '#eaeaec',
    hljsBg: '#eaeaec',
    hljsComment: '#a0a1a7',
    hljsKeyword: '#a626a4',
    hljsString: '#50a14f',
    hljsNumber: '#986801',
    hljsAttr: '#986801',
    hljsName: '#e45649',
    hljsTitle: '#4078f2',
    hljsBuiltIn: '#c18401',
    hljsSymbol: '#4078f2',
    hljsMeta: '#c18401',
    hljsAdditionBg: '#e6ffed',
    hljsAdditionColor: '#50a14f',
    hljsDeletionBg: '#ffeef0',
    hljsDeletionColor: '#e45649',
});
