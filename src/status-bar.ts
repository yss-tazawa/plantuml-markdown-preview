/**
 * @module status-bar
 * @description Manages the status bar item showing the current rendering mode
 * and local server state.
 */
import * as vscode from 'vscode';
import type { Config, Mode } from './config.js';
import { CONFIG_SECTION } from './config.js';
import type { LocalServerState } from './local-server.js';

/** Command ID for the mode quick-pick triggered by clicking the status bar item. */
export const SELECT_MODE_COMMAND = 'plantuml-markdown-preview.selectMode';

/** Icon per mode (Codicon names). */
const MODE_ICON: Record<Mode, string> = {
    fast: 'zap',
    secure: 'lock',
    easy: 'cloud',
};

/** Capitalised label per mode. */
const MODE_LABEL: Record<Mode, string> = {
    fast: 'Fast',
    secure: 'Secure',
    easy: 'Easy',
};

/**
 * Create the status bar item. Caller must push it to context.subscriptions.
 */
export function createStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.command = SELECT_MODE_COMMAND;
    item.show();
    return item;
}

/**
 * Update the status bar item text, tooltip, and icon.
 *
 * @param item - The status bar item to update.
 * @param config - Current extension configuration.
 * @param serverState - Current local server state (only relevant for Fast mode).
 */
export function updateStatusBar(item: vscode.StatusBarItem, config: Config, serverState: LocalServerState): void {
    const mode = config.mode;
    const label = MODE_LABEL[mode];

    let icon: string;
    let tooltip: string;

    if (mode === 'fast') {
        switch (serverState) {
            case 'running':
                icon = `$(${MODE_ICON[mode]})`;
                tooltip = vscode.l10n.t('PlantUML: {0} — Server running', label);
                break;
            case 'starting':
                icon = '$(loading~spin)';
                tooltip = vscode.l10n.t('PlantUML: {0} — Server starting…', label);
                break;
            case 'error':
                icon = '$(warning)';
                tooltip = vscode.l10n.t('PlantUML: {0} — Server error', label);
                break;
            default:
                icon = `$(${MODE_ICON[mode]})`;
                tooltip = vscode.l10n.t('PlantUML: {0} — Server stopped', label);
                break;
        }
    } else {
        icon = `$(${MODE_ICON[mode]})`;
        tooltip = vscode.l10n.t('PlantUML: {0} mode', label);
    }

    item.text = `${icon} PlantUML: ${label}`;
    item.tooltip = tooltip;
}

/**
 * Show a quick-pick to switch the rendering mode.
 */
export async function showModeQuickPick(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
        { label: `$(zap) Fast`, description: vscode.l10n.t('Local server (fastest, requires Java)'), detail: 'fast' },
        { label: `$(lock) Secure`, description: vscode.l10n.t('Local rendering (no network, requires Java)'), detail: 'secure' },
        { label: `$(cloud) Easy`, description: vscode.l10n.t('PlantUML server (no Java required)'), detail: 'easy' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select PlantUML rendering mode'),
    });

    if (picked?.detail) {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await cfg.update('mode', picked.detail, vscode.ConfigurationTarget.Global);
    }
}
