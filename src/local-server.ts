/**
 * @module local-server
 * @description Manages a local PlantUML picoweb server process.
 *
 * Key behaviors:
 * - Starts a PlantUML jar in `-picoweb` mode on a free (or user-specified) port
 * - Binds to 127.0.0.1 only (no external network exposure)
 * - Health-checks the server via HTTP polling until ready
 * - Exposes the server URL for use by the existing server rendering pipeline
 * - Detects crashes and notifies the user (no silent fallback)
 * - Cleans up the child process on stop/deactivate
 */
import * as net from 'net';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { spawnJava, killProcessTree, isProcessAlive, looksLikeJavaProcess } from './utils.js';
import { resolveIncludePath } from './plantuml.js';
import type { Config } from './config.js';
import { CONFIG_SECTION, resolveJvmHeapArgs } from './config.js';

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

/** SIGKILL fallback timer (module-level so resetState can clear it). */
let killTimer: ReturnType<typeof setTimeout> | null = null;

/** Update serverState and notify the listener if changed. */
function setServerState(state: LocalServerState): void {
    if (serverState === state) return;
    serverState = state;
    onStateChange?.(state);
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

/** Java availability checker registered by extension.ts (shows its own dialogs). */
let javaChecker: ((config: Config) => Promise<boolean>) | null = null;

/**
 * Register the Java availability checker used before spawning a managed server.
 * Adoption and external-connect paths never invoke it — they need no local Java.
 *
 * @param checker - Function resolving to true when a usable Java is available.
 */
export function setJavaAvailabilityChecker(checker: (config: Config) => Promise<boolean>): void {
    javaChecker = checker;
}

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
    readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
}

/**
 * Start the local PlantUML server.
 * No-op if already running or starting.
 *
 * Dispatches on the `plantumlLocalServerAutoStart` setting:
 * - false: connect to an existing server at host:port (never spawn).
 * - true : if a fixed port already serves a healthy picoweb, adopt it; otherwise spawn.
 *
 * @param config - Current extension settings.
 */
export async function startLocalServer(config: Config): Promise<void> {
    if (serverState === 'running' || serverState === 'starting') return;

    stoppingIntentionally = false;
    setServerState('starting');
    if (!readyPromise) {
        readyPromise = new Promise<void>((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });
    }

    // Wait for any previous-session cleanup so we don't bind a port still held by a dying zombie.
    if (staleCleanupPromise) {
        await staleCleanupPromise;
        if (stoppingIntentionally) return;
    }

    const port = config.plantumlLocalServerPort;

    // --- External-connect mode: never spawn, just connect to host:port ---
    if (!config.plantumlLocalServerAutoStart) {
        const host = config.plantumlLocalServerHost || '127.0.0.1';
        if (port <= 0) {
            failStart(vscode.l10n.t('Set a port for the external PlantUML server (Fast mode, auto-start off).'));
            return;
        }
        const url = `http://${host}:${port}`;
        if (await probeExisting(url)) {
            if (stoppingIntentionally) return;
            adoptServer(url, vscode.l10n.t('Connected to PlantUML server at {0}', url));
        } else if (!stoppingIntentionally) {
            failStart(vscode.l10n.t('No PlantUML server found at {0}. Start it, or turn auto-start on.', url));
        }
        return;
    }

    // --- Auto-start mode: adopt an existing healthy picoweb on a fixed port, else spawn ---
    // Adopt is attempted before the jar/Java requirements: connecting to an
    // already-running server needs neither.
    if (port > 0) {
        const url = `http://127.0.0.1:${port}`;
        if (await probeExisting(url)) {
            if (stoppingIntentionally) return;
            adoptServer(url, vscode.l10n.t('Reusing PlantUML server already running on port {0}.', String(port)));
            return;
        }
        if (stoppingIntentionally) return;
    }

    if (!config.plantumlJarPath) {
        log('[local-server] plantumlJarPath is not configured, cannot start');
        failStart(vscode.l10n.t('PlantUML jar path is not configured.'));
        return;
    }

    // Spawning requires a working Java; adoption and external-connect do not.
    // The checker (registered by extension.ts) shows its own guidance dialogs.
    if (javaChecker) {
        const javaFound = await javaChecker(config).catch(() => false);
        if (stoppingIntentionally) return;
        if (!javaFound) {
            // Same behavior as the old pre-start check: release waiters and stop.
            stopLocalServer();
            return;
        }
    }

    await spawnManagedServer(config);
}

/**
 * Spawn and manage our own picoweb server (owned=true), bound to 127.0.0.1.
 * Retries on a different port only in auto-port mode.
 *
 * @param config - Current extension settings.
 */
