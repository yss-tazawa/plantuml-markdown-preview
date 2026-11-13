/**
 * @module markdown-files
 * @description Which files the Markdown preview opens, and the names derived from them.
 *
 * Key behaviors:
 * - Matches the built-in Markdown preview's range: the Markdown-family languages for an open document, the `markdown` language's file extensions otherwise
 * - Derives display names and export output paths for any of those extensions
 * - Refuses an export output path that is the source file itself
 */
import path from 'path';

/** Language IDs the built-in Markdown preview treats as Markdown. */
export const MARKDOWN_LANGUAGE_IDS: readonly string[] = [
    'markdown', 'prompt', 'instructions', 'chatagent', 'skill',
];

/** File extensions of the built-in `markdown` language (lowercase, with the dot). */
export const MARKDOWN_EXTENSIONS: readonly string[] = [
    '.md', '.mkd', '.mkdn', '.mdwn', '.mdown', '.markdown', '.markdn',
    '.mdtxt', '.mdtext', '.litcoffee', '.ron', '.ronn', '.workbook',
];

/**
 * Check whether the Markdown preview opens a file.
 *
 * An open document decides by its language alone, so `files.associations` applies
 * as in the built-in preview. A file with no open document decides by its extension
 * alone (case-insensitive). The two are never combined: an extension another language
 * claims (`.ron`) must not widen the range past the built-in one.
 * The URI scheme is not consulted.
 *
 * @param filePath - Path to the file. A path-less untitled document's name is not absolute and never matches.
 * @param [document] - The open document for the path, if any.
 * @returns True when the preview opens the file.
 */
export function isMarkdownFile(filePath: string, document?: { languageId: string }): boolean {
    if (!path.isAbsolute(filePath)) return false;
    if (document) return MARKDOWN_LANGUAGE_IDS.includes(document.languageId);
    return MARKDOWN_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Check whether a URI names a file on disk, as opposed to an untitled buffer or
 * a revision (`git:`, `vscode-local-history:`, ...).
 *
 * @param uri - URI to test.
 * @returns True for the `file` scheme.
 */
export function isFileUri(uri: { scheme: string }): boolean {
    return uri.scheme === 'file';
}

/**
 * Get a file's name without its extension, whatever the extension is.
 *
 * @param filePath - Path to the file.
 * @returns The base name minus its last extension (`notes.markdown` -> `notes`).
 */
export function fileNameWithoutExtension(filePath: string): string {
    return path.parse(filePath).name;
}

/**
 * Build an export output path: the source path with its extension replaced.
 *
 * @param sourcePath - Absolute path to the source file.
 * @param extension - Output extension with the dot (`.html`, `.pdf`).
 * @param [platform] - Platform whose path rules apply. Windows and macOS compare paths case-insensitively.
 * @returns The output path, or null when it is the source file itself (e.g. `a.html` associated with Markdown).
 */
export function exportOutputPath(sourcePath: string, extension: string, platform: NodeJS.Platform = process.platform): string | null {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const parsed = p.parse(sourcePath);
    const outputPath = p.join(parsed.dir, parsed.name + extension);
    const caseInsensitive = platform === 'win32' || platform === 'darwin';
    const normalize = (x: string) => caseInsensitive ? p.resolve(x).toLowerCase() : p.resolve(x);
    return normalize(outputPath) === normalize(sourcePath) ? null : outputPath;
}
