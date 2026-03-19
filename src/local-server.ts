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
import { spawnJava } from './utils.js';
import { resolveIncludePath } from './plantuml.js';
import type { Config } from './config.js';
import { CONFIG_SECTION } from './config.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Active PlantUML picoweb child process, or null when not running. */
let serverProcess: ChildProcess | null = null;
/** Base URL of the running server (e.g. `http://127.0.0.1:8080`), or null. */
let serverUrl: string | null = null;

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
 * Start the local PlantUML picoweb server.
 * No-op if already running or starting.
 *
 * @param config - Current extension settings (plantumlJarPath, javaPath, dotPath, plantumlLocalServerPort).
 */
export async function startLocalServer(config: Config): Promise<void> {
    if (serverState === 'running' || serverState === 'starting') return;

    if (!config.plantumlJarPath) {
        log('[local-server] plantumlJarPath is not configured, cannot start');
        return;
    }

    stoppingIntentionally = false;
    setServerState('starting');
    if (!readyPromise) {
        readyPromise = new Promise<void>((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });
    }

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

            let stderrBuf = '';
            child.stdout?.on('data', (chunk: Buffer) => log(`[local-server stdout] ${chunk.toString().trimEnd()}`));
            child.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString().trimEnd();
                log(`[local-server stderr] ${text}`);
                stderrBuf += text + '\n';
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
                stoppingIntentionally = true;
                serverProcess.kill();
                serverProcess = null;
                stoppingIntentionally = false; // reset before retry
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
    const wasRunning = serverProcess !== null;
    if (serverProcess) {
        serverProcess.removeAllListeners('error');
        serverProcess.removeAllListeners('close');
        serverProcess.stdout?.removeAllListeners('data');
        serverProcess.stderr?.removeAllListeners('data');
        const proc = serverProcess;
        serverProcess = null;
        proc.kill('SIGTERM');
        // SIGKILL fallback if SIGTERM doesn't terminate within 3 seconds
        const timerHandle = setTimeout(() => {
            if (killTimer !== timerHandle) return; // superseded by a newer stop call
            try { proc.kill('SIGKILL'); } catch { /* already exited */ }
            killTimer = null;
        }, 3000);
        killTimer = timerHandle;
        stopExitPromise = new Promise<void>(resolve => {
            const done = () => {
                if (killTimer === timerHandle) { clearTimeout(timerHandle); killTimer = null; }
                resolve();
            };
            proc.once('exit', done);
            proc.once('error', done);
        });
    } else {
        stopExitPromise = Promise.resolve();
    }
    resetState();
    log('[local-server] Stopped');
    if (wasRunning) {
        void vscode.window.showInformationMessage(
            vscode.l10n.t('Local PlantUML server stopped.')
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
 * @param config - Extension settings (plantumlJarPath, dotPath).
 * @param port - Port number for the picoweb server.
 * @returns Array of CLI arguments.
 */
function buildArgs(config: Config, port: number): string[] {
    const args = ['-Djava.awt.headless=true', '-jar', config.plantumlJarPath, '-picoweb:' + port + ':127.0.0.1'];
    if (config.dotPath && config.dotPath !== 'dot') {
        args.splice(3, 0, '-graphvizdot', config.dotPath);
    }
    return args;
}

/**
 * Poll the server until it responds with HTTP 200, or timeout.
 * Uses a minimal PlantUML diagram encoded as a URL path segment.
 *
 * @param port - Port number to health-check.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 */
async function waitForReady(port: number, timeoutMs = 15_000, intervalMs = 500): Promise<void> {
    // Minimal encoded PlantUML: @startuml\nBob->Alice:hi\n@enduml
    const testUrl = `http://127.0.0.1:${port}/svg/SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IW80`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && serverState === 'starting') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(testUrl, { signal: controller.signal });
            // Consume the response body to release the HTTP connection back to the pool.
            await res.text();
            if (res.ok) return;
        } catch {
            // Server not ready yet
        } finally {
            clearTimeout(timer);
        }
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
    setServerState('stopped');
    serverUrl = null;
    // Reject any pending waiters. When called from stopLocalServer(), readyReject
    // is already null (cleared at line 210) so rejectFn is a no-op. However, if
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
 * Handle unexpected server crash: notify user with action buttons.
 *
 * @param reason - Human-readable crash reason (e.g. exit code or signal).
 * @param config - Current extension settings for potential restart.
 * @param [stderr] - Accumulated stderr output for Java version error detection.
 */
function handleCrash(reason: string, config: Config, stderr?: string): void {
    if (serverState === 'error') return;
    serverProcess = null;
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

    const switchLabel = vscode.l10n.t('Switch to Secure Mode');
    const restartLabel = vscode.l10n.t('Restart Server');
    const dismissLabel = vscode.l10n.t('Dismiss');

    void vscode.window.showErrorMessage(
        vscode.l10n.t('Local PlantUML server crashed: {0}', reason),
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
