/**
 * @module themes/dracula
 * @description Dracula theme.
 *
 * Dark background (#282a36), vivid accent palette (pink, cyan, green).
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Dracula theme. */
export const css = buildThemeCss({
    bg: '#282a36',
    text: '#f8f8f2',
    headingColor: '#f8f8f2',
    border: '#44475a',
    link: '#8be9fd',
    linkVisited: '#bd93f9',
    codeBg: '#44475a',
    trEvenBg: '#21222c',
    blockquoteBorder: '#6272a4',
    blockquoteColor: '#6272a4',
    blockquoteBg: '#21222c',
    hljsBg: '#282a36',
    hljsComment: '#6272a4',
    hljsKeyword: '#ff79c6',
    hljsString: '#f1fa8c',
    hljsNumber: '#bd93f9',
    hljsAttr: '#50fa7b',
    hljsName: '#ff79c6',
    hljsTitle: '#50fa7b',
    hljsBuiltIn: '#8be9fd',
    hljsSymbol: '#8be9fd',
    hljsMeta: '#ffb86c',
    hljsAdditionBg: '#155d27',
    hljsAdditionColor: '#50fa7b',
    hljsDeletionBg: '#5b1818',
    hljsDeletionColor: '#ff5555',
});
