/**
 * @module reading-view-position
 * @description Carries the position between a Markdown file's source and its Reading View
 * when a tab switches between them, as the built-in Markdown preview does.
 *
 * Key behaviors:
 * - Remembers the visible range of each Markdown source editor, and of the one a tab switches
 *   from just before it switches; a Reading View created for the file starts there, and the
 *   range is then forgotten, as it is when the document closes or the switch fails. Until
 *   VS Code closes the document, which may be well after its tab closes, the range stays,
 *   as the built-in preview keeps the line of a closed source
 * - Shows the source at the line a Reading View scrolled to when the tab switches back
 */
import * as vscode from 'vscode';
import { isMarkdownFile } from './markdown-files.js';
import { isLiveSourceUri } from './utils.js';

/** Visible range of a source editor, in the terms the preview computes its scroll from. */
export interface SourcePosition {
    /** First visible line. */
    topLine: number;
    /** Last visible line. */
    bottomLine: number;
    /** Line count of the document. */
    lineCount: number;
}

/** Last visible range of each Markdown source editor, by file path. */
const sourcePositions = new Map<string, SourcePosition>();

/** Visible range of the source editor a tab switched from, by file path. It wins over
 *  {@link sourcePositions}, which another editor of the file may update while the tab switches. */
const switchedPositions = new Map<string, SourcePosition>();

/**
 * Take the position a Reading View of a file starts at, and forget it.
 *
 * @param filePath - Absolute path of the file.
 * @returns The last visible range of a source editor of the file, or undefined when none was seen.
 */
export function takeSourcePosition(filePath: string): SourcePosition | undefined {
    const position = switchedPositions.get(filePath) ?? sourcePositions.get(filePath);
    switchedPositions.delete(filePath);
    sourcePositions.delete(filePath);
    return position;
}

/**
 * Store the visible range of a Markdown source editor.
 *
 * @param positions - Where to store it.
 * @param editor - The editor; one that does not show a live Markdown document is ignored.
 */
function storePosition(positions: Map<string, SourcePosition>, editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.visibleRanges.length === 0) return;
    const document = editor.document;
    if (!isLiveSourceUri(document.uri) || !isMarkdownFile(document.uri.fsPath, document)) return;
    positions.set(document.uri.fsPath, {
        topLine: editor.visibleRanges[0].start.line,
        bottomLine: editor.visibleRanges[0].end.line,
        lineCount: document.lineCount,
    });
}

/**
 * Switch the active source tab to a Reading View in place, starting it where the source
 * shows: the position is remembered over any other editor of the same file, and forgotten
 * when the switch fails.
 *
 * @param viewType - View type of the Reading View.
 */
export async function switchSourceToReadingView(viewType: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    storePosition(switchedPositions, editor);
    try {
        await vscode.commands.executeCommand('reopenActiveEditorWith', viewType);
    } catch (err) {
        if (editor) switchedPositions.delete(editor.document.uri.fsPath);
        throw err;
    }
}

/**
 * Start remembering the visible range of each Markdown source editor, from the editors
 * already shown (a window restored before the extension started) on, and forgetting it
 * when its document closes. A switch to the Reading View keeps the document open.
 *
 * @returns The listeners; disposing them stops both.
 */
export function trackSourcePositions(): vscode.Disposable {
    for (const editor of vscode.window.visibleTextEditors) storePosition(sourcePositions, editor);
    return vscode.Disposable.from(
        vscode.window.onDidChangeTextEditorVisibleRanges(event => storePosition(sourcePositions, event.textEditor)),
        vscode.workspace.onDidCloseTextDocument(document => {
            // A revision (`git:` and the like) shares the path of the live document.
            if (!isLiveSourceUri(document.uri)) return;
            sourcePositions.delete(document.uri.fsPath);
            switchedPositions.delete(document.uri.fsPath);
        }),
    );
}

/**
 * Show the line a Reading View scrolled to in the source editor that took its tab.
 *
 * @param filePath - Absolute path of the file the Reading View showed.
 * @param line - Source line at the middle of the Reading View.
 */
export function revealLineInSource(filePath: string, line: number): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isLiveSourceUri(editor.document.uri) || editor.document.uri.fsPath !== filePath) return;
    // The Reading View reports the line at its middle, as the preview does.
    const target = Math.min(line, editor.document.lineCount - 1);
    editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenter);
}
