/**
 * @module export-handler
 * @description Shared handler for diagram export messages from viewer webviews.
 */
import * as vscode from 'vscode';
import { writeFile } from 'fs/promises';
import { handleCopyResult } from './diagram-viewer.js';

/** HTML entity name -> Unicode code point map for XML-invalid entities. */
const HTML_ENTITY_MAP: Record<string, number> = { nbsp: 160, copy: 169, reg: 174, trade: 8482, mdash: 8212, ndash: 8211, laquo: 171, raquo: 187, bull: 8226, hellip: 8230, prime: 8242, Prime: 8243, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, euro: 8364, pound: 163, yen: 165, cent: 162, times: 215, divide: 247, minus: 8722, plusmn: 177, deg: 176, micro: 181, para: 182, middot: 183, frac12: 189, frac14: 188, frac34: 190 };

/**
 * Replace HTML named entities (e.g. &nbsp;) with numeric character references
 * so the SVG is valid standalone XML.
 */
export function sanitizeSvgEntities(svg: string): string {
    return svg
        // Strip comments that may contain "--" (invalid in XML comments)
        .replace(/<!--[\s\S]*?-->/g, '')
        // Replace HTML named entities with numeric character references
        .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => {
            if (name === 'amp' || name === 'lt' || name === 'gt' || name === 'quot' || name === 'apos') return match;
            const code = HTML_ENTITY_MAP[name];
            return code ? `&#${code};` : match;
        });
}

/**
 * Show a save dialog and write diagram data to the chosen file.
 *
 * @param data - Binary buffer (PNG) or string (SVG) to save.
 * @param defaultUri - Default file URI for the save dialog.
 * @param format - Output format ('png' or 'svg').
 */
export async function saveDiagramFile(
    data: Buffer | string,
    defaultUri: vscode.Uri,
    format: 'png' | 'svg'
): Promise<void> {
    const filters: Record<string, string[]> = format === 'png'
        ? { 'PNG Image': ['png'] }
        : { 'SVG Image': ['svg'] };
    const uri = await vscode.window.showSaveDialog({ filters, defaultUri });
    if (!uri) return;
    try {
        await writeFile(uri.fsPath, data, typeof data === 'string' ? 'utf-8' : undefined);
        vscode.window.showInformationMessage(vscode.l10n.t('Diagram saved: {0}', uri.fsPath));
    } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to save diagram: {0}', err instanceof Error ? err.message : String(err)));
    }
}

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
    const fileData = format === 'png'
        ? Buffer.from(msg.data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : sanitizeSvgEntities(msg.data);

    const defaultName = defaultFilePath
        ? defaultFilePath.replace(/\.[^.]+$/, `.${format}`)
        : `diagram.${format}`;

    await saveDiagramFile(fileData, vscode.Uri.file(defaultName), format);
}

/**
 * Handle messages from a viewer webview (PNG/SVG export + clipboard copy).
 *
 * @param msg - Message payload from the webview.
 * @param currentFilePath - Current file path for default save name, or null.
 */
export async function handleViewerMessage(
    msg: { type: string; format?: string; data?: string; success?: boolean },
    currentFilePath: string | null
): Promise<void> {
    if (msg.type === 'copyDiagramResult') {
        handleCopyResult(!!msg.success);
        return;
    }
    return handleExportMessage(msg, currentFilePath);
}
