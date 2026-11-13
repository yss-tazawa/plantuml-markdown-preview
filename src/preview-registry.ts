/**
 * @module preview-registry
 * @description The open Reading Views (custom editor tabs).
 *
 * Key behaviors:
 * - Holds every Reading View, including the notice shown for a document that is not a file
 * - Allows several Reading Views of the same file (VS Code can split a custom editor)
 * - Never holds the preview: commands reach it through its own module
 */
import type * as vscode from 'vscode';
import type { MarkdownReadingView, ReadingView, ReadingViewKind } from './reading-view.js';

/** One Reading View tab, whether it draws its file or shows the notice. */
export type ReadingViewEntry =
    | { readonly rendered: true; readonly kind: ReadingViewKind; readonly panel: vscode.WebviewPanel; readonly view: ReadingView }
    | { readonly rendered: false; readonly kind: ReadingViewKind; readonly panel: vscode.WebviewPanel };

/** Every open Reading View. */
const entries = new Set<ReadingViewEntry>();

/**
 * Add a Reading View when its tab opens.
 *
 * @param entry - The tab and what it shows.
 */
export function addReadingView(entry: ReadingViewEntry): void {
    entries.add(entry);
}

/**
 * Remove a Reading View when its tab closes (including a switch to the source).
 *
 * @param entry - The entry {@link addReadingView} received.
 */
export function removeReadingView(entry: ReadingViewEntry): void {
    entries.delete(entry);
}

/**
 * The Reading View whose panel is active, drawing or not.
 *
 * @returns The entry, or undefined when no Reading View is active.
 */
export function getActiveReadingView(): ReadingViewEntry | undefined {
    for (const entry of entries) {
        if (entry.panel.active) return entry;
    }
    return undefined;
}

/**
 * Every open Reading View, in the order they opened.
 *
 * @returns A copy of the entries.
 */
export function allReadingViews(): ReadingViewEntry[] {
    return [...entries];
}

/**
 * Whether a command lands on a Reading View showing the notice (a document that is not
 * a file): it was given no URI and that Reading View is active. The command then does
 * nothing, without an error.
 *
 * @param uriPath - Path of the URI the command was given, if any.
 * @param active - The active Reading View ({@link getActiveReadingView}).
 * @returns True when the command lands on the notice.
 */
export function landsOnNotice(uriPath: string | undefined, active: ReadingViewEntry | undefined): boolean {
    return !uriPath && active?.rendered === false;
}

/**
 * The Markdown Reading View a bulk export of a file takes the diagrams from: the one in
 * front when it draws that file.
 *
 * @param active - The active Reading View ({@link getActiveReadingView}).
 * @param filePath - Path of the file the export acts on.
 * @returns The view, or null when the diagrams come from the preview.
 */
export function markdownViewShowing(active: ReadingViewEntry | undefined, filePath: string): MarkdownReadingView | null {
    return active?.rendered && active.view.kind === 'markdown' && active.view.filePath() === filePath ? active.view : null;
}

/**
 * Pick the file a command of one file kind acts on.
 *
 * Order: the command's URI, then the active Reading View when it is of `kind`, then
 * the active text editor, then the file the preview shows. A Reading View showing the
 * notice yields no file, so the command does not fall through to the preview's file.
 *
 * @param kind - Kind of file the command handles.
 * @param uriPath - Path of the URI the command was given, if any.
 * @param active - The active Reading View ({@link getActiveReadingView}).
 * @param editorPath - Path of the active text editor's document, if any.
 * @param previewPath - Path of the file the preview of `kind` shows, if any.
 * @returns The path, or null when there is none.
 */
export function pickTargetPath(
    kind: ReadingViewKind,
    uriPath: string | undefined,
    active: ReadingViewEntry | undefined,
    editorPath: string | undefined,
    previewPath: string | null,
): string | null {
    if (uriPath) return uriPath;
    if (landsOnNotice(uriPath, active)) return null;
    if (active?.rendered && active.kind === kind) return active.view.filePath();
    return editorPath || previewPath || null;
}
