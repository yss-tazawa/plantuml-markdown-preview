/**
 * @module plantuml
 * @description PlantUML jar wrapper — converts PlantUML text to SVG.
 *
 * Key behaviors:
 * - renderToSvg: PlantUML text -> SVG string (synchronous, SHA-256-cached LRU)
 * - listThemes: Dynamically discover available PlantUML themes via `help themes`
 * - Spawns Java via spawnSync with -Djava.awt.headless=true (no macOS Dock icon)
 * - Cache key: content + jarPath + javaPath + dotPath + plantumlTheme (SHA-256 hash, max 200 entries)
 * - Auto-wraps with @startuml/@enduml if missing
 * - On syntax error: parses -stdrpt:1 structured stderr, displays source context
 *   with error line highlight and line number offset correction
 * - Process errors (Java not found, timeout) and syntax errors are NOT cached
 */
import * as vscode from 'vscode';
import { spawnSync, execFile, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import { escapeHtml } from './utils.js';

/** Configuration required for PlantUML rendering and theme discovery. */
export interface PlantUmlConfig {
    /** Absolute path to the PlantUML jar file. */
    jarPath: string;
    /** Path or command name for the Java executable (default: 'java'). */
    javaPath: string;
    /** Path or command name for the Graphviz dot executable (default: 'dot'). */
    dotPath: string;
    /** PlantUML theme name passed via -theme CLI arg. 'default' means no theme. */
    plantumlTheme?: string;
}

/** LRU cache mapping SHA-256 hash -> SVG string. */
const cache = new Map<string, string>();

/** Maximum number of cached SVG entries. */
const MAX_CACHE_SIZE = 200;

/** Cache key for the last successful theme list fetch. Format: `jarPath + '\0' + javaPath`. */
let themeCacheKey = '';
/** Cached theme list from the last successful fetch. */
let themeCacheResult: string[] | null = null;
/** Key of the currently in-flight theme fetch, used for deduplication. */
let themePendingKey = '';
/** Promise of the currently in-flight theme fetch, used for deduplication. */
let themePendingPromise: Promise<string[]> | null = null;
/** Reference to the in-flight theme fetch child process for cleanup on deactivate. */
let themePendingChild: ChildProcess | null = null;

/** Representative themes used when dynamic discovery fails (old PlantUML versions). */
const FALLBACK_PLANTUML_THEMES = [
    'cerulean', 'cyborg', 'mars', 'sketchy', 'vibrant',
];

/**
 * Render PlantUML text to an SVG string (synchronous).
 *
 * Spawns `java -jar plantuml.jar -pipe -tsvg` with the given content piped via stdin.
 * Results are cached in a SHA-256-keyed LRU map (max 200 entries).
 * Process errors and syntax errors are NOT cached so re-edits are always re-evaluated.
 *
 * @param {string} pumlContent - Raw PlantUML source text (with or without @startuml/@enduml).
 * @param {PlantUmlConfig} config - Paths and theme settings for the PlantUML invocation.
 * @returns {string} SVG markup on success, or a styled HTML error div on failure.
 */
export function renderToSvg(pumlContent: string, config: PlantUmlConfig): string {
    const jarPath = config.jarPath || '';
    const javaPath = config.javaPath || 'java';
    const dotPath = config.dotPath || 'dot';
    const plantumlTheme = config.plantumlTheme || 'default';

    if (!jarPath) {
        return errorHtml(
            vscode.l10n.t('PlantUML jar is not configured.') + '<br>' +
            '<code>plantumlMarkdownPreview.jarPath</code>'
        );
    }

    const trimmed = pumlContent.trim();
    const tagsAdded = !trimmed.startsWith('@start');
    const content = ensureStartEndTags(trimmed);
    const hash = crypto.createHash('sha256')
        .update(content).update('\0')
        .update(jarPath).update('\0')
        .update(javaPath).update('\0')
        .update(dotPath).update('\0')
        .update(plantumlTheme)
        .digest('hex');

    if (cache.has(hash)) {
        // LRU: refresh access order (move to end of Map insertion order)
        const cached = cache.get(hash)!;
        cache.delete(hash);
        cache.set(hash, cached);
        return cached;
    }

    const args = ['-Djava.awt.headless=true', '-jar', jarPath, '-pipe', '-tsvg', '-charset', 'UTF-8', '-stdrpt:1'];
    if (dotPath !== 'dot') {
        args.push('-graphvizdot', dotPath);
    }
    if (plantumlTheme !== 'default') {
        args.push('-theme', plantumlTheme);
    }

    const result = spawnSync(
        javaPath,
        args,
        {
            input: content,
            encoding: 'utf8',
            timeout: 15000,
            killSignal: 'SIGKILL'
        }
    );

    // Process errors (Java not found, timeout, etc.) are not cached
    if (result.error) {
        return errorHtml(vscode.l10n.t('PlantUML execution error: {0}', result.error.message));
    }

    // Syntax errors are not cached (user is editing, will be re-evaluated soon).
    if (result.status !== 0) {
        return buildErrorMessage(result.stderr, trimmed, tagsAdded ? 1 : 0, result.status ?? -1);
    }

    const svg = result.stdout;
    if (cache.size >= MAX_CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(hash, svg);
    return svg;
}

/**
 * Build a user-facing error message HTML from PlantUML stderr and source code.
 *
 * Parses -stdrpt:1 structured output to extract line number and label,
 * then renders source context (first 5 lines + error neighborhood) with
 * the error line highlighted. Falls back to raw stderr when the structured
 * format is not available.
 *
 * @param {string} stderr - Standard error output from the PlantUML process.
 * @param {string} displayContent - Original PlantUML source (without auto-added tags).
 * @param {number} lineOffset - Number of lines prepended by ensureStartEndTags (0 or 1).
 * @param {number} exitCode - Process exit code (used in fallback message).
 * @returns {string} Styled HTML error div ready for Webview insertion.
 */
function buildErrorMessage(stderr: string, displayContent: string, lineOffset: number, exitCode: number): string {
    const parsed = parseStdrpt(stderr);
    const lines = displayContent.split('\n');

    if (parsed) {
        const lineNumber = parsed.lineNumber - lineOffset;
        const label = parsed.label;
        let msg = `<strong>${escapeHtml(label)} (line ${lineNumber + 1})</strong>`;

        if (lineNumber >= 0 && lineNumber < lines.length) {
            // Show first few lines + error context, skip middle section
            const HEAD = 5;
            const CONTEXT_BEFORE = 15;
            const CONTEXT_AFTER = 2;
            const headEnd = Math.min(HEAD - 1, lines.length - 1);
            const ctxStart = Math.max(0, lineNumber - CONTEXT_BEFORE);
            const ctxEnd = Math.min(lines.length - 1, lineNumber + CONTEXT_AFTER);
            const pad = String(ctxEnd + 1).length;
            // Don't skip if the gap is less than 3 lines
            const skipStart = headEnd + 1;
            const skipEnd = ctxStart - 1;
            const skipping = skipEnd >= skipStart + 2;

            msg += '<pre style="margin:0.5em 0 0;white-space:pre-wrap;font-size:0.85em;line-height:1.5;' +
                   'background:#fff5f5;padding:0.4em 0.6em;border-radius:3px;">';

            /**
             * Render a single source line with line number gutter and optional error highlight.
             *
             * Appends the formatted line to the `msg` accumulator. The error line
             * (matching `lineNumber`) is rendered with a red background and `>>` marker.
             *
             * @param {number} i - Zero-based line index into the `lines` array.
             */
            const renderLine = (i: number): void => {
                const num = String(i + 1).padStart(pad);
                if (i === lineNumber) {
                    msg += `<span style="display:inline-block;width:100%;background:#fdd;color:#c00;font-weight:bold;">&gt;&gt; ${num} | ${escapeHtml(lines[i])}</span>\n`;
                } else {
                    msg += `   ${num} | ${escapeHtml(lines[i])}\n`;
                }
            };

            if (skipping) {
                for (let i = 0; i <= headEnd; i++) renderLine(i);
                const skippedCount = skipEnd - skipStart + 1;
                msg += `\n   ... ( skipping ${skippedCount} lines ) ...\n\n`;
                for (let i = ctxStart; i <= ctxEnd; i++) renderLine(i);
            } else {
                for (let i = 0; i <= ctxEnd; i++) renderLine(i);
            }

            msg += '</pre>';
        }

        return errorHtml(msg);
    }

    // Fallback when -stdrpt:1 format is not supported: show stderr as-is
    const msg = (stderr && stderr.trim()) || `exit code ${exitCode}`;
    return errorHtml(vscode.l10n.t('PlantUML error:') + `<br><pre style="margin:0.4em 0 0;white-space:pre-wrap;font-size:0.85em;">${escapeHtml(msg)}</pre>`);
}

/**
 * Parse PlantUML -stdrpt:1 formatted stderr into structured fields.
 *
 * Expected format (one key=value per line):
 *   lineNumber=42
 *   label=Syntax Error?
 *
 * @param {string} stderr - Raw stderr from the PlantUML process.
 * @returns {{ lineNumber: number; label: string } | null} Parsed result with
 *   0-indexed lineNumber, or null if the format is not recognized.
 */
function parseStdrpt(stderr: string): { lineNumber: number; label: string } | null {
    if (!stderr) return null;

    const lineNumberMatch = stderr.match(/^lineNumber=(\d+)$/m);
    const labelMatch = stderr.match(/^label=(.+)$/m);

    if (!lineNumberMatch) return null;

    return {
        lineNumber: parseInt(lineNumberMatch[1], 10) - 1, // 1-indexed -> 0-indexed
        label: labelMatch ? labelMatch[1] : 'Error'
    };
}

/**
 * Auto-wrap content with @startuml / @enduml if no @start tag is present.
 *
 * Recognizes all PlantUML start tags (@startuml, @startmindmap, @startwbs, etc.)
 * and only wraps content that doesn't already have one.
 *
 * @param {string} content - Trimmed PlantUML source text.
 * @returns {string} Content guaranteed to have @startuml/@enduml wrapper tags (if no @start tag was present).
 */
function ensureStartEndTags(content: string): string {
    if (!content.startsWith('@start')) {
        return `@startuml\n${content}\n@enduml`;
    }
    return content;
}

/**
 * Wrap an error message in a red-bordered styled HTML div.
 *
 * @param {string} message - HTML content (may include tags) to display inside the error box.
 * @returns {string} Complete HTML div string with error styling.
 */
function errorHtml(message: string): string {
    return `<div style="border:1px solid #f66;background:#fff0f0;padding:0.5em 1em;border-radius:4px;color:#c00;font-size:0.9em;text-align:left;">${message}</div>`;
}

/**
 * Return cached PlantUML themes (synchronous, cache-only).
 *
 * Returns the in-memory cache populated by a prior listThemesAsync() call.
 * If no cache exists, returns a hardcoded fallback list of representative themes.
 *
 * @param {Pick<PlantUmlConfig, 'jarPath' | 'javaPath'>} config - Jar and Java paths for cache key matching.
 * @returns {string[]} Array of theme name strings.
 */
export function listThemes(config: Pick<PlantUmlConfig, 'jarPath' | 'javaPath'>): string[] {
    const jarPath = config.jarPath || '';
    const javaPath = config.javaPath || 'java';
    if (!jarPath) return FALLBACK_PLANTUML_THEMES;

    const key = jarPath + '\0' + javaPath;
    if (themeCacheKey === key && themeCacheResult) return themeCacheResult;
    return FALLBACK_PLANTUML_THEMES;
}

/**
 * Fetch PlantUML themes asynchronously via `help themes` command.
 *
 * Spawns a Java process with `@startuml\nhelp themes\n@enduml` as stdin and
 * parses the -tutxt output to extract available theme names.
 * Results are cached in memory. Concurrent calls with the same config are
 * deduplicated (returns the same in-flight Promise).
 *
 * @param {Pick<PlantUmlConfig, 'jarPath' | 'javaPath'>} config - Jar and Java paths.
 * @returns {Promise<string[]>} Resolves to an array of theme names, or fallback list on error.
 */
export function listThemesAsync(config: Pick<PlantUmlConfig, 'jarPath' | 'javaPath'>): Promise<string[]> {
    const jarPath = config.jarPath || '';
    const javaPath = config.javaPath || 'java';
    if (!jarPath) return Promise.resolve(FALLBACK_PLANTUML_THEMES);

    const key = jarPath + '\0' + javaPath;
    if (themeCacheKey === key && themeCacheResult) return Promise.resolve(themeCacheResult);

    // Deduplicate concurrent calls: return the in-flight promise if one exists for the same key
    if (themePendingPromise && themePendingKey === key) return themePendingPromise;

    // Kill the previous in-flight child process if config key changed
    if (themePendingChild) {
        themePendingChild.kill();
        themePendingChild = null;
    }

    themePendingKey = key;
    const promise = new Promise<string[]>((resolve) => {
        const child = execFile(
            javaPath,
            ['-Djava.awt.headless=true', '-jar', jarPath, '-pipe', '-tutxt', '-charset', 'UTF-8'],
            { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 },
            (err: Error | null, stdout: string) => {
                // Only clear the pending state if it is still ours (a newer call
                // with a different config key may have replaced it already).
                if (themePendingPromise === promise) {
                    themePendingPromise = null;
                    themePendingChild = null;
                }
                if (err || !stdout) { resolve(FALLBACK_PLANTUML_THEMES); return; }
                const themes = parseHelpThemes(stdout);
                if (themes.length === 0) { resolve(FALLBACK_PLANTUML_THEMES); return; }
                themeCacheKey = key;
                themeCacheResult = themes;
                resolve(themes);
            }
        );
        themePendingChild = child;
        if (child.stdin) {
            try {
                child.stdin.write('@startuml\nhelp themes\n@enduml');
                child.stdin.end();
            } catch {
                // stdin may already be closed; execFile callback will handle the error
            }
        }
    });
    themePendingPromise = promise;
    return themePendingPromise;
}

/**
 * Pre-fetch themes in the background (fire-and-forget).
 *
 * Call this at preview open time so the cache is warm when the user
 * opens the theme QuickPick menu. Errors are silently swallowed.
 *
 * @param {Pick<PlantUmlConfig, 'jarPath' | 'javaPath'>} config - Jar and Java paths.
 */
export function prefetchThemes(config: Pick<PlantUmlConfig, 'jarPath' | 'javaPath'>): void {
    listThemesAsync(config).catch(() => {});
}

/**
 * Clear all caches and kill any in-flight child processes.
 *
 * Called from deactivate() to release memory and stop background work
 * when the extension is unloaded.
 */
export function clearCache(): void {
    cache.clear();
    themeCacheKey = '';
    themeCacheResult = null;
    themePendingKey = '';
    themePendingPromise = null;
    if (themePendingChild) {
        themePendingChild.kill();
        themePendingChild = null;
    }
}

/**
 * Parse theme names from PlantUML `help themes` text output (-tutxt format).
 *
 * Scans for the "The possible themes are" header line, then collects all
 * subsequent non-empty, non-"_none_" lines as theme names.
 *
 * @param {string} output - Raw text output from PlantUML `help themes`.
 * @returns {string[]} Array of theme name strings (may be empty).
 */
function parseHelpThemes(output: string): string[] {
    const lines = output.split('\n');
    let inList = false;
    const themes: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!inList) {
            if (trimmed.startsWith('The possible themes are')) {
                inList = true;
            }
            continue;
        }
        if (!trimmed || trimmed === '_none_') continue;
        themes.push(trimmed);
    }

    return themes;
}
