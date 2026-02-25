/**
 * @module themes/monokai
 * @description Monokai theme.
 *
 * Dark background (#272822), vivid syntax colors.
 * Inspired by the iconic Sublime Text Monokai color scheme.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Monokai theme. */
export const css = buildThemeCss({
    bg: '#272822',
    text: '#f8f8f2',
    border: '#49483e',
    link: '#66d9ef',
    linkVisited: '#ae81ff',
    codeBg: '#3e3d32',
    trEvenBg: '#2e2f2a',
    blockquoteBorder: '#49483e',
    blockquoteColor: '#75715e',
    blockquoteBg: '#3e3d32',
    hljsBg: '#3e3d32',
    hljsComment: '#75715e',
    hljsKeyword: '#f92672',
    hljsString: '#e6db74',
    hljsNumber: '#ae81ff',
    hljsAttr: '#a6e22e',
    hljsName: '#f92672',
    hljsTitle: '#a6e22e',
    hljsBuiltIn: '#66d9ef',
    hljsSymbol: '#66d9ef',
    hljsMeta: '#f92672',
    hljsAdditionBg: '#1b3a1b',
    hljsAdditionColor: '#a6e22e',
    hljsDeletionBg: '#3b1818',
    hljsDeletionColor: '#f92672',
});
