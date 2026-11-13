/**
 * @module preview-editor
 * @description Custom editors that show a file's Reading View in its own tab.
 *
 * Key behaviors:
 * - One custom text editor per file kind; VS Code hands each tab a panel
 * - A document that is not a file (`git:` and other revisions) gets a notice page instead
 * - Tells whether this VS Code can switch a tab between the Reading View and the source
 */
import * as vscode from 'vscode';
import path from 'path';
import { CONFIG_SECTION, type Config } from './config.js';
import type { ReadingView, ReadingViewKind } from './reading-view.js';
import { addReadingView, removeReadingView, type ReadingViewEntry } from './preview-registry.js';
import { createMarkdownReadingView } from './preview.js';
import { createPumlReadingView } from './puml-preview.js';
import { createMermaidReadingView } from './mermaid-preview.js';
import { createD2ReadingView } from './d2-preview.js';
import { escapeHtml, isLiveSourceUri } from './utils.js';
import { MARKDOWN_EXTENSIONS } from './markdown-files.js';

/** Custom editor view type of each file kind (as declared in package.json). */
export const READING_VIEW_TYPES: Readonly<Record<ReadingViewKind, string>> = {
    markdown: 'plantumlMarkdownPreviewEditor',
    puml: 'plantumlPumlPreviewEditor',
    mermaid: 'plantumlMermaidPreviewEditor',
    d2: 'plantumlD2PreviewEditor',
};

/** File extensions each Reading View opens (lowercase; the custom editors' selectors). */
const READING_VIEW_EXTENSIONS: Readonly<Record<ReadingViewKind, readonly string[]>> = {
    markdown: MARKDOWN_EXTENSIONS,
    puml: ['.puml', '.plantuml'],
    mermaid: ['.mmd', '.mermaid'],
    d2: ['.d2'],
};

/** Context key that shows the commands switching a tab in place. */
const CAN_SWITCH_IN_PLACE_CONTEXT = 'plantumlMarkdownPreview.canSwitchInPlace';

/** Whether this VS Code has `reopenActiveEditorWith`; false until {@link detectSwitchInPlace} finds it. */
let switchInPlace = false;

/** The running or last detection; settles without rejecting. */
let detection: Promise<void> = Promise.resolve();

/**
 * View type of the Reading View that opens a file, judged by its extension as the
 * custom editors' selectors are (case-insensitive).
 *
 * @param filePath - Path of the file.
 * @returns The view type, or undefined when no Reading View opens the file.
 */
export function readingViewTypeForFile(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    const kind = (Object.keys(READING_VIEW_EXTENSIONS) as ReadingViewKind[])
        .find(k => READING_VIEW_EXTENSIONS[k].includes(ext));
    return kind ? READING_VIEW_TYPES[kind] : undefined;
}

/**
 * Whether this VS Code can switch a tab between the Reading View and the source in
 * place. Waits for the detection started at activation, so a command run before it
 * ends still switches.
 *
 * @returns True once {@link detectSwitchInPlace} found `reopenActiveEditorWith`.
 */
export async function canSwitchInPlace(): Promise<boolean> {
    await detection;
    return switchInPlace;
}

/**
 * Find out whether this VS Code has `reopenActiveEditorWith`, and set the context key
 * that shows the switching commands when it does.
 *
 * @returns Settles when the detection ends; rejects when it failed.
 */
export function detectSwitchInPlace(): Promise<void> {
    const run = (async () => {
        const commands = await vscode.commands.getCommands();
        switchInPlace = commands.includes('reopenActiveEditorWith');
        if (switchInPlace) await vscode.commands.executeCommand('setContext', CAN_SWITCH_IN_PLACE_CONTEXT, true);
    })();
    detection = run.catch(() => {});
    return run;
}

/**
 * Clear the context key {@link detectSwitchInPlace} set, when the extension stops.
 *
 * @returns Settles once the key is cleared (at once when it was never set).
 */
export async function releaseSwitchInPlace(): Promise<void> {
    if (!switchInPlace) return;
    await vscode.commands.executeCommand('setContext', CAN_SWITCH_IN_PLACE_CONTEXT, undefined);
}

/**
 * Switch the active Reading View tab to the source, in place.
 * Arguments a menu passes are ignored: the active editor is the one switched.
 */
export async function reopenAsSource(): Promise<void> {
    if (!await canSwitchInPlace()) return;
    await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
}

/**
 * Switch the active source tab to the Reading View of its kind, in place. A file no
 * Reading View opens, and a diff, are left as they are. Arguments a menu passes are ignored.
 */
