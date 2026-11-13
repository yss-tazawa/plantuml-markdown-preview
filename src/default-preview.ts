/**
 * @module default-preview
 * @description Puts this extension's views behind VS Code's own Markdown preview buttons, menus and keys.
 *
 * Key behaviors:
 * - While `useAsDefaultPreview` is on in a VS Code that can switch a tab in place and whose own
 *   Markdown extension has "Open as Preview", hides the built-in preview entries
 *   (`hasCustomMarkdownPreview`) and shows look-alike entries in their place
 * - The look-alike entries and the standard keys open this extension's Preview or Reading View
 * - A document this extension cannot open goes to the built-in command the entry stands for
 * - Clears only the context keys it set, and keeps the built-in entries hidden for
 *   Markdown Preview Enhanced when that extension is set to hide them
 */
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config.js';
import { isFileUri, isMarkdownFile, MARKDOWN_LANGUAGE_IDS } from './markdown-files.js';
import { canSwitchInPlace, readingViewTypeForFile, READING_VIEW_TYPES } from './preview-editor.js';
import type { ReadingViewKind } from './reading-view.js';

/** Context key that hides the built-in Markdown preview's buttons and menu items. */
const HIDE_BUILTIN_CONTEXT = 'hasCustomMarkdownPreview';

/** Context key that shows this extension's look-alike entries. */
const REPLACING_CONTEXT = 'plantumlMarkdownPreview.replacingBuiltin';

/** Markdown Preview Enhanced, which also sets {@link HIDE_BUILTIN_CONTEXT}. */
const MPE_EXTENSION_ID = 'shd101wyy.markdown-preview-enhanced';

/** Markdown Preview Enhanced's setting that hides the built-in entries. */
const MPE_HIDE_SECTION = 'markdown-preview-enhanced';
const MPE_HIDE_KEY = 'hideDefaultVSCodeMarkdownPreviewButtons';

/** VS Code's own Markdown extension, whose entries the look-alikes stand in for. */
const BUILTIN_MARKDOWN_EXTENSION_ID = 'vscode.markdown-language-features';

/** Built-in command of "Open as Preview", which only a VS Code that can switch a tab in place has. */
const BUILTIN_REOPEN_AS_PREVIEW = 'markdown.reopenAsPreview';

/** Built-in command that opens the preview in the current group: the last resort. */
const BUILTIN_SHOW_PREVIEW = 'markdown.showPreview';

/** This extension's command that opens the Preview of each file kind beside the editor. */
const PREVIEW_COMMANDS: Readonly<Record<ReadingViewKind, string>> = {
    markdown: 'plantuml-markdown-preview.openPreview',
    puml: 'plantuml-markdown-preview.openPumlPreview',
    mermaid: 'plantuml-markdown-preview.openMermaidPreview',
    d2: 'plantuml-markdown-preview.openD2Preview',
};

/** Whether this extension set the context keys (and so may clear them). */
let replacing = false;

/** The last queued update of the context keys; settles without rejecting. */
let queue: Promise<void> = Promise.resolve();

/**
 * Run an update of the context keys after the ones queued before it, so updates never
 * interleave and the last one queued decides the keys.
 *
 * @param update - The update.
 * @returns Settles when the update ends; rejects when it failed.
 */
function enqueue(update: () => Promise<void>): Promise<void> {
    const run = queue.then(update);
    queue = run.catch(() => {});
    return run;
}

/**
 * Hide or show the built-in Markdown preview entries for the setting as it is when
 * this update runs. The entries are replaced only where this VS Code can switch a tab
 * in place and VS Code's own Markdown extension, enabled, has "Open as Preview".
 *
 * @returns Settles when the context keys are written.
 */
export function syncBuiltinReplacement(): Promise<void> {
    return enqueue(async () => {
        const on = await canSwitchInPlace() && builtinHasReopenAsPreview()
            && vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('useAsDefaultPreview', true);
        if (!on) {
            await release();
            return;
        }
        replacing = true;
        // Hide first, so the built-in entry and its look-alike never show side by side.
        await vscode.commands.executeCommand('setContext', HIDE_BUILTIN_CONTEXT, true);
        await vscode.commands.executeCommand('setContext', REPLACING_CONTEXT, true);
    });
}

/**
 * Clear the context keys this extension set, so the built-in entries come back. The
 * built-in entries stay hidden while Markdown Preview Enhanced is set to hide them.
 *
 * @returns Settles once the keys are cleared, after the updates queued before.
 */
