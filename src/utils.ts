/**
 * @module utils
 * @description Shared utility functions used across multiple modules.
 */
import crypto from 'crypto';

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
