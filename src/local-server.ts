/**
 * @module local-server
 * @description Manages a local PlantUML picoweb server process.
 *
 * Key behaviors:
 * - Starts a PlantUML jar in `-picoweb` mode on a free (or user-specified) port
 * - Binds to 127.0.0.1 only (no external network exposure)
 * - Health-checks the server via HTTP polling until ready
 * - Exposes the server URL for use by the existing server rendering pipeline
 * - Keeps the reason the server cannot be used (no Java, port in use, ...) for the diagram's error text
 * - Shows the reason's guidance once per event (opening a preview, Reload, export, a settings change, Retry, a lost server); renders retry silently
 * - Stops retrying after {@link MAX_FAILED_ATTEMPTS} failed starts in a row and says so, until the next event ({@link handleServerEvent})
 * - Cleans up the child process on stop/deactivate
 */
import * as net from 'net';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { spawnJava, killProcessTree, isProcessAlive, looksLikeJavaProcess } from './utils.js';
import { resolveIncludePath } from './plantuml.js';
import type { Config } from './config.js';
import { checksJavaOnOpen, isJavaUnusable, javaGuidance, type JavaCheckResult } from './java-check.js';
import { notifyOnce, type Guidance, type GuidanceAction } from './notify-once.js';
import { CONFIG_SECTION, OUTPUT_CHANNEL_NAME, resolveJvmHeapArgs, isLazyDeferralActive, isManagedServerMode } from './config.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Active PlantUML picoweb child process, or null when not running. */
let serverProcess: ChildProcess | null = null;
/** Base URL of the running server (e.g. `http://127.0.0.1:8080`), or null. */
let serverUrl: string | null = null;
/**
 * Whether the current server was spawned and is managed by us (true), or adopted
 * from an already-running instance / external host (false). We only ever kill
 * processes we own — an adopted server (a zombie, the user's manual picoserver,
 * or a LAN server) must never be terminated by us.
 */
let ownedProcess = false;

/** Persistent store for the spawned server PID (survives crashes/reloads). */
let pidStore: vscode.Memento | null = null;
/** Key under which the spawned server PID record is persisted. */
const PID_KEY = 'localServer.lastPid';

/**
 * Persisted record of a spawned server. globalState is shared across ALL
 * VS Code windows, so the PID alone is not enough: ownerPid identifies the
 * extension host that spawned the server, letting other windows tell a live
 * sibling's server apart from a leftover of a dead session.
 */
interface StoredServerPid {
    pid: number;
    ownerPid: number;
}
/**
 * In-flight stale-process cleanup (from a previous session). startLocalServer awaits
 * this so a new server never binds a port while a leftover process is still dying.
 */
let staleCleanupPromise: Promise<void> | null = null;

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'error';
let serverState: LocalServerState = 'stopped';

/** Optional callback invoked whenever serverState changes. */
let onStateChange: ((state: LocalServerState) => void) | null = null;

/** Resolved when the server becomes ready (or rejected on failure). */
let readyPromise: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((err: Error) => void) | null = null;

/** Output channel for logging (shared with the extension). */
let outputChannel: vscode.OutputChannel | null = null;

/** Optional callback to obtain the latest Config (for crash-restart with fresh settings). */
let getLatestConfig: (() => Config) | null = null;

/** Flag to distinguish intentional stop from unexpected crash. */
let stoppingIntentionally = false;

/**
 * Why the server cannot be used, kept from a failed start until the server runs
 * or is stopped explicitly:
 * - 'java'              : the Java check found no usable Java (or the spawn found none).
 * - 'port-in-use'       : the fixed port is held by something that is not a PlantUML server
 *                         (found before the spawn, or the spawned server could not bind it).
 * - 'start-failed'      : the server exited before it was ready, or was not ready in time.
 * - 'external-not-found': start mode 'off' found no server at the configured host and port.
 */
export type UnavailableReason =
    | { kind: 'java'; result: JavaCheckResult; javaPath: string }
    | { kind: 'port-in-use' }
    | { kind: 'start-failed'; detail: string }
    | { kind: 'external-not-found'; message: string };

/** Reason the server cannot be used, or null while nothing failed. */
let unavailableReason: UnavailableReason | null = null;

/** Failed starts in a row after which renders stop retrying until the next event. */
export const MAX_FAILED_ATTEMPTS = 5;

/** Starts that failed in a row since the last event (start mode 'off' is not counted). */
let failedAttempts = 0;

/** True from an event until the guidance of a failure is shown. */
let noticePending = true;

/**
 * Generation of the current start attempt. Every start and every stop bumps it;
 * a start that finds a different value after an await has been superseded (a
 * stop, possibly followed by a newer start, ran meanwhile) and must give up.
 */
let startGeneration = 0;

/** Generation of the start in progress (from its Java check to its outcome), or null. */
let activeStart: number | null = null;

/** SIGKILL fallback timer (module-level so resetState can clear it). */
let killTimer: ReturnType<typeof setTimeout> | null = null;

/** Message of the most recent error that rejected the ready promise (diagnostics only). */
let lastErrorMessage: string | null = null;
/** Number of startLocalServer calls that began a start attempt (diagnostics only). */
let startAttemptCount = 0;
/** Number of picoweb processes spawned (diagnostics only). */
let spawnCount = 0;

/**
 * Update serverState and notify the listener if changed. Reaching 'running'
 * clears the failure count and the unavailability reason.
 */
function setServerState(state: LocalServerState): void {
    if (state === 'running') {
        failedAttempts = 0;
        unavailableReason = null;
    }
    if (serverState === state) return;
    serverState = state;
    onStateChange?.(state);
}

/**
 * Create a pending ready promise. Nobody may be waiting when a start fails, so
 * its rejection is absorbed here; the outcome is reported through the state.
 */
function createReadyPromise(): void {
    readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    readyPromise.catch(() => { /* reported through the state and the guidance */ });
}

/**
 * Drop the ready-promise trio, optionally rejecting any pending waiter first.
 * Every transition into 'error' (and the final start failure) must go through
 * this: a later retry has to be able to create a FRESH pending promise via
 * prepareLocalServer(), which is a no-op while a settled promise lingers.
 */
function clearReadyPromise(rejectWith?: Error): void {
    const rejectFn = readyReject;
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
    if (rejectWith) lastErrorMessage = rejectWith.message;
    if (rejectWith) rejectFn?.(rejectWith);
}

/**
 * Transition to 'error' after a confirmed server loss (render-path detection or
 * adopt watchdog trip). Clears the promise trio so the next start can prepare a
 * fresh one, and stops the adopt watchdog.
 *
 * @param keepUrl - True only for external-connect mode ('off'): the URL is kept
 *   so renders keep hitting the endpoint and a successful response can flip the
 *   state back to 'running' (handleRenderSuccess). Managed modes must pass
 *   false — a managed 'error' state always has serverUrl === null.
 */