export async function reopenAsReadingView(): Promise<void> {
    if (!await canSwitchInPlace()) return;
    if (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff) return;
    const document = vscode.window.activeTextEditor?.document;
    const viewType = document ? readingViewTypeForFile(document.uri.fsPath) : undefined;
    if (!viewType) return;
    await vscode.commands.executeCommand('reopenActiveEditorWith', viewType);
}

/** What the custom editors need from the extension. */
export interface ReadingViewHost {
    /** Current extension settings. */
    getConfig(): Config;
    /** Report the opening of a PlantUML-capable view before it renders. */
    handleOpenEvent(config: Config): void;
    /** Channel for render errors. */
    outputChannel: vscode.OutputChannel;
}

/**
 * Page shown in place of a document that is not a file.
 *
 * @returns The full HTML of the page.
 */
function noticePage(): string {
    const message = vscode.l10n.t('This file cannot be shown in the Reading View. Right-click and choose "Switch to Source" to switch to the source.');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body style="padding:1em;color:var(--vscode-foreground);">${escapeHtml(message)}</body></html>`;
}

/**
 * Create the Reading View of a kind in a handed-over panel.
 *
 * @param kind - Kind of file.
 * @param panel - The panel VS Code handed over.
 * @param filePath - Absolute path of the file.
 * @param config - Current extension settings.
 * @param outputChannel - Channel for render errors.
 * @returns The Reading View drawing the file in the panel.
 */
function createReadingView(kind: ReadingViewKind, panel: vscode.WebviewPanel, filePath: string, config: Config, outputChannel: vscode.OutputChannel): ReadingView {
    const adopted = { panel, filePath };
    switch (kind) {
        case 'markdown': return createMarkdownReadingView(adopted, config, outputChannel);
        case 'puml': return createPumlReadingView(adopted, config);
        case 'mermaid': return createMermaidReadingView(adopted, config);
        case 'd2': return createD2ReadingView(adopted, config);
    }
}

/** Shows the files of one kind in custom editor tabs. */
export class ReadingViewProvider implements vscode.CustomTextEditorProvider {
    /**
     * @param kind - Kind of file the editor shows.
     * @param host - What the extension provides.
     */
    constructor(private readonly kind: ReadingViewKind, private readonly host: ReadingViewHost) {}

    /**
     * Show a document in the panel VS Code handed over. Settles when the first render
     * ends, or as soon as VS Code cancels the request.
     *
     * @param document - The document of the tab.
     * @param panel - The panel VS Code handed over; VS Code disposes it.
     * @param token - Cancelled when VS Code no longer needs the editor.
     */
    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
        if (token.isCancellationRequested) return;
        if (!isLiveSourceUri(document.uri)) {
            panel.webview.html = noticePage();
            this.track({ rendered: false, kind: this.kind, panel });
            return;
        }
        const config = this.host.getConfig();
        // As the commands opening a preview do: the event restarts a stopped PlantUML server.
        if (this.kind === 'markdown' || this.kind === 'puml') this.host.handleOpenEvent(config);
        const view = createReadingView(this.kind, panel, document.uri.fsPath, config, this.host.outputChannel);
        this.track({ rendered: true, kind: this.kind, panel, view });
        let cancelled: vscode.Disposable | undefined;
        await Promise.race([
            view.firstRender,
            new Promise<void>(resolve => { cancelled = token.onCancellationRequested(() => resolve()); }),
        ]);
        cancelled?.dispose();
    }

    /**
     * Keep a tab in the registry until VS Code disposes its panel. The view stops
     * itself on that disposal.
     *
     * @param entry - The tab and what it shows.
     */
    private track(entry: ReadingViewEntry): void {
        addReadingView(entry);
        const disposal = entry.panel.onDidDispose(() => {
            removeReadingView(entry);
            disposal.dispose();
        });
    }
}

/**
 * Register the custom editor of every file kind.
 *
 * @param context - Extension context; the registrations go to its subscriptions.
 * @param host - What the extension provides.
 */
export function registerReadingViews(context: vscode.ExtensionContext, host: ReadingViewHost): void {
    // Read once: changing the setting reaches Reading Views after a window reload.
    const retainContextWhenHidden = vscode.workspace.getConfiguration(CONFIG_SECTION)
        .get<boolean>('retainPreviewContext', true);
    for (const kind of Object.keys(READING_VIEW_TYPES) as ReadingViewKind[]) {
        context.subscriptions.push(vscode.window.registerCustomEditorProvider(
            READING_VIEW_TYPES[kind],
            new ReadingViewProvider(kind, host),
            { webviewOptions: { enableFindWidget: true, retainContextWhenHidden } },
        ));
    }
}
