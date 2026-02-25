/**
 * @module themes/pen-paper-coffee
 * @description Pen Paper Coffee theme.
 *
 * Warm paper background (#f5f0e7), brown-tinted text (#4a4543).
 * A cozy, paper-and-ink aesthetic reminiscent of handwritten notes.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Pen Paper Coffee theme. */
export const css = buildThemeCss({
    bg: '#f5f0e7',
    text: '#4a4543',
    headingColor: '#3b3836',
    border: '#d6cfc4',
    link: '#8b6914',
    linkVisited: '#6a5acd',
    codeBg: '#e8e0d3',
    trEvenBg: '#ede6db',
    blockquoteBorder: '#c4b9a7',
    blockquoteColor: '#998a7a',
    blockquoteBg: '#e8e0d3',
    hljsBg: '#e8e0d3',
    hljsComment: '#998a7a',
    hljsKeyword: '#8b4513',
    hljsString: '#6b8e23',
    hljsNumber: '#cd5c5c',
    hljsAttr: '#8b6914',
    hljsName: '#2e8b57',
    hljsTitle: '#6a5acd',
    hljsBuiltIn: '#b8860b',
    hljsSymbol: '#8b6914',
    hljsMeta: '#b8860b',
    hljsAdditionBg: '#dce8d0',
    hljsAdditionColor: '#6b8e23',
    hljsDeletionBg: '#f0d8d8',
    hljsDeletionColor: '#cd5c5c',
});
