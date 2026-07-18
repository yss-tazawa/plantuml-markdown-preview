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
import type { Config } from './config.js';
import { isManagedServerMode } from './config.js';
import {
    handleRenderFailure, handleRenderSuccess, ensureLocalServerStarted,
    waitForLocalServer, getLocalServerUrl, localServerUnavailableMessage,
} from './local-server.js';

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

/**
 * Encode 3 bytes into 4 PlantUML Base64 characters.
 *
 * Each 6-bit group is mapped to a character in PLANTUML_ALPHABET.
 *
 * @param b1 - First byte (0-255).
 * @param b2 - Second byte (0-255).
 * @param b3 - Third byte (0-255).
 * @returns 4-character encoded string.
 */
function encode3bytes(b1: number, b2: number, b3: number): string {
    const c1 = b1 >> 2;
    const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
    const c3 = ((b2 & 0xF) << 2) | (b3 >> 6);
    const c4 = b3 & 0x3F;
    return PLANTUML_ALPHABET[c1] + PLANTUML_ALPHABET[c2] + PLANTUML_ALPHABET[c3] + PLANTUML_ALPHABET[c4];
}

/**
 * Encode a Uint8Array using PlantUML's custom Base64 encoding.
 *
 * Processes 3 bytes at a time, padding the final group with zeros
 * when the input length is not a multiple of 3.
 *
 * @param data - Raw bytes to encode.
 * @returns PlantUML Base64-encoded string.
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
 * @param content - PlantUML source text (must include @startuml/@enduml).
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
 * Key components: content + plantumlServerUrl + plantumlTheme.
 *
 * @param content - PlantUML source text (with @startuml/@enduml).
 * @param config - Server URL and theme settings.
 * @returns SHA-256 hash string for cache lookup.
 */
function cacheKey(content: string, config: Config): string {
    return computeHash(content, config.plantumlServerUrl, config.plantumlTheme || 'default');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Endpoint-specific error box for a connection-level failure to the local
 * server (design: never show a raw fetch error like "fetch failed").
 * Exported for unit tests.
 *
 * @param baseUrl - Server base URL the fetch targeted.
 * @param err - The error thrown by fetch (AbortError = our 15s timeout fired).
 * @returns Styled HTML error div naming the endpoint.
 */
export function connectionErrorHtml(baseUrl: string, err: unknown): string {
    const endpoint = baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return errorHtml(timedOut
        ? vscode.l10n.t('Server did not respond within {0}s ({1})', String(DEFAULT_TIMEOUT_MS / 1000), endpoint)
        : vscode.l10n.t('Cannot reach server at {0}', endpoint));
}

/**
 * Connection-level failure handling for local-server mode ('fast'). The first
 * failed fetch of a render request reports to handleRenderFailure (first-line
 * loss detection; the confirmation probe is shared between concurrent renders)
 * and acts on the verdict:
 * - 'alive' (transient): retry the same fetch once.
 * - 'lost' + managed ('on'/'lazy'): hold THIS render, retry the server start
 *   (allowed from 'error'), and re-run the same fetch against the recovered URL
 *   (the port can change after an auto-port respawn). A failed start shows its
 *   reason in the diagram box, and the next render retries the start again.
 * - 'lost' + external ('off'): show the endpoint error. Every render keeps
 *   fetching the kept URL, so a revived server recovers the state via
 *   handleRenderSuccess without any manual action.
 *
 * @param config - Server settings (renderMode 'local-server').
 * @param doFetch - Single fetch attempt against a base URL.
 * @param firstError - The error of the failed first fetch.
 * @param signal - External cancellation signal.
 * @returns A Response on successful recovery, or an error-HTML string.
 */
async function recoverLocalServerRender(
    config: Config,
    doFetch: (baseUrl: string) => Promise<Response>,
    firstError: unknown,
    signal?: AbortSignal,
): Promise<Response | string> {
    const failedUrl = config.plantumlServerUrl;
    const verdict = await handleRenderFailure();
    if (signal?.aborted) return '';
    if (verdict === 'alive') {
        // Transient failure — the server is confirmed alive; retry once.
        try {
            return await doFetch(failedUrl);
        } catch (err) {
            if (signal?.aborted) return '';
            return connectionErrorHtml(failedUrl, err);
        }
    }
    if (isManagedServerMode(config)) {
        // Loss confirmed: wait for the restart within this same render request,
        // then re-run the fetch so the diagram shows instead of an error box.
        ensureLocalServerStarted(config);
        await waitForLocalServer();
        if (signal?.aborted) return '';
        const recoveredUrl = getLocalServerUrl();
        if (!recoveredUrl) return errorHtml(localServerUnavailableMessage(config));
        try {
            return await doFetch(recoveredUrl);
        } catch (err) {
            if (signal?.aborted) return '';
            return connectionErrorHtml(recoveredUrl, err);
        }
    }
    // External-connect ('off'): no spawn — this render shows the endpoint error.
    return connectionErrorHtml(failedUrl, firstError);
}

/**
 * Render PlantUML text to SVG via a PlantUML server (async).
 *
 * In local-server mode ('fast') a connection-level fetch failure additionally
 * feeds the loss detection / recovery flow (recoverLocalServerRender), and any
 * proper server response — including a syntax-error 400 + SVG — is reported as
 * proof of life (handleRenderSuccess) so an external server in 'error' state
 * recovers on its first successful response. Remote-server mode ('easy') is
 * untouched by all of this.
 *
 * @param pumlContent - Raw PlantUML source text (with or without @startuml/@enduml).
 * @param config - Server URL and theme settings.
 * @returns SVG markup on success, raw SVG on HTTP error with SVG body (e.g. syntax errors), or styled HTML error div on other failures.
 */
export async function renderToSvgServer(pumlContent: string, config: Config, signal?: AbortSignal): Promise<string> {
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

    // One fetch attempt with its own timeout, linked to the external signal.
    // Recovery may retry against a DIFFERENT base URL (auto-port respawn), so
    // the target is a parameter rather than baked in.
    const doFetch = async (baseUrl: string): Promise<Response> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            return await fetch(`${baseUrl.replace(/\/+$/, '')}/svg/${encoded}`, {
                signal: controller.signal,
                headers: { 'Accept': 'image/svg+xml' }
            });
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        }
    };

    if (signal?.aborted) return '';
    const isLocalServer = config.renderMode === 'local-server';

    let response: Response;
    try {
        response = await doFetch(config.plantumlServerUrl);
    } catch (err) {
        // External cancellation (user triggered) — never an error box.
        if (signal?.aborted) return '';
        if (!isLocalServer) {
            // Remote-server mode ('easy'): original behavior, unchanged.
            if (err instanceof Error && err.name === 'AbortError') {
                return errorHtml(vscode.l10n.t('PlantUML server request timed out'));
            }
            return errorHtml(
                vscode.l10n.t('PlantUML server connection error: {0}', escapeHtml(err instanceof Error ? err.message : String(err)))
            );
        }
        // Local-server mode: first-line loss detection + same-render recovery.
        const recovered = await recoverLocalServerRender(config, doFetch, err, signal);
        if (typeof recovered === 'string') return recovered;
        response = recovered;
    }

    const svg = await response.text();

    if (!response.ok) {
        // PlantUML server returns syntax errors as SVG with HTTP 400;
        // show the SVG so users can see error details visually.
        if (svg.includes('<svg') || svg.includes('<?xml')) {
            if (isLocalServer) handleRenderSuccess();
            return svg;
        }
        return errorHtml(
            vscode.l10n.t('PlantUML server error: {0}', `HTTP ${response.status} ${escapeHtml(response.statusText)}`)
        );
    }

    // Validate that we got SVG back (server may return error pages as HTML)
    if (!svg.includes('<svg') && !svg.includes('<?xml')) {
        return errorHtml(
            vscode.l10n.t('PlantUML server returned unexpected response')
        );
    }

    // Cache the result (errors are NOT cached)
    cache.set(hash, svg);
    if (isLocalServer) handleRenderSuccess();
    return svg;
}

