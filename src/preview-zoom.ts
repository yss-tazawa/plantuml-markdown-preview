/**
 * @module preview-zoom
 * @description The one zoom level shared by the Markdown preview and every Markdown
 * Reading View.
 *
 * Key behaviors:
 * - Holds the level; the setting `previewZoom` stores it
 * - Sends `{ type: 'setZoom', zoom }` to the tracked webviews when the level changes
 *   (never back to the webview that reported the change with `zoomChanged`)
 * - Writes a level changed by the wheel to the setting after a pause, so turning the
 *   wheel does not write settings.json on every step
 * - Shows the level in the status bar while a tracked panel is visible
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config.js';
import { PREVIEW_ZOOM_LEVELS, DEFAULT_PREVIEW_ZOOM, snapPreviewZoom } from './preview-zoom-levels.js';
import { showQuickPickAtCurrent } from './utils.js';

/** Command ID of the zoom QuickPick (status bar item and Command Palette). */
export const SELECT_PREVIEW_ZOOM_COMMAND = 'plantuml-markdown-preview.selectPreviewZoom';

/** Pause (ms) after the last wheel step before the level is written to the setting. */
const WRITE_DELAY_MS = 500;

/** The current level (%). */
let level = DEFAULT_PREVIEW_ZOOM;
/** Panels of the preview and the Markdown Reading Views that draw a file. */
const panels = new Set<vscode.WebviewPanel>();
/** Status bar item showing the level; null before {@link initPreviewZoom}. */
let statusItem: vscode.StatusBarItem | null = null;
/** Timer of the pending write of a wheel change. */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** Levels written to the setting whose change events have not come back yet, oldest first. */
const writesInFlight: number[] = [];
/** The writes to the setting, one after another; settles when the last one ends. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Create the status bar item and register the zoom command.
 *
 * @param context - Extension context; receives the disposables.
 * @param initialZoom - Level read from the setting at activation.
 */
export function initPreviewZoom(context: vscode.ExtensionContext, initialZoom: number): void {
    level = snapPreviewZoom(initialZoom);
    // Its own id: items of one extension without ids share one, and hiding one hides the others.
    statusItem = vscode.window.createStatusBarItem('previewZoom', vscode.StatusBarAlignment.Right, 100);
    statusItem.command = SELECT_PREVIEW_ZOOM_COMMAND;
    statusItem.name = vscode.l10n.t('Preview Zoom');
    context.subscriptions.push(
        statusItem,
        vscode.commands.registerCommand(SELECT_PREVIEW_ZOOM_COMMAND, (zoom?: unknown) => showPreviewZoomQuickPick(zoom)),
        { dispose: disposePreviewZoom },
    );
    refreshStatus();
}

/** Drop the state and the pending write (deactivation). */
function disposePreviewZoom(): void {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    panels.clear();
    statusItem = null;
    writesInFlight.length = 0;
    writeChain = Promise.resolve();
}

/**
 * The level a page built now starts with.
 *
 * @returns Level in percent.
 */
export function getPreviewZoom(): number {
    return level;
}

/**
 * Track the panel of the preview or of a Markdown Reading View: it receives level
 * changes, and while it is visible the status bar shows the level.
 *
 * @param panel - The panel.
 * @returns Disposable that stops tracking it (when the view stops drawing into it).
 */
export function trackZoomPanel(panel: vscode.WebviewPanel): vscode.Disposable {
    panels.add(panel);
    const viewState = panel.onDidChangeViewState(() => refreshStatus());
    const disposed = panel.onDidDispose(() => untrack());
    function untrack(): void {
        viewState.dispose();
        disposed.dispose();
        panels.delete(panel);
        refreshStatus();
    }
    refreshStatus();
    return { dispose: untrack };
}

/**
 * Take a level a webview already applied after a wheel zoom: pass it to the other
 * webviews and the status bar at once, and write it to the setting after a pause.
 *
 * @param sender - Panel of the webview that reported it.
 * @param zoom - The level it applied.
 */
export function handleZoomChanged(sender: vscode.WebviewPanel, zoom: unknown): void {
    if (typeof zoom !== 'number') return;
    const next = snapPreviewZoom(zoom);
    if (next !== level) {
        level = next;
        broadcast(sender);
        refreshStatus();
    }
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        writeTimer = null;
        void writeSetting(level);
    }, WRITE_DELAY_MS);
}

/**
 * Take the setting's level after a settings change. The change event of a level this
 * module wrote itself is skipped: the webviews already have that level, and a later
 * wheel step may have moved past it.
 *
 * @param zoom - The setting's level, snapped ({@link snapPreviewZoom}).
 */
