/**
 * @module java-check
 * @description Java availability check for the local PlantUML renderers.
 *
 * Key behaviors:
 * - Runs `java -version` and classifies the outcome (ok, missing-path, not-found, too-old, unknown)
 * - Never remembers an outcome: Java can be installed or removed at any time
 * - Shares one in-flight probe between checks with the same javaPath and folder
 * - Never kills another caller's probe; kills running probes only when the key changes
 *   ({@link javaCheckKeyChanged}) or on deactivate ({@link cancelRunningJavaChecks})
 * - Reports a cancelled or timed-out probe as 'unknown', not as a missing Java
 * - Shows nothing itself; callers show the guidance ({@link notifyJavaUnavailable}, {@link javaGuidance})
 * - Offers "Use Easy Mode" in every guidance, reading the settings when it is chosen
 * - Decides whether opening a preview needs a check ({@link checksJavaOnOpen})
 * - Decides whether a settings change needs a check ({@link checksJavaOnSettingsChange})
 * - Decides whether a javaPath change is announced ({@link announcesJavaPathChange})
 * - Tells a javaPath naming a missing file without running it ({@link isMissingJavaPath})
 * - Resolves a relative javaPath against the folder Java runs in (include path or first workspace folder)
 */
import { existsSync } from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { execJava } from './utils.js';
import { resolveIncludePath } from './plantuml.js';
import { isManagedServerMode, type Config } from './config.js';
import { notifyOnce, type Guidance } from './notify-once.js';
import type { LocalServerState } from './local-server.js';

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------

/**
 * Outcome of a Java check:
 * - 'ok'          : Java 11+ (or an unparseable version) answered `-version`.
 * - 'missing-path': javaPath names a file that does not exist (no probe ran).
 * - 'not-found'   : the command could not be run or exited with a non-zero code.
 * - 'too-old'     : Java answered but is older than 11.
 * - 'unknown'     : the probe was cancelled or timed out — no verdict about Java.
 */
export type JavaCheckStatus = 'ok' | 'missing-path' | 'not-found' | 'too-old' | 'unknown';

/** Result of a Java check. */
export interface JavaCheckResult {
    /** Classified outcome of the check. */
    status: JavaCheckStatus;
    /** Major version parsed from `java -version`, or null when unavailable. */
    major: number | null;
}

/** Error passed to the execFile callback of a `java -version` probe. */
type ProbeError = Error & { code?: unknown; killed?: boolean; signal?: unknown };

/** Timeout for one `java -version` probe. */
const PROBE_TIMEOUT_MS = 5000;

/** In-flight probes keyed by {@link probeKey} (shared by concurrent callers). */
const inFlight = new Map<string, { promise: Promise<JavaCheckResult>; child: ChildProcess }>();

/**
 * Key of a probe: a relative javaPath names a different file in another folder.
 *
 * @param javaPath - The configured javaPath.
 * @param cwd - Folder the probe runs in (undefined: the extension host's).
 * @returns The key for {@link inFlight}.
 */
function probeKey(javaPath: string, cwd: string | undefined): string {
    return `${cwd ?? ''}\0${javaPath}`;
}

/** Callbacks the guidance needs from the extension. */
export interface JavaCheckHandlers {
    /** Runs the "Use Easy Mode" action with the settings current when the user chooses it. */
    switchToEasy: () => Promise<void>;
    /** Receives one line per check that did not find a usable Java. */
    log?: (line: string) => void;
}

/** Handlers registered by the extension, or null before activation. */
let handlers: JavaCheckHandlers | null = null;

/**
 * Register the "Use Easy Mode" action and the log sink.
 *
 * @param next - The handlers to use from now on.
 */
