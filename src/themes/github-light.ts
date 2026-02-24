/**
 * @module themes/github-light
 * @description GitHub Light theme (default).
 *
 * White background (#ffffff), dark text (#24292e).
 * Code blocks styled after github-dark-dimmed palette.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the GitHub Light theme. */
export const css = buildThemeCss({
    bg: '#ffffff',
    text: '#24292e',
    border: '#e1e4e8',
    link: '#0366d6',
    linkVisited: '#6f42c1',
    codeBg: '#f6f8fa',
    tableBorder: '#dfe2e5',
    trEvenBg: '#fafbfc',
    blockquoteBorder: '#dfe2e5',
    blockquoteColor: '#6a737d',
    blockquoteBg: '#f6f8fa',
    hljsBg: '#f6f8fa',
    hljsComment: '#6a737d',
    hljsKeyword: '#d73a49',
    hljsString: '#032f62',
    hljsNumber: '#005cc5',
    hljsAttr: '#005cc5',
    hljsName: '#22863a',
    hljsTitle: '#6f42c1',
    hljsBuiltIn: '#e36209',
    hljsSymbol: '#0366d6',
    hljsMeta: '#e36209',
    hljsAdditionBg: '#e6ffed',
    hljsAdditionColor: '#22863a',
    hljsDeletionBg: '#ffeef0',
    hljsDeletionColor: '#b31d28',
});
