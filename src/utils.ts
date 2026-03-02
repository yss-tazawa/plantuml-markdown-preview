/**
 * @module utils
 * @description Shared utility functions used across multiple modules.
 */
import crypto from 'crypto';
import path from 'path';
import {
    spawn as nodeSpawn, spawnSync as nodeSpawnSync, execFile as nodeExecFile,
    type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns,
} from 'child_process';

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
 * @param str - Raw string that may contain HTML special characters.
 * @returns Escaped string safe for HTML insertion.
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
 * @returns 32-character hexadecimal nonce string.
 */
export function getNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Auto-wrap content with @startuml / @enduml if no @start tag is present.
 * Recognizes all PlantUML start tags (@startuml, @startmindmap, @startwbs, etc.).
 *
 * @param content - Trimmed PlantUML source text.
 * @returns Content guaranteed to have @startuml/@enduml wrapper tags (if no @start tag was present).
 */
export function ensureStartEndTags(content: string): string {
    if (!content.startsWith('@start')) {
        return `@startuml\n${content}\n@enduml`;
    }
    return content;
}

/**
 * Wrap an error message in a red-bordered styled HTML div.
 *
 * @param message - HTML content (may include tags) to display inside the error box.
 * @returns Complete HTML div string with error styling.
 */
export function errorHtml(message: string): string {
    return `<div style="border:1px solid #f66;background:#fff0f0;padding:0.5em 1em;border-radius:4px;color:#c00;font-size:0.9em;text-align:left;">${message}</div>`;
}

/**
 * Regex to match ```plantuml fenced code blocks and capture their content.
 * Allows 0-3 spaces of indentation on opening/closing fences (CommonMark spec).
 * Closing fence must be followed only by optional spaces/tabs then end-of-line
 * (CommonMark: text after the closing fence means it is not a valid closing fence).
 * Use with `new RegExp(source, flags)` to get a fresh stateful copy for `exec()` loops.
 */
export const PLANTUML_FENCE_RE_SOURCE = '^ {0,3}```plantuml[ \\t]*\\n([\\s\\S]*?)\\n {0,3}```[ \\t]*$';

/** Simple test regex to detect ```plantuml fenced code blocks (no capture). */
export const PLANTUML_FENCE_TEST_RE = /^ {0,3}```plantuml/im;

/** Simple test regex to detect ```mermaid fenced code blocks (no capture). */
export const MERMAID_FENCE_TEST_RE = /^ {0,3}```mermaid/im;

/** Regex source for ```mermaid fenced code blocks (with capture). */
export const MERMAID_FENCE_RE_SOURCE = '^ {0,3}```mermaid[ \\t]*\\n([\\s\\S]*?)\\n {0,3}```[ \\t]*$';

/**
 * Extract PlantUML block contents from Markdown source in document order.
 *
 * @param source Raw Markdown text.
 * @returns Array of PlantUML source text strings.
 */
export function extractPlantUmlBlocks(source: string): string[] {
    const blocks: string[] = [];
    const re = new RegExp(PLANTUML_FENCE_RE_SOURCE, 'gim');
    let match;
    while ((match = re.exec(source)) !== null) {
        blocks.push(match[1]);
    }
    return blocks;
}

/**
 * Extract Mermaid block contents from Markdown source in document order.
 *
 * @param source Raw Markdown text.
 * @returns Array of Mermaid source text strings.
 */
export function extractMermaidBlocks(source: string): string[] {
    const blocks: string[] = [];
    const re = new RegExp(MERMAID_FENCE_RE_SOURCE, 'gim');
    let match;
    while ((match = re.exec(source)) !== null) {
        blocks.push(match[1]);
    }
    return blocks;
}

/**
 * Simple LRU cache backed by a Map.
 *
 * Entries are kept in insertion order; a `get` hit moves the entry to the
 * end (most recently used). When the cache exceeds `maxSize`, the oldest
 * (least recently used) entry is evicted.
 */
export class LruCache<V> {
    private readonly map = new Map<string, V>();
    constructor(private readonly maxSize: number) {}

    get(key: string): V | undefined {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key)!;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key: string, value: V): void {
        if (this.map.has(key)) this.map.delete(key);
        if (this.map.size >= this.maxSize) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) this.map.delete(oldest);
        }
        this.map.set(key, value);
    }

    clear(): void {
        this.map.clear();
    }
}

/**
 * Compute a SHA-256 hash from one or more string parts, separated by null bytes.
 *
 * Used as a cache key for PlantUML rendering results. Centralises the hashing
 * logic previously duplicated in plantuml.ts and plantuml-server.ts.
 *
 * @param parts - Strings to hash (content, paths, theme, etc.).
 * @returns Hex-encoded SHA-256 hash.
 */
export function computeHash(...parts: string[]): string {
    const h = crypto.createHash('sha256');
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) h.update('\0');
        h.update(parts[i]);
    }
    return h.digest('hex');
}