export function releaseBuiltinReplacement(): Promise<void> {
    return enqueue(release);
}

/**
 * Clear the context keys this extension set (see {@link releaseBuiltinReplacement}).
 *
 * @returns Settles once the keys are cleared.
 */
async function release(): Promise<void> {
    if (!replacing) return;
    replacing = false;
    await vscode.commands.executeCommand('setContext', REPLACING_CONTEXT, undefined);
    if (mpeHidesBuiltin()) return;
    await vscode.commands.executeCommand('setContext', HIDE_BUILTIN_CONTEXT, undefined);
}

/**
 * Whether this extension has the built-in entries hidden and its look-alikes shown
 * (context keys cannot be read back through the API), once the queued updates end.
 *
 * @returns True while the context keys this extension set are in place.
 */
export async function isReplacingBuiltin(): Promise<boolean> {
    await queue;
    return replacing;
}

/**
 * Whether VS Code's own Markdown extension is enabled and contributes "Open as Preview"
 * (read from its manifest, without waiting for it to activate).
 *
 * @returns True when the built-in entries the look-alikes copy are there.
 */
function builtinHasReopenAsPreview(): boolean {
    const commands: unknown = vscode.extensions.getExtension(BUILTIN_MARKDOWN_EXTENSION_ID)?.packageJSON?.contributes?.commands;
    return Array.isArray(commands) && commands.some(c => (c as { command?: unknown }).command === BUILTIN_REOPEN_AS_PREVIEW);
}

/** Whether Markdown Preview Enhanced is enabled and set to hide the built-in entries. */
function mpeHidesBuiltin(): boolean {
    return vscode.extensions.getExtension(MPE_EXTENSION_ID) !== undefined
        && vscode.workspace.getConfiguration(MPE_HIDE_SECTION).get<boolean>(MPE_HIDE_KEY) === true;
}

/** A document a command acts on: its URI, and the open document when there is one. */
interface Target {
    uri: vscode.Uri;
    document?: vscode.TextDocument;
}

/**
 * The document a command acts on: the URI a menu passed, else the active text editor's.
 *
 * @param arg - First argument the command received.
 * @returns The target, or undefined when there is none.
 */
function targetOf(arg: unknown): Target | undefined {
    if (isUri(arg)) {
        const key = arg.toString();
        return { uri: arg, document: vscode.workspace.textDocuments.find(d => d.uri.toString() === key) };
    }
    const document = vscode.window.activeTextEditor?.document;
    return document ? { uri: document.uri, document } : undefined;
}

/** Whether a command argument is a URI (menus pass the resource first). */
function isUri(arg: unknown): arg is vscode.Uri {
    return typeof arg === 'object' && arg !== null && 'scheme' in arg && 'fsPath' in arg;
}

/**
 * Whether this extension's Markdown Preview opens a target: a file on disk in the
 * Markdown range. Untitled buffers and revisions (`git:`, ...) go to the built-in preview.
 *
 * @param target - The document the command acts on.
 * @returns True when this extension's Preview opens it.
 */
function opensInPreview(target: Target): boolean {
    return isFileUri(target.uri) && isMarkdownFile(target.uri.fsPath, target.document);
}

/**
 * Whether the active tab, in a VS Code that can switch a tab in place, switches to the
 * Reading View of a kind: a file on disk the Reading View's selector takes, open in a
 * text editor rather than a diff.
 *
 * @param target - The document the command acts on.
 * @param kind - Kind of Reading View to switch to.
 * @returns True when the tab switches in place.
 */
