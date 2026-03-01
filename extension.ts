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
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { exportToHtml, clearMdCache } from './src/exporter.js';
import { plantumlPlugin } from './src/renderer.js';
import { clearCache } from './src/plantuml.js';
import { clearServerCache } from './src/plantuml-server.js';
import type { PlantUmlConfig } from './src/plantuml.js';
import { openPreview, getCurrentFilePath, updateConfig, changeTheme, disposePreview, setOutputChannel } from './src/preview.js';
import type { PreviewConfig } from './src/preview.js';
import type MarkdownIt from 'markdown-it';

/** Absolute path to the extension root directory, set during activate(). */
let extensionPath = '';

/**
 * Resolve the path to the bundled PlantUML jar.
 *
 * Returns an empty string when `extensionPath` is not yet set (before activate)
 * or when the bundled jar file does not exist on disk.
 */
function resolveBundledJarPath(): string {
    if (!extensionPath) return '';
    const bundled = path.join(extensionPath, 'vendor', 'plantuml.jar');
    if (!existsSync(bundled)) {
        console.warn(`Bundled PlantUML jar not found at: ${bundled}`);
        return '';
    }
    return bundled;
}

/**
 * Read extension settings from the VS Code configuration store.
 *
 * When `jarPath` is empty (default), falls back to the bundled PlantUML jar
 * located at `<extensionPath>/vendor/plantuml.jar`.
 *
 * @returns {PreviewConfig} Current configuration values with defaults applied.
 */
function getConfig(): PreviewConfig {
    const cfg = vscode.workspace.getConfiguration('plantumlMarkdownPreview');
    const userJarPath = cfg.get<string>('jarPath', '');
    return {
        jarPath: userJarPath || resolveBundledJarPath(),
        javaPath: cfg.get<string>('javaPath', 'java'),
        dotPath: cfg.get<string>('dotPath', 'dot'),
        debounceNoPlantUmlMs: cfg.get<number>('debounceNoPlantUmlMs', 100),
        debouncePlantUmlMs: cfg.get<number>('debouncePlantUmlMs', 300),
        plantumlTheme: cfg.get<string>('plantumlTheme', 'default'),
        previewTheme: cfg.get<string>('previewTheme', 'github-light'),
        allowLocalImages: cfg.get<boolean>('allowLocalImages', true),
        allowHttpImages: cfg.get<boolean>('allowHttpImages', false),
        renderMode: cfg.get<'local' | 'server'>('renderMode', 'local'),
        serverUrl: cfg.get<string>('serverUrl', 'https://www.plantuml.com/plantuml'),
        // Intentionally not declared in package.json contributes.configuration (hidden debug setting)
        debugSimulateNoJava: cfg.get<boolean>('debugSimulateNoJava', false),
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
 * Returns null when no .md file can be determined.
 *
 * @param {vscode.Uri} [uri] - URI passed from a command invocation (e.g. explorer context menu).
 * @returns {string | null} Absolute .md file path, or null if no Markdown source is available.
 */
function resolveMarkdownPath(uri?: vscode.Uri): string | null {
    const fsPath = uri?.fsPath
        || vscode.window.activeTextEditor?.document.uri.fsPath
        || getCurrentFilePath();
    return fsPath?.endsWith('.md') ? fsPath : null;
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
    if (!filePath) {
        vscode.window.showErrorMessage(vscode.l10n.t('No Markdown file (.md) is selected.'));
        return null;
    }

    const config = getConfig();

    // jarPath check is only needed for local mode
    if (config.renderMode !== 'server' && !config.jarPath) {
        const openSettingsLabel = vscode.l10n.t('Open Settings');
        const action = await vscode.window.showErrorMessage(
            vscode.l10n.t('PlantUML jar is not configured. Open settings?'),
            openSettingsLabel
        );
        if (action === openSettingsLabel) {
            void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'plantumlMarkdownPreview.jarPath'
            );
        }
        return null;
    }

    try {
        return await exportToHtml(filePath, config);
    } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', (err as Error).message));
        return null;
    }
}

/** Open a file with the system's default application. */
function openInDefaultApp(filePath: string): void {
    if (!existsSync(filePath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('File not found: {0}', filePath));
        return;
    }
    void vscode.env.openExternal(vscode.Uri.file(filePath));
}

/** Reference to the in-flight Java check child process for cleanup on deactivate. */
let javaCheckChild: ReturnType<typeof execFile> | null = null;

/**
 * Check if Java is available. When not found (or debugSimulateNoJava is true),
 * show a notification with options to switch to server mode or install Java.
 */
