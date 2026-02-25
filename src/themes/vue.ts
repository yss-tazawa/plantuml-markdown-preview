/**
 * @module themes/vue
 * @description Vue theme.
 *
 * White background (#ffffff), green accents (#42b983).
 * Inspired by the Vue.js documentation style.
 */
import { buildThemeCss } from './base.js';

/** Complete CSS string for the Vue theme. */
export const css = buildThemeCss({
    bg: '#ffffff',
    text: '#34495e',
    headingColor: '#2c3e50',
    border: '#eaecef',
    link: '#42b983',
    linkVisited: '#3a7563',
    codeBg: '#f3f5f7',
    codeText: '#476582',
    trEvenBg: '#f9fafb',
    blockquoteBorder: '#42b983',
    blockquoteColor: '#7f8c8d',
    blockquoteBg: '#f3f5f7',
    hljsBg: '#f3f5f7',
    hljsComment: '#8e908c',
    hljsKeyword: '#8959a8',
    hljsString: '#718c00',
    hljsNumber: '#f5871f',
    hljsAttr: '#c82829',
    hljsName: '#4271ae',
    hljsTitle: '#4271ae',
    hljsBuiltIn: '#3d999f',
    hljsSymbol: '#42b983',
    hljsMeta: '#f5871f',
    hljsAdditionBg: '#e6ffed',
    hljsAdditionColor: '#42b983',
    hljsDeletionBg: '#ffeef0',
    hljsDeletionColor: '#c82829',
});