function tripToError(keepUrl: boolean): void {
    stopAdoptWatchdog();
    if (!keepUrl) serverUrl = null;
    setServerState('error');
    clearReadyPromise(new Error('Lost connection to the PlantUML server'));
    // Losing a running server is an event: its restart may show guidance again.
    markEvent();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the shared output channel for logging.
 *
 * @param channel - VS Code output channel to write log messages to.
 */
export function setLocalServerOutputChannel(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

/**
 * Register a callback invoked whenever the server state changes.
 *
 * @param cb - Callback receiving the new state value.
 */
export function setOnServerStateChange(cb: (state: LocalServerState) => void): void {
    onStateChange = cb;
}

/**
 * Register a callback to obtain the latest Config for crash-restart.
 *
 * @param getter - Function returning the current extension configuration.
 */
export function setConfigGetter(getter: () => Config): void {
    getLatestConfig = getter;
}

/** Java availability checker registered by extension.ts (shows nothing itself). */
let javaChecker: ((config: Config) => Promise<JavaCheckResult>) | null = null;

/**
 * Register the Java availability checker used before spawning a managed server
 * and by events that find the server not running ({@link handleServerEvent}).
 * Adoption and external-connect paths never invoke it — they need no local Java.
 *
 * @param checker - Function resolving to the Java check outcome.
 */
export function setJavaAvailabilityChecker(checker: (config: Config) => Promise<JavaCheckResult>): void {
    javaChecker = checker;
}

/** Outcome used when the Java check itself failed. */
const UNKNOWN_JAVA: JavaCheckResult = { status: 'unknown', major: null };

/**
 * Register the persistent store (VS Code Memento) used to remember the spawned
 * server PID across sessions, so a leftover process can be cleaned up next launch.
 *
 * @param store - A Memento (e.g. `context.globalState`).
 */
export function setLocalServerPidStore(store: vscode.Memento): void {
    pidStore = store;
}

/**
 * Persist the PID of the server we spawned (owned), or clear it (undefined).
 * Clearing only removes a record this window wrote — the key is shared across
 * windows, and another window's live record must not be clobbered.
 */
function rememberPid(pid: number | undefined): void {
    if (pid === undefined) {
        const rec = pidStore?.get<StoredServerPid | number>(PID_KEY);
        if (rec && typeof rec === 'object' && rec.ownerPid !== process.pid) return;
        void pidStore?.update(PID_KEY, undefined);
    } else {
        void pidStore?.update(PID_KEY, { pid, ownerPid: process.pid } satisfies StoredServerPid);
    }
}

/**
 * Kill any picoweb process left over from a dead session (e.g. VS Code was
 * force-closed and deactivate never ran, orphaning the JVM on Windows).
 *
 * Safety guards, in order:
 * 1. Owner liveness — if the extension host that spawned the server is still
 *    running (another window), the server is alive and in use: leave both the
 *    process and the record alone.
 * 2. PID recycling — only kill a process that still looks like Java; a PID
 *    reassigned by the OS to an unrelated process must never be killed.
 */
export function cleanupStaleLocalServer(): Promise<void> {
    staleCleanupPromise = (async () => {
        const rec = pidStore?.get<StoredServerPid | number>(PID_KEY);
        if (!rec) return;
        // Defer past the caller's synchronous call stack — killProcessTree uses a
        // blocking taskkill on Windows and must not stall extension activation.
        await sleep(0);
        const pid = typeof rec === 'number' ? rec : rec.pid;
        const ownerPid = typeof rec === 'number' ? 0 : rec.ownerPid;
        if (typeof pid !== 'number' || pid <= 0) {
            void pidStore?.update(PID_KEY, undefined);
            return;
        }
        if (ownerPid > 0 && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
            log(`[local-server] Server pid ${pid} belongs to a live session (owner ${ownerPid}) — leaving it running`);
            return;
        }
        if (looksLikeJavaProcess(pid)) {
            log(`[local-server] Cleaning up stale server process (pid ${pid}) from a previous session`);
            killProcessTree(pid);
            // Give the OS a moment to release the port before the new server starts.
            await sleep(300);
        }
        // Direct clear: the record's owner is dead, so the ownership guard in
        // rememberPid(undefined) would refuse to remove it.
        void pidStore?.update(PID_KEY, undefined);
    })();
    return staleCleanupPromise;
}

/**
 * Pre-create the readyPromise so that waitForLocalServer() can block
 * even before startLocalServer() is called (e.g. while Java is being checked).
 * No-op if already prepared or started.
 */
export function prepareLocalServer(): void {
    if (readyPromise) return;
    createReadyPromise();
}

/**
 * Start the local PlantUML server.
 * No-op if already running or a start is in progress.
 *
 * Dispatches on the resolved start mode (config.plantumlLocalServerStartMode):
 * - 'off'      : connect to an existing server at host:port (never spawn).
 * - 'on'/'lazy': if a fixed port already serves a healthy picoweb, adopt it; otherwise spawn.
 *   (The lazy/eager distinction only decides WHEN this is called, not what it does here.)
 *
 * The state stays as it was during the Java check and becomes 'starting' right
 * before the spawn or the external connect. A failure keeps its reason and goes
 * through {@link failStart}.
 *
 * @param config - Current extension settings.
 */
export async function startLocalServer(config: Config): Promise<void> {
    if (serverState === 'running' || activeStart !== null) return;

    stoppingIntentionally = false;
    const generation = ++startGeneration;
    activeStart = generation;
    // True once a stop (and possibly a newer start) ran while this start awaited.
    const superseded = (): boolean => generation !== startGeneration;
    startAttemptCount++;
    if (!readyPromise) createReadyPromise();
    try {
        await runStart(config, superseded);
    } finally {
        if (activeStart === generation) activeStart = null;
    }
}

/**
 * The body of {@link startLocalServer}: connect, adopt, or check Java and spawn.
 *
 * @param config - Current extension settings.
 * @param superseded - True once this start has been superseded; checked after every await.
 */
async function runStart(config: Config, superseded: () => boolean): Promise<void> {
    // Wait for any previous-session cleanup so we don't bind a port still held by a dying zombie.
    if (staleCleanupPromise) {
        await staleCleanupPromise;
        if (superseded()) return;
    }

    const port = config.plantumlLocalServerPort;

    // --- External-connect mode ('off'): never spawn, just connect to host:port ---
    if (!isManagedServerMode(config)) {
        const host = config.plantumlLocalServerHost || '127.0.0.1';
        if (port <= 0) {
            failStart({ kind: 'external-not-found', message: vscode.l10n.t('Set a port for the external PlantUML server (Fast mode, Start Mode "off").') });
            return;
        }
        const url = `http://${host}:${port}`;
        setServerState('starting');
        if (await probeExisting(url)) {
            if (superseded()) return;
            adoptServer(url, vscode.l10n.t('Connected to PlantUML server at {0}', url));
        } else if (!superseded()) {
            // Keep the endpoint even though the first connect failed: error-state
            // renders keep fetching it, so merely starting the server later is
            // enough to recover — no manual Retry needed (same handling as a
            // connection lost after adoption).
            serverUrl = url;
            failStart({ kind: 'external-not-found', message: vscode.l10n.t('No PlantUML server found at {0}. Start it, or set Start Mode to "on".', url) });
        }
        return;
    }

    // --- Managed mode ('on'/'lazy'): on a fixed port, adopt a PlantUML server already
    // there, fail at once if another program holds the port, and spawn only on a free one ---
    // Checked before the jar/Java requirements: adopting a running server needs neither.
    if (port > 0) {
        const url = `http://127.0.0.1:${port}`;
        const found = await probeServer(url);
        if (superseded()) return;
        if (found === 'plantuml') {
            adoptServer(url, vscode.l10n.t('Reusing PlantUML server already running on port {0}.', String(port)));
            return;
        }
        if (found === 'not-plantuml') {
            failStart({ kind: 'port-in-use' });
            return;
        }
    }

    if (!config.plantumlJarPath) {
        failStart({ kind: 'start-failed', detail: vscode.l10n.t('PlantUML jar path is not configured.') });
        return;
    }

    // Spawning requires a working Java; adoption and external-connect do not.
    if (javaChecker) {
        const result = await javaChecker(config).catch(() => UNKNOWN_JAVA);
        if (superseded()) return;
        if (isJavaUnusable(result.status)) {
            failStart({ kind: 'java', result, javaPath: config.javaPath });
            return;
        }
        // 'unknown' (the check was cancelled or timed out) is not proof that Java
        // is missing: spawn anyway — a missing Java surfaces via the process error.
    }

    setServerState('starting');
    await spawnManagedServer(config, superseded);
}

/** How a spawned child ended before it was ready. */
interface BootFailure {
    /** Exit description ("exit code 1", "signal SIGKILL") or the process error message. */
    message: string;
    /** Error code of a process error (e.g. 'ENOENT'), if any. */
    code?: string;
}

/**
 * Spawn and manage our own picoweb server (owned=true), bound to 127.0.0.1.
 * Retries on a different port only in auto-port mode. A child that ends before it
 * is ready fails the start (it is not restarted automatically); one that ends
 * after it was ready goes to {@link handleCrash}.
 *
 * @param config - Current extension settings.
 * @param superseded - True once the start that called this has been superseded
 *   by a stop or a newer start; checked after every await.
 */
async function spawnManagedServer(config: Config, superseded: () => boolean): Promise<void> {
    const MAX_PORT_RETRIES = 3;
    const useAutoPort = config.plantumlLocalServerPort <= 0;
    const usedPorts = new Set<number>();

    for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
        // This guard also prevents re-setting readyReject after stopLocalServer() cleared it.
        if (superseded()) return;
        let bootFailure: BootFailure | null = null;
        let stderrBuf = '';
        try {
            const port = await findFreePort(config.plantumlLocalServerPort, usedPorts);
            if (superseded()) return;
            usedPorts.add(port);
            const args = buildArgs(config, port);

            log(`[local-server] Starting: java ${args.join(' ')}`);
            const child = spawnJava(config.javaPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: resolveIncludePath(config),
            });
            serverProcess = child;
            // A process we spawned is owned from the moment it exists — not from
            // readiness. Otherwise a stop during the boot window would skip the
            // kill (owned=false) and leak the JVM, and the PID record would be
            // missing for next-launch cleanup.
            ownedProcess = true;
            spawnCount++;
            if (child.pid) rememberPid(child.pid);

            let ready = false;
            child.stdout?.on('data', (chunk: Buffer) => log(`[local-server stdout] ${chunk.toString().trimEnd()}`));
            child.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString().trimEnd();
                log(`[local-server stderr] ${text}`);
                stderrBuf = (stderrBuf + text + '\n').slice(-4096);
            });

            child.on('error', (err: NodeJS.ErrnoException) => {
                child.removeAllListeners('close'); // prevent double crash handling
                log(`[local-server] Process error: ${err.message}`);
                if (ready) handleCrash(err.message);
                else bootFailure ??= { message: err.message, code: err.code };
            });

            child.on('close', (code, signal) => {
                if (stoppingIntentionally) return;
                const reason = signal ? `signal ${signal}` : `exit code ${code}`;
                if (ready) {
                    log(`[local-server] Process exited unexpectedly: ${reason}`);
                    handleCrash(reason);
                } else {
                    log(`[local-server] Process exited before it was ready: ${reason}`);
                    bootFailure ??= { message: reason };
                }
            });

            await waitForReady(port, superseded, () => bootFailure !== null);
            // Guard against a stop that ran during waitForReady. Re-read serverState
            // as a string — TypeScript narrows the module-level variable but cannot
            // track mutations across await boundaries.
            if (superseded() || (serverState as string) !== 'starting') return;

            ready = true;
            serverUrl = `http://127.0.0.1:${port}`;
            setServerState('running');
            readyResolve?.();
            log(`[local-server] Ready on port ${port}`);

            void vscode.window.showInformationMessage(
                vscode.l10n.t('Local PlantUML server started.')
            );
            return;
        } catch (err) {
            // A superseded start owns nothing any more: serverProcess (if any)
            // belongs to the stop or to the newer start.
            if (superseded()) return;
            discardBootingChild();
            // Cast: TypeScript cannot see the assignments inside the child's handlers.
            const reason = classifyBootFailure(bootFailure as BootFailure | null, err as NodeJS.ErrnoException, stderrBuf, config);
            log(`[local-server] Failed to start: ${(bootFailure as BootFailure | null)?.message ?? (err as Error).message}`);
            if (useAutoPort && attempt < MAX_PORT_RETRIES - 1 && reason.kind !== 'java') {
                log(`[local-server] Port may be in use, retrying (${attempt + 1}/${MAX_PORT_RETRIES})...`);
                continue;
            }
            // A fixed port taken right after an event: another window may be
            // starting a server on it — wait for it and adopt it.
            if (reason.kind === 'port-in-use' && failedAttempts === 0
                && await recoverByAdoptingPort(config, superseded)) return;
            if (superseded()) return;
            failStart(reason);
            return;
        }
    }
}

