/**
 * @module pdf-scale-legacy
 * @description Replaces leftover scale factors of `pdfScale` in user and workspace settings.
 *
 * The setting was a scale factor from 0.1 to 2.0 before it became a whole percentage from 10
 * to 200. A settings.json written then may still hold a factor such as `0.625`, which the
 * current setting reads as out of range. Each is rewritten to the percentage with the same
 * meaning, with the fraction dropped: `0.625` to `62` and `1` to `100`.
 *
 * Only the user (Global) and workspace values are touched: the setting has window scope, so in a
 * multi-root workspace VS Code does not apply a folder-level value and refuses to write one. The step looks at the
 * settings on every activation and stops by itself once no factor is left.
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION, isLegacyPdfScale, resolvePdfScale } from './config.js';

/** Setting key (within {@link CONFIG_SECTION}) of the PDF export scale. */
const PDF_SCALE_KEY = 'pdfScale';

/** Message text of an unknown thrown value. */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Replace leftover scale factors of `pdfScale` (numbers below 10) in the Global and then the
 * Workspace settings with the percentage resolvePdfScale reads from them: `0.625` becomes `62`
 * and `1` becomes `100`. Percentages and values of any other type are left alone.
 * Each write is awaited in turn, and a failed write does not stop the next scope.
 * Never throws: failures are logged.
 *
 * @param log - Receives a line describing a failure.
 * @returns The number of settings that were rewritten.
 */
export async function rewriteLegacyPdfScale(log: (line: string) => void): Promise<number> {
    let rewritten = 0;
    try {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const inspected = config.inspect<unknown>(PDF_SCALE_KEY);
        const scopes: [string, unknown, vscode.ConfigurationTarget][] = [
            ['user', inspected?.globalValue, vscode.ConfigurationTarget.Global],
            ['workspace', inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        ];
        for (const [name, value, target] of scopes) {
            if (!isLegacyPdfScale(value)) continue;
            try {
                await config.update(PDF_SCALE_KEY, resolvePdfScale(value), target);
                rewritten++;
            } catch (err) {
                log(`[settings] could not rewrite the ${name} pdfScale value: ${errorText(err)}`);
            }
        }
    } catch (err) {
        log(`[settings] could not rewrite the legacy pdfScale value: ${errorText(err)}`);
    }
    return rewritten;
}
