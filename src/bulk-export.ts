/**
 * @module bulk-export
 * @description Export all diagrams (PlantUML, Mermaid, D2) from a Markdown file
 * as individual SVG or PNG image files into a subdirectory.
 *
 * Delegates rendering to the preview webview (same path as single diagram export),
 * then writes each diagram's data to a file.
 *
 * Output directory: {mdBaseName}_{format}/ (sibling to the .md file).
 * If the directory already exists, all contents are deleted first.
 * File naming: diagram-{index}.{format} (0-based, document order).
 */
import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { sanitizeSvgEntities } from './export-handler.js';

/** Result of a bulk export operation. */
export interface BulkExportResult {
    outputDir: string;
    exported: number;
    failed: number;
}

/** Data for a single diagram returned from the webview. */
export interface DiagramData {
    /** SVG markup (for svg format) or base64 PNG data URL (for png format). */
    data: string;
    /** 0-based index in document order; file names use 1-based numbering. */
    index: number;
}

/**
 * Export all diagrams from the preview webview as individual image files.
 *
 * Sends a message to the webview to collect all diagram data, then writes
 * each diagram to a file in the output directory.
 *
 * @param panel - The preview WebviewPanel whose webview contains the rendered diagrams.
 * @param mdFilePath - Absolute path to the Markdown file (used for output dir naming).
 * @param format - Output format: 'svg' or 'png'.
 * @returns Export result with counts and output directory path.
 */
export async function exportAllDiagrams(
    panel: vscode.WebviewPanel,
    mdFilePath: string,
    format: 'svg' | 'png',
): Promise<BulkExportResult> {
    // Let user choose output directory
    const mdBaseName = path.basename(mdFilePath, '.md');
    const parentDir = path.dirname(mdFilePath);

    // macOS save dialog navigates into existing directories instead of using
    // the name as default. Find a name that doesn't conflict.
    let defaultName = `${mdBaseName}_diagrams`;
    let counter = 2;
    let candidate = path.join(parentDir, defaultName);
    while (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        defaultName = `${mdBaseName}_diagrams_${counter++}`;
        candidate = path.join(parentDir, defaultName);
    }

    const chosen = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(parentDir, defaultName)),
        title: vscode.l10n.t('Select export directory'),
    });
    if (!chosen) throw new Error('Aborted');
    const outputDir = chosen.fsPath;

    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Request all diagram data from the webview
    const diagrams = await new Promise<DiagramData[]>((resolve, reject) => {
        let settled = false;
        const cleanup = () => { settled = true; clearTimeout(timeout); listener.dispose(); disposeWatcher.dispose(); };

        const timeout = setTimeout(() => {
            if (settled) return;
            cleanup();
            reject(new Error('Webview did not respond'));
        }, 60000);

        const listener = panel.webview.onDidReceiveMessage((msg: { type: string; diagrams?: DiagramData[] }) => {
            if (settled || msg.type !== 'exportAllDiagramsResult') return;
            cleanup();
            resolve(msg.diagrams ?? []);
        });

        const disposeWatcher = panel.onDidDispose(() => {
            if (settled) return;
            cleanup();
            reject(new Error('Aborted'));
        });

        void panel.webview.postMessage({ type: 'exportAllDiagrams', format });
    });

    if (diagrams.length === 0) {
        throw new Error(vscode.l10n.t('No diagrams found in this file.'));
    }

    // Write files
    let exported = 0;
    let failed = 0;

    for (const diag of diagrams) {
        const fileName = `diagram-${diag.index + 1}.${format}`;
        const filePath = path.join(outputDir, fileName);

        if (!diag.data) {
            failed++;
            continue;
        }

        if (format === 'svg') {
            await fs.promises.writeFile(filePath, sanitizeSvgEntities(diag.data), 'utf8');
            exported++;
        } else {
            // PNG: data is a base64 data URL
            const base64 = diag.data.replace(/^data:image\/png;base64,/, '');
            await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
            exported++;
        }
    }

    return { outputDir, exported, failed };
}