async function checkJavaAvailability(config: PreviewConfig): Promise<void> {
    if (config.renderMode === 'server') return;

    const javaFound = await new Promise<boolean>((resolve) => {
        if (config.debugSimulateNoJava) { resolve(false); return; }
        javaCheckChild = execFile(config.javaPath || 'java', ['-version'], { timeout: 5000 }, (err) => {
            javaCheckChild = null;
            resolve(!err);
        });
    });
    if (javaFound) return;

    const useServer = vscode.l10n.t('Use Server Mode');
    const installJava = vscode.l10n.t('Install Java');
    const dismiss = vscode.l10n.t('Dismiss');

    const action = await vscode.window.showWarningMessage(
        vscode.l10n.t('Java is not found. PlantUML requires Java for local rendering.'),
        useServer, installJava, dismiss
    );

    if (action === useServer) {
        const serverUrl = config.serverUrl || 'https://www.plantuml.com/plantuml';
        const yesLabel = vscode.l10n.t('Yes, switch to server mode');
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('Server mode sends your diagrams to an external server ({0}). Continue?', serverUrl),
            yesLabel,
            vscode.l10n.t('Cancel')
        );
        if (confirm === yesLabel) {
            const cfg = vscode.workspace.getConfiguration('plantumlMarkdownPreview');
            await cfg.update('renderMode', 'server', vscode.ConfigurationTarget.Global);
        }
    } else if (action === installJava) {
        void vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/'));
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
    extensionPath = context.extensionPath;

    // Create and register the shared output channel so its lifecycle is managed
    // by context.subscriptions regardless of preview panel state.
    const channel = vscode.window.createOutputChannel('PlantUML Markdown Preview');
    context.subscriptions.push(channel);
    setOutputChannel(channel);

    // Ensure builtInPreviewConfig has correct values after workspace is fully loaded
    syncBuiltInPreviewConfig(getConfig());

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
                openInDefaultApp(outputPath);
            }
        }
    );

    const exportAndOpenCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.exportHtmlAndOpen',
        async (uri?: vscode.Uri) => {
            const outputPath = await runExport(uri);
            if (outputPath) {
                openInDefaultApp(outputPath);
            }
        }
    );

    const previewCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.openPreview',
        async (uri?: vscode.Uri) => {
            const filePath = resolveMarkdownPath(uri);
            if (!filePath) {
                vscode.window.showErrorMessage(vscode.l10n.t('No Markdown file (.md) is selected.'));
                return;
            }
            const config = getConfig();
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Opening preview...') },
                async () => {
                    await openPreview(filePath, config, false);
                    checkJavaAvailability(config).catch(() => {});
                }
            );
        }
    );

    const changeThemeCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.changeTheme',
        () => void changeTheme()
    );

    const editorTracker = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        if (!getCurrentFilePath()) return;
        const filePath = editor.document.uri.fsPath;
        if (!filePath.endsWith('.md')) return;
        if (filePath === getCurrentFilePath()) return;
        void openPreview(filePath, getConfig(), true);
    });

    const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('plantumlMarkdownPreview')) {
            const config = getConfig();
            updateConfig(config);
            syncBuiltInPreviewConfig(config);
        }
    });

    context.subscriptions.push(exportCmd, exportAndOpenCmd, previewCmd, changeThemeCmd, editorTracker, configWatcher);
}

/**
 * Called by VS Code when the extension is deactivated.
 *
 * Disposes the preview panel and all associated event listeners via disposePreview().
 * Clears all caches (SVG render cache, theme cache, markdown-it cache).
 */
export function deactivate(): void {
    if (javaCheckChild) {
        javaCheckChild.kill();
        javaCheckChild = null;
    }
    clearCache();
    clearServerCache();
    clearMdCache();
    disposePreview();
}

/**
 * Mutable config object shared with the built-in Markdown preview.
 *
 * Initialised with safe defaults (not via getConfig()) because this module-level
 * constant is evaluated before activate() sets extensionPath.  activate() calls
 * Object.assign to populate the real values once the extension context is ready.
 *
 * The fence rule captured by plantumlPlugin reads from this object,
 * so updating its properties via Object.assign keeps the built-in
 * preview in sync with user setting changes.
 *
 * NOTE: Default values here must match the defaults in getConfig().
 */
const builtInPreviewConfig: PlantUmlConfig = {
    jarPath: '',
    javaPath: 'java',
    dotPath: 'dot',
    plantumlTheme: 'default'
};

/** Sync builtInPreviewConfig with the current extension settings. */
function syncBuiltInPreviewConfig(config: PreviewConfig): void {
    builtInPreviewConfig.jarPath = config.jarPath;
    builtInPreviewConfig.javaPath = config.javaPath;
    builtInPreviewConfig.dotPath = config.dotPath;
    builtInPreviewConfig.plantumlTheme = config.plantumlTheme;
}

/**
 * Inject PlantUML rendering into VS Code's built-in Markdown preview.
 *
 * Called by VS Code's markdown.markdownItPlugins contribution point.
 * Uses a mutable config reference that is updated when settings change.
 *
 * @param {MarkdownIt} md - The markdown-it instance provided by VS Code.
 * @returns {MarkdownIt} The same instance with the PlantUML fence rule applied.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
    return plantumlPlugin(md, builtInPreviewConfig);
}