function opensInReadingView(target: Target, kind: ReadingViewKind): boolean {
    if (!isFileUri(target.uri)) return false;
    if (readingViewTypeForFile(target.uri.fsPath) !== READING_VIEW_TYPES[kind]) return false;
    if (kind === 'markdown' && !isMarkdownFile(target.uri.fsPath, target.document)) return false;
    return !(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
}

/**
 * Run the built-in command an entry stands for, with the arguments the entry passed.
 * When this VS Code lacks it (or the built-in Markdown extension is disabled), fall
 * back to the built-in preview, then to a notice.
 *
 * @param command - The built-in command.
 * @param args - Arguments the entry passed.
 */
async function runBuiltin(command: string, args: unknown[]): Promise<void> {
    const commands = command === BUILTIN_SHOW_PREVIEW ? [command] : [command, BUILTIN_SHOW_PREVIEW];
    for (const id of commands) {
        try {
            await vscode.commands.executeCommand(id, ...args);
            return;
        } catch {
            // Not available here: try the next one.
        }
    }
    void vscode.window.showInformationMessage(vscode.l10n.t('This document can\'t be previewed.'));
}

/**
 * Open this extension's Markdown Preview of a target beside the editor, or hand the
 * target to a built-in command.
 *
 * @param builtin - Built-in command for a target this extension does not open.
 * @param args - Arguments the entry passed.
 */
async function openPreviewOr(builtin: string, args: unknown[]): Promise<void> {
    const target = targetOf(args[0]);
    if (target && opensInPreview(target)) {
        await vscode.commands.executeCommand(PREVIEW_COMMANDS.markdown, target.uri);
        return;
    }
    await runBuiltin(builtin, args);
}

/**
 * Kind of file a language is, for the files that have a Preview and a Reading View.
 *
 * @param languageId - Language ID of the document.
 * @returns The kind, or undefined for a language without a Preview and a Reading View.
 */
function kindOfLanguage(languageId: string): ReadingViewKind | undefined {
    if (MARKDOWN_LANGUAGE_IDS.includes(languageId)) return 'markdown';
    switch (languageId) {
        case 'plantuml': return 'puml';
        case 'mermaid': return 'mermaid';
        case 'd2': return 'd2';
        default: return undefined;
    }
}

/**
 * `Ctrl+Shift+V` from a source: switch the tab in place to its Reading View. A Markdown
 * document the Reading View does not take goes to the built-in toggle; a diagram file
 * stays as it is (VS Code has no preview of its own for it). A VS Code that cannot
 * switch a tab in place opens the Preview beside the editor instead.
 */
async function toggleReadingView(): Promise<void> {
    // Read the editor in front only once the detection has ended: it may change meanwhile.
    const canSwitch = await canSwitchInPlace();
    const document = vscode.window.activeTextEditor?.document;
    const kind = document ? kindOfLanguage(document.languageId) : undefined;
    if (!document || !kind) return;
    const target = { uri: document.uri, document };
    if (!canSwitch) {
        if (kind === 'markdown') await openPreviewOr('markdown.togglePreview', []);
        else await vscode.commands.executeCommand(PREVIEW_COMMANDS[kind]);
        return;
    }
    if (opensInReadingView(target, kind)) {
        await vscode.commands.executeCommand('reopenActiveEditorWith', READING_VIEW_TYPES[kind]);
    } else if (kind === 'markdown') {
        await runBuiltin('markdown.togglePreview', []);
    }
}

/**
 * "Open as Preview" in place of the built-in one: switch the tab to the Markdown Reading
 * View, or hand the document to the built-in command.
 *
 * @param args - Arguments the entry passed.
 */
async function reopenAsPreview(...args: unknown[]): Promise<void> {
    const canSwitch = await canSwitchInPlace();
    const target = targetOf(args[0]);
    if (canSwitch && target && opensInReadingView(target, 'markdown')) {
        await vscode.commands.executeCommand('reopenActiveEditorWith', READING_VIEW_TYPES.markdown);
        return;
    }
    await runBuiltin(BUILTIN_REOPEN_AS_PREVIEW, args);
}

/**
 * Register the look-alike commands of the built-in preview entries and the key commands,
 * and update the context keys when extensions are enabled or disabled (VS Code's own
 * Markdown extension among them).
 *
 * @param context - Extension context; the registrations go to its subscriptions.
 * @param sync - Updates the context keys ({@link syncBuiltinReplacement}, with its errors handled).
 */
export function registerDefaultPreview(context: vscode.ExtensionContext, sync: () => void): void {
    context.subscriptions.push(
        vscode.extensions.onDidChange(() => sync()),
        vscode.commands.registerCommand('plantuml-markdown-preview.showPreviewToSide',
            (...args: unknown[]) => openPreviewOr('markdown.showPreviewToSide', args)),
        vscode.commands.registerCommand('plantuml-markdown-preview.showPreview',
            (...args: unknown[]) => openPreviewOr(BUILTIN_SHOW_PREVIEW, args)),
        vscode.commands.registerCommand('plantuml-markdown-preview.reopenAsPreview', reopenAsPreview),
        vscode.commands.registerCommand('plantuml-markdown-preview.toggleReadingView', () => toggleReadingView()),
    );
}