/** Kill the child of a start that failed before it was ready, ignoring its exit. */
function discardBootingChild(): void {
    if (!serverProcess) return;
    serverProcess.removeAllListeners('error');
    serverProcess.removeAllListeners('close');
    // Flag prevents the close handler from treating this kill as unexpected.
    // Safe to reset synchronously: removeAllListeners('close') above ensures
    // no close callback fires between kill() and the reset.
    stoppingIntentionally = true;
    try { serverProcess.kill(); } catch { /* process already gone (ESRCH) */ }
    serverProcess = null;
    ownedProcess = false;
    rememberPid(undefined);
    stoppingIntentionally = false;
}

/**
 * Tell why a spawned server did not become ready.
 *
 * @param boot - How the child ended, or null when it did not end (timeout).
 * @param err - The error that ended the wait (or a synchronous spawn error).
 * @param stderr - The child's recent stderr.
 * @param config - Current extension settings (javaPath, port).
 * @returns The unavailability reason.
 */
function classifyBootFailure(boot: BootFailure | null, err: NodeJS.ErrnoException, stderr: string, config: Config): UnavailableReason {
    const code = boot?.code ?? err.code;
    if (code === 'ENOENT') {
        return { kind: 'java', result: { status: 'not-found', major: null }, javaPath: config.javaPath };
    }
    if (stderr.includes('UnsupportedClassVersionError') || stderr.includes('class file version')) {
        return { kind: 'java', result: { status: 'too-old', major: null }, javaPath: config.javaPath };
    }
    if (config.plantumlLocalServerPort > 0
        && (stderr.includes('BindException') || stderr.includes('Address already in use'))) {
        return { kind: 'port-in-use' };
    }
    return { kind: 'start-failed', detail: boot?.message ?? err.message };
}

