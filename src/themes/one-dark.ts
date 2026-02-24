/**
 * @module themes/one-dark
 * @description One Dark theme.
 *
 * Dark background (#282c34), muted text (#abb2bf).
 * Inspired by Atom / VS Code One Dark palette.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the One Dark theme. */
export const css = buildThemeCss({
    bg: '#282c34',
    text: '#abb2bf',
    headingColor: '#e6edf3',
    border: '#3e4451',
    link: '#61afef',
    linkVisited: '#c678dd',
    codeBg: '#21252b',
    trEvenBg: '#2c313a',
    blockquoteBorder: '#3e4451',
    blockquoteColor: '#5c6370',
    blockquoteBg: '#21252b',
    hljsBg: '#282c34',
    hljsComment: '#5c6370',
    hljsKeyword: '#c678dd',
    hljsString: '#98c379',
    hljsNumber: '#d19a66',
    hljsAttr: '#d19a66',
    hljsName: '#e06c75',
    hljsTitle: '#61afef',
    hljsBuiltIn: '#e5c07b',
    hljsSymbol: '#61afef',
    hljsMeta: '#e5c07b',
    hljsAdditionBg: '#1e3a29',
    hljsAdditionColor: '#98c379',
    hljsDeletionBg: '#3b1c1c',
    hljsDeletionColor: '#e06c75',
});