/**
 * Render multiple items in batches with controlled concurrency.
 *
 * Processes up to `concurrency` items in parallel, then moves to the next batch.
 * Returns a Map keyed by trimmed input content.
 *
 * @param blocks - Array of source texts to render.
 * @param concurrency - Maximum number of concurrent render operations.
 * @param renderFn - Async function that renders a single block.
 * @param [signal] - Optional signal to cancel remaining operations.
 * @returns Map of trimmed content -> rendered output.
 */
export async function batchRender(
    blocks: string[],
    concurrency: number,
    renderFn: (content: string, signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal
): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const uniqueBlocks = [...new Set(blocks)];
    for (let i = 0; i < uniqueBlocks.length; i += concurrency) {
        if (signal?.aborted) break;
        const batch = uniqueBlocks.slice(i, i + concurrency);
        const svgs = await Promise.all(batch.map(content =>
            signal?.aborted ? Promise.resolve('') : renderFn(content, signal)
        ));
        for (let j = 0; j < batch.length; j++) {
            results.set(batch[j].trim(), svgs[j]);
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Java process helpers — centralised shell: true + JAVA_HOME resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Java executable command.
 *
 * Priority:
 * 1. Explicit user setting (anything other than the default 'java')
 * 2. JAVA_HOME environment variable → `$JAVA_HOME/bin/java`
 * 3. Plain `'java'` (relies on PATH)
 *
 * All spawn/exec wrappers below call this, so the resolution logic lives in
 * exactly one place.
 */
export function resolveJavaCommand(configJavaPath: string): string {
    const p = configJavaPath || 'java';
    if (p !== 'java') return p;
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) return path.join(javaHome, 'bin', 'java');
    return 'java';
}

/**
 * Spawn a Java child process (async).
 *
 * Wraps Node `spawn` with {@link resolveJavaCommand} so that JAVA_HOME
 * resolution works reliably on all platforms.
 *
 * @param configJavaPath - The `javaPath` value from extension settings.
 * @param args - CLI arguments passed to the Java process.
 * @param options - Node.js `SpawnOptions` (stdio, env, etc.).
 * @returns The spawned child process.
 */
export function spawnJava(configJavaPath: string, args: string[], options?: SpawnOptions): ChildProcess {
    return nodeSpawn(resolveJavaCommand(configJavaPath), args, options ?? {});
}

/**
 * Spawn a Java child process (sync).
 *
 * Wraps Node `spawnSync` with the same resolution as {@link spawnJava}.
 * Output encoding is forced to `'utf8'` so the return type is always
 * `SpawnSyncReturns<string>`.
 *
 * @param configJavaPath - The `javaPath` value from extension settings.
 * @param args - CLI arguments passed to the Java process.
 * @param options - Node.js `SpawnSyncOptions` (input, timeout, etc.).
 * @returns Synchronous execution result with string stdout/stderr.
 */
export function spawnJavaSync(
    configJavaPath: string, args: string[], options?: SpawnSyncOptions,
): SpawnSyncReturns<string> {
    return nodeSpawnSync(
        resolveJavaCommand(configJavaPath), args,
        { ...options, encoding: 'utf8' },
    ) as SpawnSyncReturns<string>;
}

/**
 * Execute a Java command with a callback (async, buffered).
 *
 * Wraps Node `execFile` with the same resolution as {@link spawnJava}.
 * Suitable for short-lived commands where stdout/stderr are buffered in
 * memory (e.g. `java -version`, theme listing).
 *
 * @param configJavaPath - The `javaPath` value from extension settings.
 * @param args - CLI arguments passed to the Java process.
 * @param options - Buffered execution options (timeout, maxBuffer, etc.).
 * @param cb - Callback invoked when the process exits.
 * @returns The spawned child process.
 */
export function execJava(
    configJavaPath: string,
    args: readonly string[],
    options: { timeout?: number; encoding?: BufferEncoding; maxBuffer?: number },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
): ChildProcess {
    return nodeExecFile(
        resolveJavaCommand(configJavaPath),
        args as string[],
        options, cb,
    );
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
 * Note: Absolute filesystem paths (e.g. `/usr/share/img.png`) are resolved
 * via toUri, but the Webview will block them if the path falls outside
 * localResourceRoots (file directory + workspace root).
 *
 * @param html - Rendered HTML string.
 * @param baseDirPath - Absolute directory path to resolve relative paths against.
 * @param toUri - Converts an absolute file path to a displayable URI.
 * @returns HTML with resolved image paths.
 */
export function resolveLocalImagePaths(html: string, baseDirPath: string, toUri: (absolutePath: string) => string): string {
    return html.replace(IMG_SRC_RE, (match, pre: string, quote: string, src: string, post: string) => {
        if (ABSOLUTE_SRC_RE.test(src)) return match;
        const absolutePath = path.isAbsolute(src) ? src : path.resolve(baseDirPath, src);
        const uri = escapeHtml(toUri(absolutePath));
        return `<img ${pre}src=${quote}${uri}${quote}${post}>`;
    });
}