export function setJavaCheckHandlers(next: JavaCheckHandlers): void {
    handlers = next;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * Parse the major version number from `java -version` stderr output.
 *
 * Handles formats like:
 *   java version "1.8.0_392"   -> 8
 *   java version "11.0.24"     -> 11
 *   openjdk version "21.0.6"   -> 21
 *
 * @param versionOutput - Stderr output from `java -version`.
 * @returns Major version number, or null if parsing fails.
 */
function parseJavaMajorVersion(versionOutput: string): number | null {
    const match = versionOutput.match(/version\s+"(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    const major = parseInt(match[1], 10);
    if (major === 1 && match[2]) return parseInt(match[2], 10);
    return major;
}

/**
 * Classify a finished `java -version` run.
 *
 * @param err - Error from execFile, or null on exit code 0.
 * @param stderr - Captured stderr (where `java -version` prints).
 * @returns The probe result.
 */
function classifyProbe(err: ProbeError | null, stderr: string): JavaCheckResult {
    if (err) {
        // Killed (cancelled or timed out): the probe said nothing about Java.
        if (err.killed || err.signal) return { status: 'unknown', major: null };
        // ENOENT/EACCES (could not run) or a non-zero exit code.
        return { status: 'not-found', major: null };
    }
    const major = parseJavaMajorVersion(stderr);
    if (major !== null && major < 11) return { status: 'too-old', major };
    return { status: 'ok', major };
}

/**
 * Run (or join) the `java -version` probe for a javaPath.
 *
 * @param javaPath - The configured javaPath ('java' resolves via JAVA_HOME/PATH).
 * @param cwd - Folder to run it in, the same one the server and renders use, so a
 *   relative javaPath names the same file (undefined: the extension host's).
 * @returns The classified probe result.
 */
function probeJava(javaPath: string, cwd: string | undefined): Promise<JavaCheckResult> {
    const key = probeKey(javaPath, cwd);
    const running = inFlight.get(key);
    if (running) return running.promise;

    let child: ChildProcess | null = null;
    const promise = new Promise<JavaCheckResult>((resolve) => {
        try {
            child = execJava(javaPath, ['-version'], { timeout: PROBE_TIMEOUT_MS, cwd }, (err, _stdout, stderr) => {
                // Drop only our own entry: a cancel may already have removed it.
                if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
                resolve(classifyProbe(err, stderr || ''));
            });
        } catch {
            // The command could not be run at all (e.g. spawn EINVAL for a .cmd/.bat path).
            resolve({ status: 'not-found', major: null });
        }
    });
    // Nothing to share or cancel when the probe failed to spawn. Cast: TypeScript
    // cannot see the assignment inside the executor and narrows child to null.
    const spawned = child as ChildProcess | null;
    if (spawned) inFlight.set(key, { promise, child: spawned });
    return promise;
}

/**
 * Kill every running probe; their callers receive 'unknown'. Call when the key of
 * the checks changes ({@link javaCheckKeyChanged}) and on deactivate.
 */
export function cancelRunningJavaChecks(): void {
    for (const { child } of inFlight.values()) {
        try { child.kill(); } catch { /* already exited */ }
    }
    inFlight.clear();
}

/**
 * Whether a settings change changes the key of the checks: the javaPath, or the
 * folder Java runs in (which a relative javaPath is resolved against).
 *
 * @param previous - Settings before the change.
 * @param next - Settings after the change.
 * @returns True when probes of the previous settings no longer answer for the next ones.
 */
export function javaCheckKeyChanged(previous: Config, next: Config): boolean {
    return previous.javaPath !== next.javaPath || resolveIncludePath(previous) !== resolveIncludePath(next);
}

/**
 * Whether a settings change should announce the new javaPath. A javaPath naming
 * no file (e.g. one being typed) is not announced: the Java check reports it.
 *
 * @param previous - Settings before the change.
 * @param next - Settings after the change.
 * @returns True when javaPath changed to one that is not a missing file.
 */
export function announcesJavaPathChange(previous: Config, next: Config): boolean {
    return previous.javaPath !== next.javaPath && !isMissingJavaPath(next.javaPath, resolveIncludePath(next));
}

/**
 * Whether rendering with these settings may run Java on this machine: 'local' spawns
 * PlantUML per render, and 'local-server' spawns its own server unless the start mode
 * is 'off' (connect to an external server). 'server' renders remotely.
 *
 * @param config - Current extension settings (renderMode, start mode).
 * @returns True when a missing Java may break rendering.
 */
export function rendersWithLocalJava(config: Config): boolean {
    if (config.renderMode === 'local') return true;
    if (config.renderMode === 'local-server') return isManagedServerMode(config);
    return false;
}

/**
 * Whether opening a preview should check Java. 'local' runs Java for every render.
 * A managed 'local-server' needs a check whenever its server is not running: a
 * running server has already shown that its Java renders.
 *
 * @param config - Current extension settings (renderMode, start mode).
 * @param serverState - Current state of the local PlantUML server.
 * @returns True when the open should run the Java check.
 */
export function checksJavaOnOpen(config: Config, serverState: LocalServerState): boolean {
    if (config.renderMode === 'local') return true;
    return rendersWithLocalJava(config) && serverState !== 'running';
}

/**
 * Whether a settings change should check Java. Switching to 'local', or changing
 * the key of the checks while in 'local', makes the next render run a Java not
 * checked yet. 'local-server' restarts its server on these changes, and the start
 * checks Java.
 *
 * @param previous - Settings before the change.
 * @param next - Settings after the change.
 * @returns True when the change should run the Java check.
 */
export function checksJavaOnSettingsChange(previous: Config, next: Config): boolean {
    if (next.renderMode !== 'local') return false;
    return previous.renderMode !== 'local' || javaCheckKeyChanged(previous, next);
}

/**
 * Whether javaPath names a file that does not exist. Only an explicit path (one
 * with a path separator) can be told missing without running it: a bare command
 * name is looked up on PATH, so only the probe can tell. A relative path is
 * looked up in `cwd`, as spawning Java there does. On Windows a path also runs
 * with '.exe' or '.com' appended, as process spawning tries those extensions.
 *
 * @param javaPath - The configured javaPath.
 * @param cwd - Folder Java runs in (undefined: the extension host's).
 * @param platform - Platform whose path rules apply.
 * @returns True when the path is explicit and no runnable file exists for it.
 */
export function isMissingJavaPath(
    javaPath: string,
    cwd: string | undefined,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const separator = platform === 'win32' ? /[\\/]/ : /\//;
    if (!separator.test(javaPath)) return false;
    const rules = platform === 'win32' ? path.win32 : path.posix;
    const file = rules.isAbsolute(javaPath) ? javaPath : path.resolve(cwd ?? process.cwd(), javaPath);
    if (existsSync(file)) return false;
    return platform !== 'win32' || !['.exe', '.com'].some(ext => existsSync(file + ext));
}

// ---------------------------------------------------------------------------
// Checking and guidance
// ---------------------------------------------------------------------------

/**
 * Whether an outcome means rendering cannot run Java.
 *
 * @param status - Outcome of a check.
 * @returns True for 'missing-path', 'not-found' and 'too-old'.
 */
export function isJavaUnusable(status: JavaCheckStatus): boolean {
    return status === 'missing-path' || status === 'not-found' || status === 'too-old';
}

/**
 * Check whether a usable Java is available for local rendering. Shows nothing:
 * the caller decides whether to show {@link javaGuidance}.
 *
 * @param config - Current extension settings (javaPath, include path, renderMode, start mode, debugSimulateNoJava).
 * @returns The check outcome; 'unknown' means the probe gave no verdict.
 */
export async function checkJavaAvailability(config: Config): Promise<JavaCheckResult> {
    if (!rendersWithLocalJava(config)) return { status: 'ok', major: null };

    const log = handlers?.log ?? (() => { /* no log sink */ });
    // The folder the server and renders spawn Java in (see spawnManagedServer).
    const cwd = resolveIncludePath(config);
    // An explicit path that does not exist on disk: no probe needed.
    if (isMissingJavaPath(config.javaPath, cwd)) {
        log(`[java-check] ${config.javaPath}: missing-path (path does not exist)`);
        return { status: 'missing-path', major: null };
    }

    const result: JavaCheckResult = config.debugSimulateNoJava
        ? { status: 'not-found', major: null }
        : await probeJava(config.javaPath, cwd);
    if (result.status === 'ok') return result;
    if (result.status === 'unknown') {
        log(`[java-check] ${config.javaPath}: unknown (java -version was cancelled or timed out)`);
        return result;
    }
    const version = result.major !== null ? ` (Java ${result.major})` : '';
    log(`[java-check] ${config.javaPath}: ${result.status}${version}`);
    return result;
}

/**
 * Build the guidance for an outcome that means rendering cannot run Java. Every
 * guidance offers "Use Easy Mode"; a missing path also offers "Open Settings",
 * and a missing or outdated Java "Install Java".
 *
 * @param result - Outcome of a check.
 * @param javaPath - The configured javaPath (named in the missing-path guidance).
 * @returns The guidance, or null when Java is usable or the outcome is unknown.
 */
export function javaGuidance(result: JavaCheckResult, javaPath: string): Guidance | null {
    const useEasy = {
        label: vscode.l10n.t('Use Easy Mode'),
        run: () => handlers?.switchToEasy(),
    };
    if (result.status === 'missing-path') {
        return {
            message: vscode.l10n.t('Java path "{0}" does not exist. Check the plantumlMarkdownPreview.javaPath setting.', javaPath),
            severity: 'error',
            actions: [
                {
                    label: vscode.l10n.t('Open Settings'),
                    run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'plantumlMarkdownPreview.javaPath'),
                },
                useEasy,
            ],
        };
    }
    if (result.status !== 'not-found' && result.status !== 'too-old') return null;
    let message: string;
    if (result.status === 'not-found') {
        message = vscode.l10n.t('Java is not found. PlantUML requires Java 11 or later for local rendering.');
    } else if (result.major !== null) {
        message = vscode.l10n.t('Java {0} is installed, but the bundled PlantUML requires Java 11 or later. Please upgrade Java.', String(result.major));
    } else {
        message = vscode.l10n.t('The bundled PlantUML requires Java 11 or later. Your Java version is too old. Please upgrade Java.');
    }
    return {
        message,
        severity: 'warning',
        actions: [
            useEasy,
            {
                label: vscode.l10n.t('Install Java'),
                run: () => vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/')),
            },
            { label: vscode.l10n.t('Dismiss') },
        ],
    };
}

/**
 * Show the guidance for an outcome that means rendering cannot run Java, without
 * waiting for the answer, unless the same guidance is already on screen.
 *
 * @param result - Outcome of a check.
 * @param javaPath - The configured javaPath.
 */
export function notifyJavaUnavailable(result: JavaCheckResult, javaPath: string): void {
    const guidance = javaGuidance(result, javaPath);
    if (guidance) notifyOnce(guidance);
}
