/**
 * @module extension
 * @description VS Code extension entry point.
 *
 * Responsibilities:
 * - Register commands: openPreview / exportHtml / exportHtmlAndOpen / changeTheme
 * - Read VS Code settings (getConfig)
 * - Auto-follow active editor tab (editorTracker)
 * - Propagate settings changes to the preview (configWatcher)
 * - Inject PlantUML plugin into VS Code built-in Markdown preview (extendMarkdownIt)
 */
import * as vscode from 'vscode';
import path from 'path';
import { exportToHtml } from './src/exporter.js';
import { plantumlPlugin } from './src/renderer.js';
import { openPreview, getCurrentFilePath, updateConfig, changeTheme, disposePreview } from './src/preview.js';
import type { PreviewConfig } from './src/preview.js';
import type MarkdownIt from 'markdown-it';

/**
 * Read extension settings from the VS Code configuration store.
 *
 * @returns {PreviewConfig} Current configuration values with defaults applied.
 */
function getConfig(): PreviewConfig {
    const cfg = vscode.workspace.getConfiguration('plantumlMarkdownPreview');
    return {
        jarPath: cfg.get<string>('jarPath', ''),
        javaPath: cfg.get<string>('javaPath', 'java'),
        dotPath: cfg.get<string>('dotPath', 'dot'),
        debounceNoPlantUmlMs: cfg.get<number>('debounceNoPlantUmlMs', 100),
        debouncePlantUmlMs: cfg.get<number>('debouncePlantUmlMs', 100),
        plantumlTheme: cfg.get<string>('plantumlTheme', 'default'),
        previewTheme: cfg.get<string>('previewTheme', 'github-light')
    };
}

/**
 * Resolve the target Markdown file path from available sources.
 *
 * Resolution order:
 * 1. Command argument URI (right-click menu)
 * 2. Active text editor
 * 3. Currently previewed file
 *
 * @param {vscode.Uri} [uri] - URI passed from a command invocation (e.g. explorer context menu).
 * @returns {string | null} Absolute file path, or null if no Markdown source is available.
 */
function resolveMarkdownPath(uri?: vscode.Uri): string | null {
    if (uri && uri.fsPath) return uri.fsPath;
    if (vscode.window.activeTextEditor) return vscode.window.activeTextEditor.document.uri.fsPath;
    return getCurrentFilePath();
}

/**
 * Validate the Markdown file path, verify jarPath setting, and run HTML export.
 *
 * Shows user-facing error messages when validation fails (not .md, jarPath not set).
 *
 * @param {vscode.Uri} [uri] - URI passed from a command invocation.
 * @returns {Promise<string | null>} Absolute path of the generated HTML file, or null on failure.
 */
async function runExport(uri?: vscode.Uri): Promise<string | null> {
    const filePath = resolveMarkdownPath(uri);
    if (!filePath || !filePath.endsWith('.md')) {
        vscode.window.showErrorMessage(vscode.l10n.t('No Markdown file (.md) is selected.'));
        return null;
    }

    const config = getConfig();

    if (!config.jarPath) {
        const openSettingsLabel = vscode.l10n.t('Open Settings');
        const action = await vscode.window.showErrorMessage(
            vscode.l10n.t('PlantUML jar is not configured. Open settings?'),
            openSettingsLabel
        );
        if (action === openSettingsLabel) {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'plantumlMarkdownPreview.jarPath'
            );
        }
        return null;
    }

    try {
        return exportToHtml(filePath, config);
    } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', (err as Error).message));
        return null;
    }
}

/**
 * Called by VS Code when the extension is activated.
 *
 * Registers all commands, the active editor tracker, and the configuration watcher.
 *
 * @param {vscode.ExtensionContext} context - Extension context for managing subscriptions and storage.
 */
export function activate(context: vscode.ExtensionContext): void {
    const exportCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.exportHtml',
        async (uri?: vscode.Uri) => {
            const outputPath = await runExport(uri);
            if (!outputPath) return;
            const openInBrowserLabel = vscode.l10n.t('Open in Browser');
            const action = await vscode.window.showInformationMessage(
                vscode.l10n.t('HTML exported: {0}', path.basename(outputPath)),
                openInBrowserLabel
            );
            if (action === openInBrowserLabel) {
                vscode.env.openExternal(vscode.Uri.file(outputPath));
            }
        }
    );

    const exportAndOpenCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.exportHtmlAndOpen',
        async (uri?: vscode.Uri) => {
            const outputPath = await runExport(uri);
            if (outputPath) {
                vscode.env.openExternal(vscode.Uri.file(outputPath));
            }
        }
    );

    const previewCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.openPreview',
        async (uri?: vscode.Uri) => {
            const filePath = resolveMarkdownPath(uri);
            if (!filePath || !filePath.endsWith('.md')) {
                vscode.window.showErrorMessage(vscode.l10n.t('No Markdown file (.md) is selected.'));
                return;
            }
            openPreview(context, filePath, getConfig());
        }
    );

    const changeThemeCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.changeTheme',
        () => changeTheme()
    );

    const editorTracker = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        if (!getCurrentFilePath()) return;
        const filePath = editor.document.uri.fsPath;
        if (!filePath.endsWith('.md')) return;
        if (filePath === getCurrentFilePath()) return;
        openPreview(context, filePath, getConfig(), true);
    });

    const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('plantumlMarkdownPreview')) {
            updateConfig(getConfig());
        }
    });

    context.subscriptions.push(exportCmd, exportAndOpenCmd, previewCmd, changeThemeCmd, editorTracker, configWatcher);
}

/**
 * Called by VS Code when the extension is deactivated.
 *
 * Disposes the preview panel and all associated event listeners via disposePreview().
 */
export function deactivate(): void {
    disposePreview();
}

/**
 * Inject PlantUML rendering into VS Code's built-in Markdown preview.
 *
 * Called by VS Code's markdown.markdownItPlugins contribution point.
 *
 * @param {MarkdownIt} md - The markdown-it instance provided by VS Code.
 * @returns {MarkdownIt} The same instance with the PlantUML fence rule applied.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
    return plantumlPlugin(md, getConfig());
}
