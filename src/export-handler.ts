/**
 * @module export-handler
 * @description Shared handler for diagram export messages from viewer webviews.
 */
import * as vscode from 'vscode';
import { writeFile } from 'fs/promises';

/**
 * Handle an export message from a viewer webview (PNG/SVG save-to-file).
 *
 * Validates the message, shows a save dialog, and writes the file.
 * Used by both puml-preview and mermaid-preview.
 *
 * @param msg - Message object from the webview.
 * @param defaultFilePath - Current file path for default save name, or null.
 */
export async function handleExportMessage(
    msg: { type: string; format?: string; data?: string },
    defaultFilePath: string | null
): Promise<void> {
    if (msg.type !== 'exportDiagramResult' || !msg.format || !msg.data) return;
    if (msg.format !== 'png' && msg.format !== 'svg') return;

    const format = msg.format;
    const filters: Record<string, string[]> = format === 'png'
        ? { 'PNG Image': ['png'] }
        : { 'SVG Image': ['svg'] };

    const defaultName = defaultFilePath
        ? defaultFilePath.replace(/\.[^.]+$/, `.${format}`)
        : `diagram.${format}`;

    const uri = await vscode.window.showSaveDialog({
        filters,
        defaultUri: vscode.Uri.file(defaultName),
    });
    if (!uri) return;

    const fileData = format === 'png'
        ? Buffer.from(msg.data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : msg.data;

    try {
        await writeFile(uri.fsPath, fileData, typeof fileData === 'string' ? 'utf-8' : undefined);
        vscode.window.showInformationMessage(vscode.l10n.t('Diagram saved: {0}', uri.fsPath));
    } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to save diagram: {0}', (err as Error).message));
    }
}
