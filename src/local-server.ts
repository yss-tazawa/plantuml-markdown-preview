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
import type { Config } from './config.js';
import { CONFIG_SECTION } from './config.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let serverUrl: string | null = null;

type LocalServerState = 'stopped' | 'starting' | 'running' | 'error';
let serverState: LocalServerState = 'stopped';

/** Resolved when the server becomes ready (or rejected on failure). */
let readyPromise: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((err: Error) => void) | null = null;

/** Output channel for logging (shared with the extension). */
let outputChannel: vscode.OutputChannel | null = null;

/** Flag to distinguish intentional stop from unexpected crash. */
let stoppingIntentionally = false;

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

    serverState = 'starting';
    if (!readyPromise) {
        readyPromise = new Promise<void>((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });
    }

    try {
        const port = await findFreePort(config.plantumlLocalServerPort);
        serverPort = port;

        const args = buildArgs(config, port);
        log(`[local-server] Starting: java ${args.join(' ')}`);

        const child = spawnJava(config.javaPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProcess = child;
        stoppingIntentionally = false;

        child.stdout?.on('data', (chunk: Buffer) => log(`[local-server stdout] ${chunk.toString().trimEnd()}`));
        child.stderr?.on('data', (chunk: Buffer) => log(`[local-server stderr] ${chunk.toString().trimEnd()}`));

        child.on('error', (err) => {
            log(`[local-server] Process error: ${err.message}`);
            handleCrash(err.message, config);
        });

        child.on('exit', (code, signal) => {
            if (stoppingIntentionally) return;
            const reason = signal ? `signal ${signal}` : `exit code ${code}`;
            log(`[local-server] Process exited unexpectedly: ${reason}`);
            handleCrash(reason, config);
        });

        await waitForReady(port);
        if (stoppingIntentionally) return;

        serverUrl = `http://127.0.0.1:${port}`;
        serverState = 'running';
        readyResolve?.();
        log(`[local-server] Ready on port ${port}`);

        void vscode.window.showInformationMessage(
            vscode.l10n.t('Local PlantUML server started.')
        );
    } catch (err) {
        serverState = 'error';
        readyReject?.(err as Error);
        log(`[local-server] Failed to start: ${(err as Error).message}`);
    }
}

/**
 * Stop the local server. Safe to call even if not running.
 */
export function stopLocalServer(): void {
    stoppingIntentionally = true;
    const wasRunning = serverProcess !== null;
    if (serverProcess) {
        serverProcess.kill('SIGTERM');
        serverProcess = null;
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
 */
export async function waitForLocalServer(): Promise<void> {
    if (serverState === 'running') return;
    if (serverState === 'error') return;
    if (!readyPromise) return;

    try {
        await Promise.race([
            readyPromise,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('Local server start timeout')), 15_000)
            ),
        ]);
    } catch {
        // Timeout or start failure — caller will see getLocalServerUrl() === null
    }
}

/**
 * Restart the server with new configuration.
 *
 * @param config - New extension settings to apply.
 */
export async function restartLocalServer(config: Config): Promise<void> {
    stopLocalServer();
    await startLocalServer(config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find a free port. If preferredPort > 0, use it directly; otherwise let the OS assign.
 *
 * @param preferredPort - Port number to use; 0 means auto-assign.
 * @returns Resolved port number.
 */
async function findFreePort(preferredPort: number): Promise<number> {
    if (preferredPort > 0) return preferredPort;
    return new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address() as net.AddressInfo;
            const port = addr.port;
            srv.close(() => resolve(port));
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
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(testUrl, { signal: controller.signal });
            clearTimeout(timer);
            if (res.ok) return;
        } catch {
            // Server not ready yet
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

/** Reset all module-level state to initial values. */
function resetState(): void {
    serverState = 'stopped';
    serverPort = 0;
    serverUrl = null;
    readyPromise = null;
    readyResolve = null;
    readyReject = null;
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
 */
function handleCrash(reason: string, config: Config): void {
    if (serverState === 'error') return;
    serverProcess = null;
    serverState = 'error';
    serverUrl = null;
    readyReject?.(new Error(reason));

    const switchLabel = vscode.l10n.t('Switch to Secure Mode');
    const restartLabel = vscode.l10n.t('Restart Server');
    const dismissLabel = vscode.l10n.t('Dismiss');

    void vscode.window.showErrorMessage(
        vscode.l10n.t('Local PlantUML server crashed: {0}', reason),
        switchLabel, restartLabel, dismissLabel
    ).then(async (action) => {
        if (action === switchLabel) {
            const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
            await cfg.update('mode', 'secure', vscode.ConfigurationTarget.Global);
        } else if (action === restartLabel) {
            await startLocalServer(config);
        }
    });
}