/**
 * Promise that resolves when the most recently stopped server process exits.
 * Used by `restartLocalServer` to wait for port release before starting a new server.
 */
let stopExitPromise: Promise<void> = Promise.resolve();

/**
 * Stop the local server. Safe to call even if not running. An explicit stop
 * (settings change, deactivate) also clears the unavailability reason and the
 * failure count.
 */
export function stopLocalServer(): void {
    stoppingIntentionally = true;
    // Any start still awaiting something is superseded.
    startGeneration++;
    activeStart = null;
    unavailableReason = null;
    failedAttempts = 0;
    // Reject pending waiters before resetting state so they don't hang until timeout.
    readyReject?.(new Error('Server stopped'));
    readyReject = null; // prevent double-reject in resetState()
    const wasRunning = serverState === 'running';
    const wasOwned = ownedProcess;
    // Only terminate a process we spawned. An adopted server (owned=false — zombie,
    // the user's manual picoserver, or a LAN host) must never be killed by us.
    if (ownedProcess && serverProcess) {
        serverProcess.removeAllListeners('error');
        serverProcess.removeAllListeners('close');
        serverProcess.stdout?.removeAllListeners('data');
        serverProcess.stderr?.removeAllListeners('data');
        const proc = serverProcess;
        serverProcess = null;
        let timerHandle: ReturnType<typeof setTimeout> | null = null;
        if (process.platform === 'win32' && proc.pid) {
            // taskkill /T /F reliably kills the JVM tree (a plain kill() can orphan it on Windows).
            killProcessTree(proc.pid, 'SIGKILL');
        } else {
            proc.kill('SIGTERM');
            // SIGKILL fallback if SIGTERM doesn't terminate within 3 seconds
            timerHandle = setTimeout(() => {
                if (killTimer !== timerHandle) return; // superseded by a newer stop call
                try { proc.kill('SIGKILL'); } catch { /* already exited */ }
                killTimer = null;
            }, 3000);
            killTimer = timerHandle;
        }
        stopExitPromise = new Promise<void>(resolve => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(failsafe);
                if (timerHandle && killTimer === timerHandle) { clearTimeout(timerHandle); killTimer = null; }
                resolve();
            };
            // Failsafe: if the kill silently failed (e.g. taskkill access denied),
            // 'exit' never fires — resolve anyway so restartLocalServer can't hang.
            const failsafe = setTimeout(done, 5000);
            proc.once('exit', done);
            proc.once('error', done);
        });
    } else {
        // Adopted server or nothing running: just drop our reference.
        serverProcess = null;
        stopExitPromise = Promise.resolve();
    }
    rememberPid(undefined);
    resetState();
    log('[local-server] Stopped');
    if (wasRunning) {
        // An adopted server is not terminated by us — say "disconnected", not "stopped".
        void vscode.window.showInformationMessage(wasOwned
            ? vscode.l10n.t('Local PlantUML server stopped.')
            : vscode.l10n.t('Disconnected from the PlantUML server.')
        );
    }
}

/**
 * Get the current server URL, or null if not available.
 *
 * In 'error' state the URL survives ONLY in external-connect mode ('off'):
 * renders must keep hitting the configured endpoint so that a revived server is
 * noticed and the state flips back to 'running' (handleRenderSuccess). All
 * managed error paths null the URL, so a managed 'error' still yields null here
 * and the render paths show the unavailability message instead.
 *
 * @returns The server base URL (e.g. `http://127.0.0.1:8080`), or null.
 */
export function getLocalServerUrl(): string | null {
    return serverState === 'running' || serverState === 'error' ? serverUrl : null;
}

/**
 * Whether the server is running (it answered a health check and serves renders).
 *
 * @returns True in state 'running'.
 */
export function isLocalServerRunning(): boolean {
    return serverState === 'running';
}

/** Snapshot of the local-server module state, for diagnostics. */
export interface LocalServerDiagnostics {
    /** Current server state. */
    state: LocalServerState;
    /** Server URL as stored, whether or not the state exposes it to renders. */
    url: string | null;
    /** True when the server process was spawned by this extension (not adopted). */
    owned: boolean;
    /** PID of the spawned server process, or null when none is held. */
    pid: number | null;
    /** True while a ready promise exists (a start is pending or waiters are queued). */
    startPending: boolean;
    /** True from a start's Java check until its outcome. */
    startInFlight: boolean;
    /** True from a stop until the next start begins. */
    stoppingIntentionally: boolean;
    /** True while an adopted server is being health-watched. */
    adoptWatchActive: boolean;
    /** Consecutive failed health checks of the adopted server. */
    adoptProbeFailures: number;
    /** True while a liveness probe confirming a failed render is running. */
    renderFailProbeActive: boolean;
    /** Number of start attempts since activation. */
    startAttemptCount: number;
    /** Number of server processes spawned since activation. */
    spawnCount: number;
    /** Message of the most recent error that rejected the ready promise, if any. */
    lastErrorMessage: string | null;
    /** Starts that failed in a row since the last event; renders stop retrying at {@link MAX_FAILED_ATTEMPTS}. */
    failedAttempts: number;
    /** Kind of the unavailability reason ('java-not-found', 'port-in-use', ...), or null. */
    unavailableReason: string | null;
    /** True from an event until the guidance of a failure is shown. */
    noticePending: boolean;
}

/**
 * Read the current local-server state without changing it.
 * Used only by test diagnostics; nothing in the extension's behavior depends on it.
 *
 * @returns A plain snapshot of the module-level server state.
 */
export function getLocalServerDiagnostics(): LocalServerDiagnostics {
    return {
        state: serverState,
        url: serverUrl,
        owned: ownedProcess,
        pid: serverProcess?.pid ?? null,
        startPending: readyPromise !== null,
        startInFlight: activeStart !== null,
        stoppingIntentionally,
        adoptWatchActive: adoptWatchTimer !== null,
        adoptProbeFailures,
        renderFailProbeActive: renderFailProbe !== null,
        startAttemptCount,
        spawnCount,
        lastErrorMessage,
        failedAttempts,
        unavailableReason: unavailableReason?.kind === 'java'
            ? `java-${unavailableReason.result.status}`
            : unavailableReason?.kind ?? null,
        noticePending,
    };
}

/**
 * Build a cause-specific message for when the local server URL is unavailable at render time.
 * - Either mode, while the start is still in progress (the render stopped waiting
 *   before it finished): say so instead of reporting a failure.
 * - Start mode 'off' (external connect): the failed connect's reason, or for a lost
 *   connection the configured host/port.
 * - Start mode 'on'/'lazy' (managed): the reason and how to fix it; once renders
 *   stopped retrying, also how to try again.
 *
 * @param config - Current extension settings (start mode, host, port).
 * @returns A localized, user-facing message string.
 */
