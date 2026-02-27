/**
 * @module utils
 * @description Shared utility functions used across multiple modules.
 */
import crypto from 'crypto';
import path from 'path';

/** Lookup table mapping HTML special characters to their entity references. */
const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Regular expression matching any HTML special character that requires escaping. */
const HTML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escape HTML special characters (XSS prevention).
 *
 * Uses a single-pass replacement instead of chained .replace() calls
 * to avoid creating intermediate string objects.
 *
 * @param {string} str - Raw string that may contain HTML special characters.
 * @returns {string} Escaped string safe for HTML insertion.
 */
export function escapeHtml(str: string): string {
    return String(str).replace(HTML_ESCAPE_RE, ch => HTML_ESCAPE_MAP[ch]);
}

/**
 * Generate a cryptographically random string for CSP nonce.
 *
 * Produces a unique 32-character hex string per render cycle using
 * crypto.randomBytes. Used to authorize inline scripts in the Webview
 * while blocking user-authored script tags.
 *
 * @returns {string} 32-character hexadecimal nonce string.
 */
export function getNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

/** Regex matching <img ...src="..." ...> or <img ...src='...' ...> tags. Captures prefix, quote, src value, and suffix. */
const IMG_SRC_RE = /<img\s([^>]*?)src=(["'])(.*?)\2([^>]*?)>/gi;

/** Schemes that should not be resolved as local paths. */
const ABSOLUTE_SRC_RE = /^(https?:|data:|vscode-webview:|\/\/)/i;

/**
 * Replace relative image paths in rendered HTML with resolved URIs.
 *
 * Finds all `<img src="...">` and `<img src='...'>` tags whose src is a
 * relative path and converts them using the provided resolver function.
 * Absolute URLs, data URIs, and vscode-webview URIs are left untouched.
 *
 * @param {string} html - Rendered HTML string.
 * @param {string} baseDirPath - Absolute directory path to resolve relative paths against.
 * @param {(absolutePath: string) => string} toUri - Converts an absolute file path to a displayable URI.
 * @returns {string} HTML with resolved image paths.
 */
export function resolveLocalImagePaths(html: string, baseDirPath: string, toUri: (absolutePath: string) => string): string {
    return html.replace(IMG_SRC_RE, (match, pre: string, quote: string, src: string, post: string) => {
        if (ABSOLUTE_SRC_RE.test(src)) return match;
        const absolutePath = path.isAbsolute(src) ? src : path.resolve(baseDirPath, src);
        const uri = toUri(absolutePath).replace(/"/g, '&quot;');
        return `<img ${pre}src="${uri}"${post}>`;
    });
}
