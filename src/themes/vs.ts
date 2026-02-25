/**
 * @module themes/vs
 * @description Visual Studio Light theme.
 *
 * White background (#ffffff), classic Visual Studio color scheme.
 * Blue keywords, green comments, red strings.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Visual Studio Light theme. */
export const css = buildThemeCss({
    bg: '#ffffff',
    text: '#1e1e1e',
    border: '#e7e7e7',
    link: '#0451a5',
    linkVisited: '#6f42c1',
    codeBg: '#f4f4f4',
    trEvenBg: '#f9f9f9',
    blockquoteBorder: '#e7e7e7',
    blockquoteColor: '#6a6a6a',
    blockquoteBg: '#f4f4f4',
    hljsBg: '#f4f4f4',
    hljsComment: '#008000',
    hljsKeyword: '#0000ff',
    hljsString: '#a31515',
    hljsNumber: '#098658',
    hljsAttr: '#0451a5',
    hljsName: '#800000',
    hljsTitle: '#795e26',
    hljsBuiltIn: '#267f99',
    hljsSymbol: '#0451a5',
    hljsMeta: '#795e26',
    hljsAdditionBg: '#e6ffed',
    hljsAdditionColor: '#008000',
    hljsDeletionBg: '#ffeef0',
    hljsDeletionColor: '#a31515',
});