export function localServerUnavailableMessage(config: Config): string {
    if (serverState === 'starting') {
        return vscode.l10n.t(
            'The local PlantUML server is still starting, so this diagram could not be rendered yet. Render again once the server is ready, for example by editing the file or reopening the preview. See the "{0}" channel in the Output panel for progress.',
            OUTPUT_CHANNEL_NAME,
        );
    }
    if (!isManagedServerMode(config)) {
        // The failed connect's reason (e.g. no port set); a lost connection has none.
        if (unavailableReason) return reasonText(unavailableReason);
        const host = config.plantumlLocalServerHost || '127.0.0.1';
        const port = config.plantumlLocalServerPort;
        return vscode.l10n.t('No PlantUML server found at {0}:{1}. Start a server there, or change "Start Mode" to "on" or "lazy".', host, String(port));
    }
    const text = unavailableReason
        ? reasonText(unavailableReason)
        : vscode.l10n.t('The local PlantUML server failed to start. See the "{0}" channel in the Output panel for details.', OUTPUT_CHANNEL_NAME);
    return failedAttempts >= MAX_FAILED_ATTEMPTS ? `${text} ${retriesStoppedText()}` : text;
}

/**
 * Text for the diagram's place: the reason and how to fix it.
 *
 * @param reason - The unavailability reason of a managed server.
 * @returns A localized message.
 */
function reasonText(reason: UnavailableReason): string {
    switch (reason.kind) {
        case 'java':
            if (reason.result.status === 'missing-path') {
                return vscode.l10n.t('Java path "{0}" does not exist. Fix the plantumlMarkdownPreview.javaPath setting or switch to Easy mode.', reason.javaPath);
            }
            if (reason.result.status === 'too-old') {
                return reason.result.major !== null
                    ? vscode.l10n.t('Java {0} is installed, but the bundled PlantUML requires Java 11 or later. Install Java 11 or later, set plantumlMarkdownPreview.javaPath, or switch to Easy mode.', String(reason.result.major))
                    : vscode.l10n.t('The installed Java is too old: the bundled PlantUML requires Java 11 or later. Install Java 11 or later, set plantumlMarkdownPreview.javaPath, or switch to Easy mode.');
            }
            return vscode.l10n.t('Java is not found. Install Java 11 or later (restart VS Code if you installed it in a new location), set plantumlMarkdownPreview.javaPath, or switch to Easy mode.');
        case 'port-in-use':
            return portInUseText();
        case 'start-failed':
            return vscode.l10n.t('The local PlantUML server failed to start: {0}. See the "{1}" channel in the Output panel for details.', reason.detail, OUTPUT_CHANNEL_NAME);
        case 'external-not-found':
            return reason.message;
    }
}

/** Text of a fixed port held by something that is not a PlantUML server. */
function portInUseText(): string {
    return vscode.l10n.t('The configured local server port is already in use by another process. Set the port to 0 (auto) or choose a different port.');
}

/** Text appended once renders stopped retrying the start. */
function retriesStoppedText(): string {
    return vscode.l10n.t('Automatic retries stopped. Click Retry or the preview\'s Reload button, reopen the preview, or change the settings to try again.');
}

/**
 * Wait for the server to become ready.
 * Resolves immediately if already running, or when no start is pending (no
 * readyPromise); the caller then checks getLocalServerUrl. A pending start is
 * awaited in any state, including 'error' while a retry runs.
 *
 * Note: This function has its own 15s timeout independent of startLocalServer's
 * internal waitForReady timeout. If this timeout fires while the start is still
 * running, getLocalServerUrl() returns null and the caller shows the message.
 */
export async function waitForLocalServer(): Promise<void> {
    if (serverState === 'running') return;
    if (!readyPromise) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            readyPromise,
            new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Local server start timeout')), 15_000);
            }),
        ]);
    } catch {
        // Rejected by a failed start (failStart), a lost server, a stop, or the
        // timeout. The caller checks getLocalServerUrl().
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Restart the server with new configuration. Renders that arrive while the old
 * process exits wait for the new start.
 *
 * @param config - New extension settings to apply.
 */
export async function restartLocalServer(config: Config): Promise<void> {
    stopLocalServer();
    const generation = startGeneration;
    prepareLocalServer();
    // Wait for the old process to exit so its port is released before starting a new one.
    await stopExitPromise;
    // A newer stop or start ran meanwhile and owns the server now.
    if (generation !== startGeneration) return;
    await startLocalServer(config);
}

/**
 * Render-path start trigger, called right before waitForLocalServer()
 * (preview.ts / puml-preview.ts / exporter.ts / plantuml-server.ts). The start is
 * fire-and-forget; the following waitForLocalServer() awaits it.
 *
 * Only in a managed mode ('on'/'lazy'), and never while running or while a start
 * is pending, so concurrent renders start at most once:
 * - 'error': retry the start silently, unless {@link MAX_FAILED_ATTEMPTS} starts
 *   failed in a row since the last event.
 * - 'stopped' in start mode 'lazy': the first start.
 *
 * @param config - Current extension settings (reads startMode / renderMode).
 */
export function ensureLocalServerStarted(config: Config): void {
    if (config.renderMode !== 'local-server' || !isManagedServerMode(config)) return;
    if (serverState === 'running' || activeStart !== null || readyPromise) return;
    if (serverState === 'error') {
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) return;
    } else if (serverState !== 'stopped' || !isLazyDeferralActive(config)) {
        return;
    }
    void startLocalServer(config);
}

/** Record an event: the next failure shows its guidance, and renders retry again. */
function markEvent(): void {
    noticePending = true;
    failedAttempts = 0;
}

/**
 * The user (or the server) did something after which a failure should be shown
 * again and renders should retry again: opening a preview, its Reload button,
 * an export of a document with PlantUML diagrams, a settings change that
 * restarts the server, Retry or Restart Server. A server in 'error' starts at
 * once; a stopped one is left to its start mode ('lazy' stays deferred).
 *
 * @param config - Current extension settings.
 * @param options - checkJava: also check Java while the server is not running
 *   (opening a preview, Reload, export), so a missing Java is shown even when
 *   nothing renders a diagram.
 */
export function handleServerEvent(config: Config, options: { checkJava?: boolean } = {}): void {
    markEvent();
    if (config.renderMode !== 'local-server' || serverState === 'running') return;
    if (serverState === 'error' && activeStart === null && !readyPromise) {
        void startLocalServer(config);
        return;
    }
    // A start in progress checks Java itself and reports its own outcome.
    if (options.checkJava && activeStart === null && checksJavaOnOpen(config, serverState)) {
        void checkJavaForEvent(config);
    }
}

/**
 * Java check of an event that found the server not running. A missing Java is a
 * failed start; a start that began or is running reports its own outcome.
 *
 * @param config - Current extension settings.
 */
async function checkJavaForEvent(config: Config): Promise<void> {
    if (!javaChecker) return;
    const generation = startGeneration;
    const result = await javaChecker(config).catch(() => UNKNOWN_JAVA);
    if (generation !== startGeneration || activeStart !== null || readyPromise || serverState === 'running') return;
    if (isJavaUnusable(result.status)) failStart({ kind: 'java', result, javaPath: config.javaPath });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find a free port. If preferredPort > 0, use it directly; otherwise let the OS assign.
 *
 * Note: When auto-assigning (preferredPort <= 0), there is an inherent TOCTOU
 * race between releasing the probed port and the Java server binding to it.
 * The caller mitigates this with a retry loop and a usedPorts set to avoid
 * re-selecting the same port.
 *
 * @param preferredPort - Port number to use; 0 means auto-assign.
 * @param excludePorts - Ports to skip (already tried and failed).
 * @returns Resolved port number.
 */
async function findFreePort(preferredPort: number, excludePorts?: Set<number>): Promise<number> {
    if (preferredPort > 0) return preferredPort;
    const MAX_PROBE = 5;
    for (let i = 0; i < MAX_PROBE; i++) {
        const port = await new Promise<number>((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address() as net.AddressInfo;
                srv.close(() => resolve(addr.port));
            });
            srv.on('error', reject);
        });
        if (!excludePorts?.has(port)) return port;
    }
    // Give up excluding — return whatever the OS gives
    return new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address() as net.AddressInfo;
            srv.close(() => resolve(addr.port));
        });
        srv.on('error', reject);
    });
}

