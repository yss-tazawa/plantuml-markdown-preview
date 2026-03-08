/**
 * @module browser-finder
 * @description Detect a Chromium-based browser for headless PDF export.
 *
 * Detection order: Chrome → Edge → Chromium.
 * Returns the absolute path of the first browser found, or null.
 */
import fs from 'fs';
import { execFile } from 'child_process';

/** Well-known browser paths per platform. */
const CANDIDATES: Record<string, string[]> = {
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
};

/** Command names to search on PATH (Linux / fallback). */
const LINUX_COMMANDS = [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'microsoft-edge-stable',
    'chromium-browser',
    'chromium',
];

/**
 * Resolve a command name to its absolute path via `which` (or `where` on Windows).
 *
 * @param cmd - Command name to search for on PATH.
 * @returns Absolute path to the command, or null when not found.
 */
function which(cmd: string): Promise<string | null> {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    return new Promise(resolve => {
        execFile(bin, [cmd], { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout.trim()) return resolve(null);
            resolve(stdout.trim().split(/\r?\n/)[0]);
        });
    });
}

let cachedBrowser: string | null | undefined;

/**
 * Clear the cached browser path.
 *
 * Called from deactivate() so a browser install/uninstall is picked up
 * on the next activation without reloading VS Code.
 */
export function clearBrowserCache(): void {
    cachedBrowser = undefined;
}

/**
 * Find a Chromium-based browser on the current system.
 *
 * @returns Absolute path to the browser executable, or null if none found.
 */
export async function findBrowser(): Promise<string | null> {
    if (cachedBrowser !== undefined) return cachedBrowser;

    const platform = process.platform;

    // macOS / Windows: check well-known paths
    const paths = CANDIDATES[platform];
    if (paths) {
        for (const p of paths) {
            if (fs.existsSync(p)) { cachedBrowser = p; return p; }
        }
    }

    // Linux (or fallback for any platform): search PATH
    for (const cmd of LINUX_COMMANDS) {
        const resolved = await which(cmd);
        if (resolved) { cachedBrowser = resolved; return resolved; }
    }

    cachedBrowser = null;
    return null;
}