export function applyPreviewZoomSetting(zoom: number): void {
    const echo = writesInFlight.indexOf(zoom);
    if (echo >= 0) {
        writesInFlight.splice(0, echo + 1);
        return;
    }
    // A pending wheel write would put back the level the user just replaced.
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    setLevel(zoom);
}

/**
 * Set the level from the command or the setting and pass it to every tracked webview.
 *
 * @param zoom - New level in percent.
 */
function setLevel(zoom: number): void {
    const next = snapPreviewZoom(zoom);
    if (next === level) return;
    level = next;
    broadcast(null);
    refreshStatus();
}

/**
 * Send the level to the tracked webviews.
 *
 * @param except - Panel whose webview already applied it, or null to send to all.
 */
function broadcast(except: vscode.WebviewPanel | null): void {
    for (const panel of panels) {
        if (panel === except) continue;
        void panel.webview.postMessage({ type: 'setZoom', zoom: level });
    }
}

/**
 * Send the level to one webview, e.g. one VS Code recreated from HTML built with an
 * older level. The webview ignores a level it already has.
 *
 * @param panel - The panel.
 */
export function postPreviewZoom(panel: vscode.WebviewPanel): void {
    void panel.webview.postMessage({ type: 'setZoom', zoom: level });
}

/**
 * Write a level to the setting after the writes before it, so it is compared with the
 * value they left (a quick change back to the old level during a slow write is written).
 *
 * @param zoom - Level to write.
 * @returns Settles when this write ends.
 */
function writeSetting(zoom: number): Promise<void> {
    writeChain = writeChain.then(() => writeSettingNow(zoom));
    return writeChain;
}

/**
 * Write a level to the setting, in the scope that currently decides it (a workspace
 * value would hide a user value written underneath it).
 *
 * @param zoom - Level to write.
 */
async function writeSettingNow(zoom: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    // No change event comes back for a write of the value already in effect.
    if (snapPreviewZoom(cfg.get<number>('previewZoom', DEFAULT_PREVIEW_ZOOM)) === zoom) return;
    const inspect = cfg.inspect<number>('previewZoom');
    const target = inspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    writesInFlight.push(zoom);
    try {
        await cfg.update('previewZoom', zoom, target);
    } catch (err) {
        const at = writesInFlight.lastIndexOf(zoom);
        if (at >= 0) writesInFlight.splice(at, 1);
        void vscode.window.showErrorMessage(vscode.l10n.t('[PlantUML Markdown Preview] {0}', (err as Error).message));
    }
}

/** Whether the status bar item is shown now. */
function statusShown(): boolean {
    return [...panels].some(panel => panel.visible);
}

/** Show or hide the status bar item and update its text. */
function refreshStatus(): void {
    if (!statusItem) return;
    statusItem.text = `$(zoom-in) ${level}%`;
    statusItem.tooltip = vscode.l10n.t('Select preview zoom');
    if (statusShown()) statusItem.show();
    else statusItem.hide();
}

/**
 * The level and the status bar item's state (observation point for integration tests).
 *
 * @returns Level, whether the item is shown, and its text.
 */
export function getPreviewZoomStatus(): { zoom: number; shown: boolean; text: string } {
    return { zoom: level, shown: !!statusItem && statusShown(), text: statusItem?.text ?? '' };
}

/**
 * Change the level from the command: apply it at once and write it to the setting.
 *
 * @param zoom - New level in percent (snapped to a level).
 */
async function selectLevel(zoom: number): Promise<void> {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    setLevel(zoom);
    await writeSetting(level);
}

/**
 * Show the zoom levels in a QuickPick, starting on the current one, and apply the
 * chosen one. Given a number, apply it without asking: the `args` of a keybinding the
 * user binds to the command, or an integration test.
 *
 * @param zoom - Level to apply without the QuickPick.
 */
async function showPreviewZoomQuickPick(zoom?: unknown): Promise<void> {
    if (typeof zoom === 'number') {
        await selectLevel(zoom);
        return;
    }
    type ZoomItem = vscode.QuickPickItem & { zoom: number };
    const items: ZoomItem[] = PREVIEW_ZOOM_LEVELS.map(z => ({
        label: z === level ? `$(check) ${z}%` : `      ${z}%`,
        description: z === level ? vscode.l10n.t('(current)') : '',
        zoom: z,
    }));
    const picked = await showQuickPickAtCurrent(items, vscode.l10n.t('Select preview zoom'), item => item.zoom === level);
    if (picked) await selectLevel(picked.zoom);
}