/**
 * Build Java CLI arguments for the picoweb server.
 *
 * @param config - Extension settings (plantumlJarPath, dotPath, JVM heap settings).
 * @param port - Port number for the picoweb server.
 * @returns Array of CLI arguments.
 */
export function buildArgs(config: Config, port: number): string[] {
    // Heap flags (-Xms/-Xmx + fixed flags) are JVM options, so they must come before -jar.
    // For unlimited this is an empty array = exactly the legacy argument list (design §1.2 / §5.3).
    const heapArgs = resolveJvmHeapArgs(config);
    const args = [...heapArgs, '-Djava.awt.headless=true', '-jar', config.plantumlJarPath, '-picoweb:' + port + ':127.0.0.1'];
    if (config.dotPath && config.dotPath !== 'dot') {
        // -graphvizdot is a PlantUML app arg; insert it right after the jar path (before -picoweb).
        const jarIndex = args.indexOf('-jar');
        args.splice(jarIndex + 2, 0, '-graphvizdot', config.dotPath);
    }
    return args;
}

/**
 * Health-check URL path for a picoweb server. A minimal encoded PlantUML
 * diagram (`@startuml\nBob->Alice:hi\n@enduml`) rendered as SVG. A PlantUML
 * server returns HTTP 200 + SVG; anything else is not a usable picoweb.
 */
const HEALTH_CHECK_PATH = '/svg/SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IW80';

/**
 * What answers at a base URL:
 * - 'plantuml'     : a PlantUML server (HTTP 200 with an SVG Content-Type).
 * - 'not-plantuml' : something accepts connections but is not a PlantUML server
 *                    (another response, or no response in time).
 * - 'not-listening': nothing accepts connections there.
 */
export type ProbeResult = 'plantuml' | 'not-plantuml' | 'not-listening';

/** Longest wait for a connection before a probe reports 'not-listening'. */
const PROBE_CONNECT_MS = 2000;

/**
 * Probe a base URL for a PlantUML server. The single health check used to adopt
 * an existing server (a zombie, the user's manual picoserver, or a LAN host), to
 * tell a port taken by another program before spawning, and to poll our own
 * spawned child for readiness — one implementation so the paths never disagree.
 *
 * Requires an SVG Content-Type, not just a 200: a catch-all web server (e.g. an
 * SPA dev server returning index.html with inline SVG for every path) must not
 * pass as a PlantUML server.
 *
 * @param baseUrl - Server base URL (e.g. `http://127.0.0.1:4243`).
 * @param timeoutMs - Request timeout. Default is generous because a cold
 *   picoweb's FIRST render takes ~5-6s (JVM/font warmup; ~100ms once warm).
 *   The connection itself is given at most {@link PROBE_CONNECT_MS}.
 * @returns What answers at the URL.
 */
