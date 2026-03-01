/**
 * @module plantuml-server
 * @description PlantUML server rendering — encodes PlantUML text and fetches SVG from a PlantUML server.
 *
 * Key behaviors:
 * - encodePlantUml: PlantUML text -> URL path segment (UTF-8 -> raw deflate -> custom Base64)
 * - renderToSvgServer: PlantUML text -> SVG string (async, HTTP fetch)
 * - renderAllServer: render multiple blocks with controlled concurrency (max 5)
 * - Independent LRU cache (SHA-256 key, max 200 entries)
 * - Theme injection via `!theme` directive (server cannot use -theme CLI flag)
 * - Uses Node.js 18+ fetch API (no external dependencies)
 */
import * as vscode from 'vscode';
import { deflateRawSync } from 'zlib';
import { escapeHtml, ensureStartEndTags, errorHtml, LruCache, computeHash, batchRender } from './utils.js';

/** Configuration for server-based rendering. */
export interface ServerConfig {
    /** PlantUML server base URL (e.g. 'https://www.plantuml.com/plantuml'). */
    serverUrl: string;
    /** PlantUML theme name. 'default' means no theme. */
    plantumlTheme?: string;
}

// ---------------------------------------------------------------------------
// PlantUML custom Base64 encoding
// ---------------------------------------------------------------------------

/**
 * PlantUML custom Base64 alphabet: 0-9A-Za-z-_
 *
 * Unlike standard Base64 (A-Za-z0-9+/) or URL-safe Base64 (A-Za-z0-9-_),
 * PlantUML starts with digits: indices 0-9 -> '0'-'9', 10-35 -> 'A'-'Z',
 * 36-61 -> 'a'-'z', 62 -> '-', 63 -> '_'.
 */
const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/** Encode 3 bytes into 4 PlantUML Base64 characters. */
function encode3bytes(b1: number, b2: number, b3: number): string {
    const c1 = b1 >> 2;
    const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
    const c3 = ((b2 & 0xF) << 2) | (b3 >> 6);
    const c4 = b3 & 0x3F;
    return PLANTUML_ALPHABET[c1] + PLANTUML_ALPHABET[c2] + PLANTUML_ALPHABET[c3] + PLANTUML_ALPHABET[c4];
}

/**
 * Encode a Uint8Array using PlantUML's custom Base64 encoding.
 * Processes 3 bytes at a time, padding final group with zeros.
 */
function plantumlEncode(data: Uint8Array): string {
    let result = '';
    const len = data.length;
    for (let i = 0; i < len; i += 3) {
        const b1 = data[i];
        const b2 = i + 1 < len ? data[i + 1] : 0;
        const b3 = i + 2 < len ? data[i + 2] : 0;
        result += encode3bytes(b1, b2, b3);
    }
    return result;
}

/**
 * Encode PlantUML text for use in a server URL path segment.
 *
 * Algorithm: UTF-8 encode -> raw deflate (RFC 1951) -> PlantUML custom Base64.
 *
 * @param content PlantUML source text (must include @startuml/@enduml).
 * @returns Encoded string for URL path segment.
 */
export function encodePlantUml(content: string): string {
    const utf8 = Buffer.from(content, 'utf-8');
    const deflated = deflateRawSync(utf8, { level: 9 });
    return plantumlEncode(new Uint8Array(deflated));
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

/** LRU cache mapping SHA-256 hash -> SVG string. */
const cache = new LruCache<string>(200);

/** Default HTTP request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Compute a cache key for server rendering.
 * Key components: content + serverUrl + plantumlTheme.
 */
function cacheKey(content: string, config: ServerConfig): string {
    return computeHash(content, config.serverUrl, config.plantumlTheme || 'default');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render PlantUML text to SVG via a PlantUML server (async).
 *
 * @param pumlContent Raw PlantUML source text (with or without @startuml/@enduml).
 * @param config Server URL and theme settings.
 * @returns SVG markup on success, or styled HTML error div on failure.
 */
export async function renderToSvgServer(pumlContent: string, config: ServerConfig, signal?: AbortSignal): Promise<string> {
    const trimmed = pumlContent.trim();
    const content = ensureStartEndTags(trimmed);

    // Apply theme by injecting !theme directive (server cannot use -theme CLI flag)
    const themedContent = (config.plantumlTheme && config.plantumlTheme !== 'default')
        ? injectThemeDirective(content, config.plantumlTheme)
        : content;

    const hash = cacheKey(themedContent, config);

    // LRU cache lookup
    const cached = cache.get(hash);
    if (cached !== undefined) return cached;

    const encoded = encodePlantUml(themedContent);
    const url = `${config.serverUrl.replace(/\/+$/, '')}/svg/${encoded}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    // Link external signal (e.g. from renderPanel) to our controller
    if (signal?.aborted) { clearTimeout(timeout); return ''; }
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'image/svg+xml' }
        });

        if (!response.ok) {
            return errorHtml(
                vscode.l10n.t('PlantUML server error: {0}', `HTTP ${response.status} ${escapeHtml(response.statusText)}`)
            );
        }

        const svg = await response.text();

        // Validate that we got SVG back (server may return error pages as HTML)
        if (!svg.includes('<svg') && !svg.includes('<?xml')) {
            return errorHtml(
                vscode.l10n.t('PlantUML server returned unexpected response')
            );
        }

        // Cache the result (errors are NOT cached)
        cache.set(hash, svg);
        return svg;
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            // Distinguish external cancellation (user triggered) from timeout
            if (signal?.aborted) return '';
            return errorHtml(vscode.l10n.t('PlantUML server request timed out'));
        }
        return errorHtml(
            vscode.l10n.t('PlantUML server connection error: {0}', escapeHtml((err as Error).message))
        );
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** Maximum number of concurrent HTTP requests to the PlantUML server. */
const MAX_SERVER_CONCURRENCY = 5;

/**
 * Render multiple PlantUML blocks via server with controlled concurrency.
 *
 * Sends up to MAX_SERVER_CONCURRENCY requests in parallel to balance
 * throughput against server load.
 *
 * @param blocks Array of PlantUML source texts.
 * @param config Server URL and theme settings.
 * @returns Map from trimmed content -> SVG string.
 */
export function renderAllServer(
    blocks: string[],
    config: ServerConfig,
    signal?: AbortSignal
): Promise<Map<string, string>> {
    return batchRender(blocks, MAX_SERVER_CONCURRENCY, (content, sig) => renderToSvgServer(content, config, sig), signal);
}

/** Clear the server SVG cache. */
export function clearServerCache(): void {
    cache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject !theme directive after @startuml/@startXXX line.
 * Server mode cannot use -theme CLI arg, so we embed the directive in the source.
 */
function injectThemeDirective(content: string, theme: string): string {
    return content.replace(/^(@start\w+.*)$/m, `$1\n!theme ${theme}`);
}
