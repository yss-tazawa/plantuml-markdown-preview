/**
 * @module themes/atom-light
 * @description Atom Light theme.
 *
 * White background (#ffffff), soft gray text (#555555).
 * Inspired by Atom's default light UI.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Atom Light theme. */
export const css = buildThemeCss({
    bg: '#ffffff',
    text: '#555555',
    headingColor: '#111111',
    border: '#eeeeee',
    link: '#4078c0',
    linkVisited: '#6a5acd',
    codeBg: '#f7f7f7',
    trEvenBg: '#f9f9f9',
    blockquoteBorder: '#dddddd',
    blockquoteColor: '#888888',
    blockquoteBg: '#f7f7f7',
    hljsBg: '#f7f7f7',
    hljsComment: '#a0a1a7',
    hljsKeyword: '#a626a4',
    hljsString: '#50a14f',
    hljsNumber: '#986801',
    hljsAttr: '#986801',
    hljsName: '#4078f2',
    hljsTitle: '#4078f2',
    hljsBuiltIn: '#c18401',
    hljsSymbol: '#4078c0',
    hljsMeta: '#c18401',
    hljsAdditionBg: '#e6ffed',
    hljsAdditionColor: '#50a14f',
    hljsDeletionBg: '#ffeef0',
    hljsDeletionColor: '#e45649',
});