export async function probeServer(baseUrl: string, timeoutMs = 8000): Promise<ProbeResult> {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        // A host that does not form a URL (e.g. an IPv6 address without brackets) names nothing to connect to.
        return 'not-listening';
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const portNumber = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    if (!await acceptsConnections(host, portNumber, Math.min(timeoutMs, PROBE_CONNECT_MS))) return 'not-listening';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${baseUrl}${HEALTH_CHECK_PATH}`, { signal: controller.signal });
        // Consume the response body to release the HTTP connection back to the pool.
        await res.text();
        const contentType = res.headers.get('content-type') ?? '';
        return res.ok && contentType.includes('svg') ? 'plantuml' : 'not-plantuml';
    } catch {
        // Connected, but no usable answer (no response in time, connection dropped).
        return 'not-plantuml';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Whether a PlantUML server answers at a base URL ({@link probeServer}).
 *
 * @param baseUrl - Server base URL (e.g. `http://127.0.0.1:4243`).
 * @param timeoutMs - Request timeout (see {@link probeServer}).
 * @returns True if the URL responds with HTTP 200 and an SVG Content-Type.
 */
export async function probeExisting(baseUrl: string, timeoutMs = 8000): Promise<boolean> {
    return (await probeServer(baseUrl, timeoutMs)) === 'plantuml';
}

/**
 * Whether something accepts a TCP connection at host:port.
 *
 * @param host - Host name or address.
 * @param port - Port number.
 * @param timeoutMs - Longest wait for the connection.
 * @returns True once connected; false on an error or the timeout.
 */
function acceptsConnections(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const finish = (connected: boolean): void => {
            clearTimeout(timer);
            socket.destroy();
            resolve(connected);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

/**
 * Adopt an already-running server (owned=false — we never kill it).
 * Transitions to 'running', resolves waiters, and starts the liveness watchdog.
 *
 * @param url - Base URL of the server to use.
 * @param notice - Message shown to the user.
 */
function adoptServer(url: string, notice: string): void {
    serverUrl = url;
    ownedProcess = false;
    rememberPid(undefined); // we don't own it; nothing to clean up later
    setServerState('running');
    readyResolve?.();
    log(`[local-server] Adopted existing server at ${url}`);
    showTransientInfo(notice);
    startAdoptWatchdog(url);
}

/** How long a routine success notification stays visible before auto-closing. */
const TRANSIENT_INFO_MS = 5_000;

/**
 * Show an info notification that closes itself after a few seconds.
 *
 * showInformationMessage has no timeout and its toast can linger; a
 * progress-location notification closes when the task resolves, which
 * is the only supported way to auto-dismiss. Used for routine success
 * messages (adopt / external connect) that need no user action.
 *
 * @param message - Text to show in the notification.
 */
function showTransientInfo(message: string): void {
    void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message },
        () => sleep(TRANSIENT_INFO_MS)
    );
}

/** Liveness watchdog for adopted servers (they have no process handle to watch). */
let adoptWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Consecutive failed probes; the watchdog trips on the second miss. */
let adoptProbeFailures = 0;
/** Interval between liveness probes of an adopted server. */
const ADOPT_WATCH_INTERVAL_MS = 30_000;

/**
 * Periodically re-probe an adopted server. A spawned server reports crashes via
 * its process events; an adopted one has no process handle, so without this the
 * extension would stay 'running' forever after the external server dies.
 *
 * @param url - Base URL of the adopted server.
 */
function startAdoptWatchdog(url: string): void {
    stopAdoptWatchdog();
    adoptProbeFailures = 0;
    adoptWatchTimer = setInterval(async () => {
        if (serverState !== 'running' || ownedProcess || serverUrl !== url) {
            stopAdoptWatchdog();
            return;
        }
        if (await probeExisting(url)) {
            adoptProbeFailures = 0;
            return;
        }
        if (++adoptProbeFailures < 2) return;
        stopAdoptWatchdog();
        // Re-check after the await — a stop/crash may have won the race.
        if (serverState !== 'running' || ownedProcess || serverUrl !== url) return;
        log(`[local-server] Lost connection to the adopted PlantUML server at ${url}`);

        // In a managed mode ('on'/'lazy', the default), surface the loss first
        // (error state + notification, so the status bar and the user see it),
        // THEN try the start. startLocalServer() re-runs the full dispatch — if
        // another window already respawned on the fixed port we re-adopt it;
        // otherwise this window spawns and becomes the new owner. The loss is an
        // event, so a failed start shows its reason's guidance.
        const config = getLatestConfig?.();
        if (config && isManagedServerMode(config)) {
            tripToError(false);
            notifyLost(vscode.l10n.t('Lost connection to the PlantUML server at {0}.', url), false);
            void startLocalServer(config);
            return;
        }

        // External-connect mode ('off'): we must not spawn — surface the loss,
        // but KEEP the URL: error-state renders keep fetching the endpoint and
        // a successful response flips the state back to 'running'
        // (handleRenderSuccess). The manual Retry notification stays as well.
        tripToError(true);
        const message = vscode.l10n.t('Lost connection to the PlantUML server at {0}.', url);
        log(`[local-server] ${message}`);
        notifyLost(message, true);
    }, ADOPT_WATCH_INTERVAL_MS);
}

/** Stop the adopted-server liveness watchdog, if running. */
function stopAdoptWatchdog(): void {
    if (adoptWatchTimer) {
        clearInterval(adoptWatchTimer);
        adoptWatchTimer = null;
    }
}

// ---------------------------------------------------------------------------
// Render-path loss detection & recovery (first-line detection; the watchdog and
// the child-process events are the fallback for "died while idle")
// ---------------------------------------------------------------------------

/**
 * Verdict returned by handleRenderFailure:
 * - 'alive': the server answered the confirmation probe — the failure was
 *   transient; the caller should retry the same fetch once.
 * - 'lost' : the loss is confirmed (state is now 'error'), or the server was
 *   not in a probeable state to begin with. In managed modes the caller waits
 *   for the restart (ensureLocalServerStarted + waitForLocalServer) and re-runs
 *   the same render; in 'off' the caller shows the endpoint error.
 */
export type RenderFailureVerdict = 'alive' | 'lost';

/**
 * In-flight confirmation probe. Diagrams render concurrently, so one dead
 * server produces a burst of failures — the first caller runs the probe and
 * every later caller awaits the same conclusion (single-probe guarantee).
 */
let renderFailProbe: Promise<RenderFailureVerdict> | null = null;

/**
 * First-line loss detection: called by the render path when a fetch to the
 * local server failed at the CONNECTION level (refused / timed out). An HTTP
 * error response is proof of life and must NOT be reported here.
 *
 * Confirms the loss with the same strength as the adopt watchdog (2 consecutive
 * probe failures) so a transient hiccup does not tear the connection down, then
 * transitions to 'error' immediately (status bar follows via the state
 * listener). Cleanup depends on how we got the server:
 * - owned  : reclaim the unresponsive child (frees the port for the respawn)
 * - adopted: leave the foreign process alone
 * - off    : leave it alone AND keep the URL (renders keep fetching it)
 *
 * This function only trips the state — it never starts a server. The failed
 * render drives the restart via ensureLocalServerStarted so the start is tied
 * to a render that is actively waiting for it.
 */
export function handleRenderFailure(): Promise<RenderFailureVerdict> {
    // Only a 'running' server can trip: 'error' has already tripped elsewhere,
    // and 'starting'/'stopped' are owned by the start flow. Report 'lost' so
    // the caller falls into the wait-for-start (managed) or error-box ('off') path.
    if (serverState !== 'running' || !serverUrl) return Promise.resolve('lost');
    if (renderFailProbe) return renderFailProbe;
    renderFailProbe = confirmRenderFailure().finally(() => { renderFailProbe = null; });
    return renderFailProbe;
}

/** Run the confirmation probes and trip to 'error' when the loss is confirmed. */
async function confirmRenderFailure(): Promise<RenderFailureVerdict> {
    const url = serverUrl!;
    for (let i = 0; i < 2; i++) {
        if (await probeExisting(url)) return 'alive';
    }
    // Supersede guard: a stop / restart / crash / another trip may have run
    // while the probes were in flight — leave the state to whoever owns it now.
    if (serverState !== 'running' || serverUrl !== url) {
        return (serverState as string) === 'running' ? 'alive' : 'lost';
    }
    log(`[local-server] Render failure confirmed loss of the PlantUML server at ${url}`);
    const wasOwned = ownedProcess;
    if (ownedProcess && serverProcess) {
        // Reclaim the unresponsive child so the port is free for the respawn.
        // SIGKILL directly: the process already failed to answer two probes,
        // a graceful SIGTERM would only delay the port release.
        const proc = serverProcess;
        proc.removeAllListeners('error');
        proc.removeAllListeners('close');
        proc.stdout?.removeAllListeners('data');
        proc.stderr?.removeAllListeners('data');
        if (process.platform === 'win32' && proc.pid) {
            killProcessTree(proc.pid, 'SIGKILL');
        } else {
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }
        serverProcess = null;
        ownedProcess = false;
        rememberPid(undefined);
    }
    const config = getLatestConfig?.();
    if (!config || isManagedServerMode(config)) {
        // Managed ('on'/'lazy'): error without URL. The failed render restarts
        // the server via ensureLocalServerStarted and re-runs itself.
        tripToError(false);
        notifyLost(wasOwned
            ? vscode.l10n.t('The local PlantUML server stopped responding ({0}).', url)
            : vscode.l10n.t('Lost connection to the PlantUML server at {0}.', url), false);
    } else {
        // External-connect ('off'): never spawn. Keep the URL so every render
        // keeps fetching the endpoint; a successful response recovers the state
        // (handleRenderSuccess). The manual Retry notification stays available.
        tripToError(true);
        notifyLost(vscode.l10n.t('Lost connection to the PlantUML server at {0}.', url), true);
    }
    return 'lost';
}

/**
 * Unconditional "the server answered a render request" notification from the
 * render path (called on every successful response, including a syntax-error
 * 400 + SVG — any proper HTTP response is proof of life).
 *
 * Only external-connect mode ('off') recovers here: when the state is 'error'
 * with the kept URL, flip straight back to 'running' and re-arm the adopt
 * watchdog. Managed modes recover through their start flow instead, and a
 * healthy state makes this a no-op.
 */
export function handleRenderSuccess(): void {
    if (serverState !== 'error' || !serverUrl) return;
    const config = getLatestConfig?.();
    if (!config || isManagedServerMode(config)) return;
    const url = serverUrl;
    setServerState('running');
    log(`[local-server] External PlantUML server responded — reconnected at ${url}`);
    void vscode.window.showInformationMessage(
        vscode.l10n.t('Reconnected to the PlantUML server at {0}.', url)
    );
    startAdoptWatchdog(url);
}

/**
 * Mark a start as failed: keep the reason, set 'error', reject and clear waiters.
 * Then the failure rules: count it (start mode 'off' is not counted), show the
 * reason's guidance if no failure was shown since the last event, and say so once
 * renders stop retrying. Callers must have checked that the start was not
 * superseded.
 *
 * @param reason - Why the server cannot be used.
 */
function failStart(reason: UnavailableReason): void {
    unavailableReason = reason;
    setServerState('error');
    // The start is over from here: an event that arrives before the start's own
    // promise settles (e.g. Retry answered at once) must be able to start again.
    activeStart = null;
    const guidance = reasonGuidance(reason);
    // Clear the promise trio — a later start must create a fresh pending promise.
    clearReadyPromise(new Error(reason.kind === 'start-failed' ? reason.detail : guidance.message));
    log(`[local-server] ${guidance.message}`);
    const counted = reason.kind !== 'external-not-found';
    if (counted) failedAttempts++;
    if (noticePending) {
        noticePending = false;
        notifyOnce(guidance);
    }
    if (counted && failedAttempts === MAX_FAILED_ATTEMPTS) {
        log(`[local-server] Automatic retries stopped after ${MAX_FAILED_ATTEMPTS} failed starts`);
        notifyOnce({
            message: `${guidance.message} ${retriesStoppedText()}`,
            severity: guidance.severity,
            actions: [...guidance.actions.filter(action => action.run && action.label !== restartLabel()), retryAction()],
        });
    }
}

/** Label of the Restart Server button. */
function restartLabel(): string {
    return vscode.l10n.t('Restart Server');
}

/**
 * The Retry button: an event that starts the server again with the latest settings.
 *
 * @returns The action.
 */
function retryAction(): GuidanceAction {
    return {
        label: vscode.l10n.t('Retry'),
        run: startAgain,
    };
}

/** Retry and Restart Server: an event with the latest settings. */
function startAgain(): void {
    if (getLatestConfig) handleServerEvent(getLatestConfig());
}

/**
 * Guidance for a reason. The text never contains changing values (exit codes,
 * PIDs), so the same reason is never shown twice at once.
 *
 * @param reason - Why the server cannot be used.
 * @returns The guidance.
 */
function reasonGuidance(reason: UnavailableReason): Guidance {
    switch (reason.kind) {
        case 'java':
            // Non-null: failStart receives only Java outcomes that are unusable.
            return javaGuidance(reason.result, reason.javaPath)!;
        case 'port-in-use':
            return {
                message: portInUseText(),
                severity: 'error',
                actions: [{
                    label: vscode.l10n.t('Open Settings'),
                    run: () => vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.plantumlLocalServerPort`),
                }],
            };
        case 'start-failed':
            return {
                message: vscode.l10n.t('The local PlantUML server failed to start. See the "{0}" channel in the Output panel for details.', OUTPUT_CHANNEL_NAME),
                severity: 'error',
                actions: [
                    { label: restartLabel(), run: startAgain },
                    {
                        label: vscode.l10n.t('Switch to Secure Mode'),
                        run: () => vscode.workspace.getConfiguration(CONFIG_SECTION).update('mode', 'secure', vscode.ConfigurationTarget.Global),
                    },
                    { label: vscode.l10n.t('Dismiss') },
                ],
            };
        case 'external-not-found':
            return { message: reason.message, severity: 'error', actions: [retryAction()] };
    }
}

/**
 * Show the notice of a running server that was lost. It is not a failure's
 * guidance, so a failed restart afterwards still shows its own.
 *
 * @param message - Notification text.
 * @param withRetry - Offer Retry (start mode 'off', which never restarts by itself).
 */
function notifyLost(message: string, withRetry: boolean): void {
    notifyOnce({ message, severity: 'error', actions: withRetry ? [retryAction()] : [] });
}

/**
 * Poll our spawned server until it passes the shared health check, or timeout.
 *
 * Uses probeExisting (Content-Type validated): a foreign server that happens to
 * answer 200 on the same port while our child died of BindException must not be
 * mistaken for our own child becoming ready.
 *
 * @param port - Port number to health-check.
 * @param superseded - Stops polling once the calling start has been superseded.
 * @param exited - Stops polling once the child has ended.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 */
async function waitForReady(port: number, superseded: () => boolean, exited: () => boolean, timeoutMs = 15_000, intervalMs = 500): Promise<void> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && serverState === 'starting' && !superseded() && !exited()) {
        if (await probeExisting(baseUrl, 2000)) return;
        await sleep(intervalMs);
    }

    if (exited()) throw new Error('Server exited before it was ready');
    throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

/**
 * Promisified delay for polling loops.
 *
 * @param ms - Delay in milliseconds.
 * @returns Promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Reset all module-level state to initial values.
 *  Note: killTimer is intentionally NOT cleared here — it is managed
 *  exclusively by the SIGKILL fallback and the process exit handler
 *  in stopLocalServer() so that SIGKILL can still fire after resetState(). */
function resetState(): void {
    stopAdoptWatchdog();
    setServerState('stopped');
    serverUrl = null;
    ownedProcess = false;
    // Reject any pending waiters. When called from stopLocalServer(), readyReject
    // is already null (cleared in stopLocalServer) so rejectFn is a no-op. However, if
    // startLocalServer's retry loop replaced readyReject with a new Promise before
    // stop was called, this catches that replacement.
    const rejectFn = readyReject;
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
    rejectFn?.(new Error('Server stopped'));
}

/**
 * Write a message to the PlantUML output channel.
 *
 * @param message - Text to append to the output channel.
 */
function log(message: string): void {
    outputChannel?.appendLine(message);
}

/**
 * After a fixed-port BindException, wait for the racing winner (another window
 * that started a server on the same port) to become ready, then adopt it. Part
 * of the start: the ready promise stays pending, so renders wait meanwhile.
 *
 * @param config - Current extension settings.
 * @param superseded - True once the start has been superseded.
 * @returns True when a server was adopted.
 */
async function recoverByAdoptingPort(config: Config, superseded: () => boolean): Promise<boolean> {
    const url = `http://127.0.0.1:${config.plantumlLocalServerPort}`;
    log(`[local-server] Port ${config.plantumlLocalServerPort} busy — waiting to adopt the server another window is starting`);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        // A user action (stop / mode switch / manual restart) supersedes recovery.
        if (superseded()) return false;
        if (await probeExisting(url, 2000)) {
            if (superseded()) return false;
            adoptServer(url, vscode.l10n.t('Reusing PlantUML server already running on port {0}.', String(config.plantumlLocalServerPort)));
            return true;
        }
        await sleep(1000);
    }
    return false;
}

/**
 * Handle the unexpected end of a server that was running. The loss is an event:
 * transition to 'error' (the status bar follows) and start again at once with the
 * latest settings, without a notification. If that start fails, it shows its
 * reason's guidance ({@link failStart}).
 *
 * @param reason - Human-readable end reason (e.g. exit code or signal).
 */
function handleCrash(reason: string): void {
    if (serverState !== 'running') return;
    serverProcess = null;
    ownedProcess = false;
    rememberPid(undefined); // our process died; nothing left to clean up
    serverUrl = null;
    setServerState('error');
    clearReadyPromise(new Error(reason));
    markEvent();
    if (!getLatestConfig) return;
    log('[local-server] Attempting automatic restart after crash');
    void startLocalServer(getLatestConfig());
}
