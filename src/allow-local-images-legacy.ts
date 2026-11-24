/**
 * @module allow-local-images-legacy
 * @description Replaces leftover boolean `allowLocalImages` values in user and workspace settings.
 *
 * The setting was a boolean before it became the string enum `mode-default` / `on` / `off`.
 * A settings.json written then may still hold `true` or `false`, which the current setting no
 * longer reads. Each is rewritten to the string with the same meaning: `false` to `off` and
 * `true` to `on`.
 *
 * Only the user (Global) and workspace values are touched: the setting has window scope, so in a
 * multi-root workspace VS Code does not apply a folder-level value and refuses to write one. The step looks at the
 * settings on every activation and stops by itself once nothing boolean is left.
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config.js';

/** Setting key (within {@link CONFIG_SECTION}) that allows local images. */
const ALLOW_LOCAL_IMAGES_KEY = 'allowLocalImages';

/** Message text of an unknown thrown value. */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Replace leftover boolean values of `allowLocalImages` in the Global and then the Workspace
 * settings: `false` becomes `'off'` and `true` becomes `'on'`. Values of any other type are left alone.
 * Each write is awaited in turn, and a failed write does not stop the next scope.
 * Never throws: failures are logged.
 *
 * @param log - Receives a line describing a failure.
 * @returns The number of settings that were rewritten.
 */
export async function rewriteLegacyAllowLocalImages(log: (line: string) => void): Promise<number> {
    let rewritten = 0;
    try {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const inspected = config.inspect<unknown>(ALLOW_LOCAL_IMAGES_KEY);
        const scopes: [string, unknown, vscode.ConfigurationTarget][] = [
            ['user', inspected?.globalValue, vscode.ConfigurationTarget.Global],
            ['workspace', inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        ];
        for (const [name, value, target] of scopes) {
            if (typeof value !== 'boolean') continue;
            try {
                await config.update(ALLOW_LOCAL_IMAGES_KEY, value ? 'on' : 'off', target);
                rewritten++;
            } catch (err) {
                log(`[settings] could not rewrite the ${name} allowLocalImages value: ${errorText(err)}`);
            }
        }
    } catch (err) {
        log(`[settings] could not rewrite the legacy allowLocalImages value: ${errorText(err)}`);
    }
    return rewritten;
}