async function spawnManagedServer(config: Config): Promise<void> {
    const MAX_PORT_RETRIES = 3;
    const useAutoPort = config.plantumlLocalServerPort <= 0;
    const usedPorts = new Set<number>();

    for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
        // This guard also prevents re-setting readyReject after stopLocalServer() cleared it.
        if (stoppingIntentionally) return;
        try {
            const port = await findFreePort(config.plantumlLocalServerPort, usedPorts);
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
            if (child.pid) rememberPid(child.pid);

            let stderrBuf = '';
            child.stdout?.on('data', (chunk: Buffer) => log(`[local-server stdout] ${chunk.toString().trimEnd()}`));
            child.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString().trimEnd();
                log(`[local-server stderr] ${text}`);
                stderrBuf = (stderrBuf + text + '\n').slice(-4096);
            });

            child.on('error', (err) => {
                child.removeAllListeners('close'); // prevent double crash handling
                log(`[local-server] Process error: ${err.message}`);
                handleCrash(err.message, config, stderrBuf);
            });

            child.on('close', (code, signal) => {
                if (stoppingIntentionally) return;
                const reason = signal ? `signal ${signal}` : `exit code ${code}`;
                log(`[local-server] Process exited unexpectedly: ${reason}`);
                handleCrash(reason, config, stderrBuf);
            });

            await waitForReady(port);
            // Guard against concurrent crash/stop that fired during waitForReady.
            // Re-read serverState as a string — TypeScript narrows the module-level
            // variable but cannot track mutations across await boundaries.
            if (stoppingIntentionally || (serverState as string) !== 'starting') return;

            serverUrl = `http://127.0.0.1:${port}`;
            setServerState('running');
            readyResolve?.();
            log(`[local-server] Ready on port ${port}`);

            void vscode.window.showInformationMessage(
                vscode.l10n.t('Local PlantUML server started.')
            );
            return;
        } catch (err) {
            // Kill the failed child process before retrying
            if (serverProcess && !serverProcess.killed) {
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
            if (!useAutoPort || attempt === MAX_PORT_RETRIES - 1) {
                setServerState('error');
                readyReject?.(err as Error);
                log(`[local-server] Failed to start: ${(err as Error).message}`);
                return;
            }
            log(`[local-server] Port may be in use, retrying (${attempt + 1}/${MAX_PORT_RETRIES})...`);
            // Release any waiters on the previous promise before replacing it.
            readyReject?.(new Error('Retrying on different port'));
            readyPromise = new Promise<void>((resolve, reject) => {
                readyResolve = resolve;
                readyReject = reject;
            });
        }
    }
}

/**
 * Promise that resolves when the most recently stopped server process exits.
 * Used by `restartLocalServer` to wait for port release before starting a new server.
 */
let stopExitPromise: Promise<void> = Promise.resolve();

/**
 * Stop the local server. Safe to call even if not running.
 */
