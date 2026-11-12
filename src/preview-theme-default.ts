/**
 * @module preview-theme-default
 * @description Records github-light as the preview theme for users who never chose one.
 *
 * VS Code only stores settings a user has changed; everyone else follows the
 * default in package.json. Writing `github-light` for users who never chose a theme
 * keeps their preview the same when the package.json default changes.
 *
 * The step runs at most once per installation: a marker in the extension's global
 * state records that it ran, so a user who later deletes the setting gets the
 * package.json default instead of having the value written back.
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config.js';

/** Setting key (within {@link CONFIG_SECTION}) that selects the preview theme. */
const THEME_KEY = 'previewTheme';

/** Theme written for users who have not chosen one: the current package.json default. */
export const RECORDED_PREVIEW_THEME = 'github-light';

/** Global-state key set once the recording step has run. */
export const PREVIEW_THEME_RECORDED_KEY = 'previewThemeRecorded';

/** Scope values of an inspected setting that only exist when someone set them. */
type InspectedTheme = {
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
};

/** True when the user, workspace or folder scope holds a value. */
function hasExplicitValue(inspected: InspectedTheme | undefined): boolean {
    if (!inspected) return false;
    return [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue]
        .some(v => v !== undefined);
}

/** Message text of an unknown thrown value. */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Write {@link RECORDED_PREVIEW_THEME} to the user (Global) settings when no scope
 * sets the preview theme, unless this already ran for this installation.
 * Folder-level values are inspected per workspace folder, since an unscoped
 * inspect does not report them. The marker is set only when a value was already
 * set or the write succeeded; after a failure it stays unset so the next activation
 * tries again. Never throws: failures are logged.
 *
 * @param state - Extension global state that holds the run-once marker.
 * @param log - Receives a line describing a failure.
 * @returns True when the setting was written.
 */
export async function recordPreviewThemeIfUnset(
    state: vscode.Memento,
    log: (line: string) => void,
): Promise<boolean> {
    if (state.get<boolean>(PREVIEW_THEME_RECORDED_KEY)) return false;
    let written = false;
    try {
        const inspections: (InspectedTheme | undefined)[] = [
            vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(THEME_KEY),
            ...(vscode.workspace.workspaceFolders ?? []).map(folder =>
                vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri).inspect(THEME_KEY)),
        ];
        if (!inspections.some(hasExplicitValue)) {
            await vscode.workspace.getConfiguration(CONFIG_SECTION)
                .update(THEME_KEY, RECORDED_PREVIEW_THEME, vscode.ConfigurationTarget.Global);
            written = true;
        }
    } catch (err) {
        log(`[settings] could not record the preview theme: ${errorText(err)}`);
        return false;
    }
    try {
        await state.update(PREVIEW_THEME_RECORDED_KEY, true);
    } catch (err) {
        log(`[settings] could not store the preview theme marker: ${errorText(err)}`);
    }
    return written;
}