/** Maximum number of concurrent HTTP requests to a remote PlantUML server. */
const MAX_SERVER_CONCURRENCY = 5;

/** Higher concurrency for local-server mode (localhost picoweb). */
export const MAX_LOCAL_SERVER_CONCURRENCY = 50;

/**
 * Render multiple PlantUML blocks via server with controlled concurrency.
 *
 * @param blocks - Array of PlantUML source texts.
 * @param config - Server URL and theme settings.
 * @param signal - Optional AbortSignal.
 * @param concurrency - Max parallel requests (default: 5 for remote servers).
 * @returns Map from trimmed content -> SVG string.
 */
export function renderAllServer(
    blocks: string[],
    config: Config,
    signal?: AbortSignal,
    concurrency = MAX_SERVER_CONCURRENCY
): Promise<Map<string, string>> {
    return batchRender(blocks, concurrency, (content, sig) => renderToSvgServer(content, config, sig), signal);
}

/**
 * Render PlantUML text to a PNG buffer via a PlantUML server (async).
 *
 * @param pumlContent - Raw PlantUML source text (with or without @startuml/@enduml).
 * @param config - Server URL and theme settings.
 * @param [signal] - Optional AbortSignal.
 * @returns PNG buffer on success, or null on failure.
 */
export async function renderToPngServer(pumlContent: string, config: Config, signal?: AbortSignal): Promise<Buffer | null> {
    const trimmed = pumlContent.trim();
    const content = ensureStartEndTags(trimmed);
    const themedContent = (config.plantumlTheme && config.plantumlTheme !== 'default')
        ? injectThemeDirective(content, config.plantumlTheme)
        : content;

    const encoded = encodePlantUml(themedContent);
    const url = `${config.plantumlServerUrl.replace(/\/+$/, '')}/png/${encoded}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    if (signal?.aborted) { clearTimeout(timeout); return null; }
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return null;
        return Buffer.from(await response.arrayBuffer());
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Render multiple PlantUML blocks to PNG buffers via server with controlled concurrency.
 *
 * @param blocks - Array of PlantUML source texts.
 * @param config - Server URL and theme settings.
 * @param [signal] - Optional AbortSignal.
 * @param [concurrency] - Max parallel requests.
 * @returns Map from trimmed content -> PNG buffer (null entries omitted).
 */
export async function renderAllServerPng(
    blocks: string[],
    config: Config,
    signal?: AbortSignal,
    concurrency = MAX_SERVER_CONCURRENCY
): Promise<Map<string, Buffer>> {
    const results = new Map<string, Buffer>();
    const unique = [...new Set(blocks.map(b => b.trim()))];
    for (let i = 0; i < unique.length; i += concurrency) {
        if (signal?.aborted) break;
        const batch = unique.slice(i, i + concurrency);
        const pngs = await Promise.all(batch.map(content =>
            signal?.aborted ? Promise.resolve(null) : renderToPngServer(content, config, signal)
        ));
        for (let j = 0; j < batch.length; j++) {
            if (pngs[j]) results.set(batch[j], pngs[j]!);
        }
    }
    return results;
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
 *
 * @param content - PlantUML source text (with @start tag).
 * @param theme - Theme name to inject (e.g. 'cerulean').
 * @returns Modified source with `!theme <name>` inserted after the @start line.
 */
function injectThemeDirective(content: string, theme: string): string {
    return content.replace(/^(@start\w+.*)$/m, `$1\n!theme ${theme}`);
}