export function stopLocalServer(): void {
    stoppingIntentionally = true;
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
 * Get the current server URL, or null if not running.
 *
 * @returns The server base URL (e.g. `http://127.0.0.1:8080`), or null.
 */
export function getLocalServerUrl(): string | null {
    return serverState === 'running' ? serverUrl : null;
}

/**
 * Wait for the server to become ready.
 * Resolves immediately if already running. Returns without error if stopped/error
 * and no pending readyPromise (caller should check getLocalServerUrl).
 * When prepareLocalServer() was called, waits even in 'stopped' state.
 *
 * Note: This function has its own 15s timeout independent of startLocalServer's
 * internal waitForReady timeout. If this timeout fires while startLocalServer is
 * still retrying, serverState remains 'starting'. The caller should check
 * getLocalServerUrl() which returns null in this case.
 */
export async function waitForLocalServer(): Promise<void> {
    if (serverState === 'running') return;
    if (serverState === 'error') return;
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
        // Rejected by: port-retry ('Retrying on different port'), crash (handleCrash),
        // stop (stopLocalServer), or timeout. If the retry ultimately succeeded,
        // serverState is 'running' — treat as success. Otherwise the state is
        // 'error' or 'stopped' and the caller checks getLocalServerUrl().
        // Cast: TypeScript narrows serverState but cannot track mutations across await.
        if ((serverState as string) === 'running') return;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Restart the server with new configuration.
 *
 * @param config - New extension settings to apply.
 */
export async function restartLocalServer(config: Config): Promise<void> {
    stopLocalServer();
    // Wait for the old process to exit so its port is released before starting a new one.
    await stopExitPromise;
    prepareLocalServer();
    await startLocalServer(config);
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
    // ヒープフラグ（-Xms/-Xmx＋固定フラグ）は JVM オプションなので必ず -jar より前に置く。
    // unlimited のときは空配列＝現行と完全に同一の引数列になる（設計書 §1.2 / §5.3）。
    const heapArgs = resolveJvmHeapArgs(config);
    const args = [...heapArgs, '-Djava.awt.headless=true', '-jar', config.plantumlJarPath, '-picoweb:' + port + ':127.0.0.1'];
    if (config.dotPath && config.dotPath !== 'dot') {
        // -graphvizdot は PlantUML アプリ引数。jar パスの直後（-picoweb の前）に挿入する。
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
 * Probe a base URL to check whether a healthy PlantUML server is serving there.
 * The single health check used both to adopt an existing server (a zombie, the
 * user's manual picoserver, or a LAN host) and to poll our own spawned child
 * for readiness — one implementation so the two paths can never disagree.
 *
 * Requires an SVG Content-Type, not just a 200: a catch-all web server (e.g. an
 * SPA dev server returning index.html with inline SVG for every path) must not
 * pass as a PlantUML server.
 *
 * @param baseUrl - Server base URL (e.g. `http://127.0.0.1:4243`).
 * @param timeoutMs - Request timeout. Default is generous because a cold
 *   picoweb's FIRST render takes ~5-6s (JVM/font warmup; ~100ms once warm),
 *   and a free port fails instantly with ECONNREFUSED regardless — the
 *   timeout only matters when something is listening but slow.
 * @returns True if the URL responds with HTTP 200 and an SVG Content-Type.
 */
export async function probeExisting(baseUrl: string, timeoutMs = 8000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${baseUrl}${HEALTH_CHECK_PATH}`, { signal: controller.signal });
        // Consume the response body to release the HTTP connection back to the pool.
        await res.text();
        const contentType = res.headers.get('content-type') ?? '';
        return res.ok && contentType.includes('svg');
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
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
    void vscode.window.showInformationMessage(notice);
    startAdoptWatchdog(url);
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

        // When auto-start is on (the default), transparently recover instead of
        // parking in 'error': this is the "owner window closed first, another
        // window was adopting it" case. startLocalServer() re-runs the full
        // dispatch — if another window already respawned on the fixed port we
        // re-adopt it; otherwise this window spawns and becomes the new owner.
        // Concurrent windows racing to respawn converge naturally (a BindException
        // loser's next probe adopts the winner).
        const config = getLatestConfig?.();
        if (config?.plantumlLocalServerAutoStart) {
            serverUrl = null;
            resetState(); // back to 'stopped', fresh readyPromise on next start
            prepareLocalServer();
            void startLocalServer(config);
            return;
        }

        // External-connect mode (auto-start off): we must not spawn — surface the
        // loss with a manual Retry.
        serverUrl = null;
        setServerState('error');
        const message = vscode.l10n.t('Lost connection to the PlantUML server at {0}.', url);
        log(`[local-server] ${message}`);
        notifyErrorWithRetry(message);
    }, ADOPT_WATCH_INTERVAL_MS);
}

/** Stop the adopted-server liveness watchdog, if running. */
function stopAdoptWatchdog(): void {
    if (adoptWatchTimer) {
        clearInterval(adoptWatchTimer);
        adoptWatchTimer = null;
    }
}

/**
 * Mark startup as failed: set 'error' state, reject and clear waiters,
 * notify the user with a Retry action.
 *
 * @param message - Human-readable error shown to the user and logged.
 */
function failStart(message: string): void {
    setServerState('error');
    // Clear the promise trio like handleCrash does — a later start must create
    // a fresh pending promise, never reuse this settled one.
    const rejectFn = readyReject;
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
    rejectFn?.(new Error(message));
    log(`[local-server] ${message}`);
    notifyErrorWithRetry(message);
}

/**
 * Show an error notification with a Retry button that re-attempts the start
 * with the latest configuration (e.g. after the user launched their server).
 *
 * @param message - Error text to display.
 */
function notifyErrorWithRetry(message: string): void {
    const retryLabel = vscode.l10n.t('Retry');
    void vscode.window.showErrorMessage(message, retryLabel).then(async (action) => {
        if (action !== retryLabel || !getLatestConfig) return;
        try {
            prepareLocalServer();
            await startLocalServer(getLatestConfig());
        } catch { /* already logged by startLocalServer */ }
    });
}

/**
 * Poll our spawned server until it passes the shared health check, or timeout.
 *
 * Uses probeExisting (Content-Type validated): a foreign server that happens to
 * answer 200 on the same port while our child died of BindException must not be
 * mistaken for our own child becoming ready.
 *
 * @param port - Port number to health-check.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 */
async function waitForReady(port: number, timeoutMs = 15_000, intervalMs = 500): Promise<void> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && serverState === 'starting') {
        if (await probeExisting(baseUrl, 2000)) return;
        await sleep(intervalMs);
    }

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
 * After a fixed-port BindException under auto-start, wait for the racing winner
 * (another window that respawned on the same port) to become ready, then adopt
 * it. Falls back to the normal crash dialog if nothing healthy appears in time.
 *
 * @param config - Current extension settings.
 */
async function recoverByAdoptingPort(config: Config): Promise<void> {
    const url = `http://127.0.0.1:${config.plantumlLocalServerPort}`;
    log(`[local-server] Port ${config.plantumlLocalServerPort} busy — waiting to adopt the server another window is starting`);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        // A user action (stop / mode switch / manual restart) supersedes recovery.
        if (stoppingIntentionally || serverState !== 'error') return;
        if (await probeExisting(url, 2000)) {
            if (stoppingIntentionally || serverState !== 'error') return;
            prepareLocalServer();
            adoptServer(url, vscode.l10n.t('Reusing PlantUML server already running on port {0}.', String(config.plantumlLocalServerPort)));
            return;
        }
        await sleep(1000);
    }
    // No winner appeared — surface the port conflict for the user to resolve.
    const message = vscode.l10n.t('The configured local server port is already in use by another process. Set the port to 0 (auto) or choose a different port.');
    log(`[local-server] ${message}`);
    notifyErrorWithRetry(message);
}

/**
 * Handle unexpected server crash: notify user with action buttons.
 *
 * @param reason - Human-readable crash reason (e.g. exit code or signal).
 * @param config - Current extension settings for potential restart.
 * @param [stderr] - Accumulated stderr output for Java version error detection.
 */
function handleCrash(reason: string, config: Config, stderr?: string): void {
    if (serverState === 'error') return;
    serverProcess = null;
    ownedProcess = false;
    rememberPid(undefined); // our process died; nothing left to clean up
    setServerState('error');
    serverUrl = null;
    const rejectFn = readyReject;
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
    rejectFn?.(new Error(reason));

    const isVersionError = stderr?.includes('UnsupportedClassVersionError')
        || stderr?.includes('class file version');

    if (isVersionError) {
        const installJava = vscode.l10n.t('Install Java');
        const dismissLabel = vscode.l10n.t('Dismiss');
        void vscode.window.showErrorMessage(
            vscode.l10n.t('The bundled PlantUML requires Java 11 or later. Your Java version is too old. Please upgrade Java.'),
            installJava, dismissLabel
        ).then((action) => {
            if (action === installJava) {
                void vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/'));
            }
        });
        return;
    }

    const isPortInUse = stderr?.includes('BindException')
        || stderr?.includes('Address already in use');

    // Multi-window convergence: with auto-start on and a fixed port, several
    // windows can race to respawn after the owner window closed. The loser gets
    // BindException — but the winner is (cold-)starting on that same port, so
    // wait briefly and adopt it instead of dead-ending in an error dialog.
    if (isPortInUse && config.plantumlLocalServerAutoStart && config.plantumlLocalServerPort > 0) {
        void recoverByAdoptingPort(config);
        return;
    }

    const switchLabel = vscode.l10n.t('Switch to Secure Mode');
    const restartLabel = vscode.l10n.t('Restart Server');
    const dismissLabel = vscode.l10n.t('Dismiss');

    // A fixed port occupied by a non-PlantUML process: we couldn't adopt it (not a
    // picoweb) and couldn't bind. Tell the user plainly instead of a generic crash.
    const message = isPortInUse
        ? vscode.l10n.t('The configured local server port is already in use by another process. Set the port to 0 (auto) or choose a different port.')
        : vscode.l10n.t('Local PlantUML server crashed: {0}', reason);

    void vscode.window.showErrorMessage(
        message,
        switchLabel, restartLabel, dismissLabel
    ).then(async (action) => {
        try {
            if (action === switchLabel) {
                const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
                await cfg.update('mode', 'secure', vscode.ConfigurationTarget.Global);
            } else if (action === restartLabel) {
                prepareLocalServer();
                // Use the latest config (user may have changed settings since the crash).
                await startLocalServer(getLatestConfig ? getLatestConfig() : config);
            }
        } catch { /* already logged */ }
    });
}
