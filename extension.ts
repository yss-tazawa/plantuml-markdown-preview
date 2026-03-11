/**
 * @module extension
 * @description VS Code extension entry point.
 *
 * Responsibilities:
 * - Register commands: openPreview / exportHtml / exportHtmlAndOpen / exportHtmlFitToWidth / exportHtmlFitToWidthAndOpen / exportPdf / exportPdfAndOpen / changeTheme / openDiagramViewer / saveDiagramAsPng / saveDiagramAsSvg / copyDiagramAsPng
 * - Read VS Code settings (getConfig)
 * - Auto-follow active editor tab (editorTracker)
 * - Propagate settings changes to the preview (configWatcher)
 * - Inject PlantUML plugin into VS Code built-in Markdown preview (extendMarkdownIt)
 */
import * as vscode from 'vscode';
import path from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { exportToHtml, exportToPdf, clearMdCache } from './src/exporter.js';
import { plantumlPlugin } from './src/renderer.js';
import { clearCache } from './src/plantuml.js';
import { clearServerCache } from './src/plantuml-server.js';
import { prepareLocalServer, startLocalServer, stopLocalServer, restartLocalServer, setLocalServerOutputChannel } from './src/local-server.js';
import { openPreview, getCurrentFilePath, getLastRenderFailed, updateConfig, changeTheme, disposePreview, setOutputChannel, getPreviewPanel } from './src/preview.js';
import { execJava } from './src/utils.js';
import { clearBrowserCache } from './src/browser-finder.js';
import { disposeAllViewers, diagramAction, openPendingDiagramViewer } from './src/diagram-viewer.js';
import { openPumlPreview, updatePumlConfig, getCurrentPumlFilePath, disposePumlPreview, getPumlPreviewPanel, changePumlTheme } from './src/puml-preview.js';
import { openMermaidPreview, updateMermaidConfig, getCurrentMermaidFilePath, disposeMermaidPreview, getMermaidPreviewPanel, changeMermaidTheme } from './src/mermaid-preview.js';
import { CONFIG_SECTION, MODE_PRESETS, type Config, type Mode } from './src/config.js';
import type MarkdownIt from 'markdown-it';

/**
 * Resolve the allowLocalImages tri-state setting to a boolean.
 *
 * When the user sets `'mode-default'`, the result falls back to the preset's
 * default value. Explicit `'on'` or `'off'` overrides the preset.
 *
 * @param value - User setting: `'mode-default'`, `'on'`, or `'off'`.
 * @param presetDefault - Default value defined by the active mode preset.
 * @returns Whether local images should be allowed.
 */
function resolveAllowLocalImages(value: string, presetDefault: boolean): boolean {
    if (value === 'on') return true;
    if (value === 'off') return false;
    return presetDefault;
}

/** Absolute path to the extension root directory, set during activate(). */
let extensionPath = '';

/**
 * Resolve the path to the bundled PlantUML jar.
 *
 * Returns an empty string when `extensionPath` is not yet set (before activate)
 * or when the bundled jar file does not exist on disk.
 *
 * @returns Absolute path to the bundled jar, or empty string if unavailable.
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
 * When `plantumlJarPath` is empty (default), falls back to the bundled PlantUML jar
 * located at `<extensionPath>/vendor/plantuml.jar`.
 *
 * @returns Current configuration values with defaults applied.
 */
function getConfig(): Config {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const userJarPath = cfg.get<string>('plantumlJarPath', '');
    const mode = (cfg.get<string>('mode', 'fast') as Mode);
    const preset = MODE_PRESETS[mode] ?? MODE_PRESETS.fast;
    return {
        mode,
        plantumlJarPath: (userJarPath && existsSync(userJarPath) ? userJarPath : '') || resolveBundledJarPath(),
        javaPath: cfg.get<string>('javaPath', 'java'),
        dotPath: cfg.get<string>('dotPath', 'dot'),
        debounceNoDiagramChangeMs: cfg.get<number>('debounceNoDiagramChangeMs') ?? preset.debounceNoDiagramChangeMs,
        debounceDiagramChangeMs: cfg.get<number>('debounceDiagramChangeMs') ?? preset.debounceDiagramChangeMs,
        plantumlTheme: cfg.get<string>('plantumlTheme', 'default'),
        plantumlScale: cfg.get<string>('plantumlScale', '100%'),
        previewTheme: cfg.get<string>('previewTheme', 'github-light'),
        allowLocalImages: resolveAllowLocalImages(cfg.get<string>('allowLocalImages', 'mode-default'), preset.allowLocalImages),
        allowHttpImages: cfg.get<boolean>('allowHttpImages', false),
        renderMode: preset.renderMode,
        plantumlServerUrl: cfg.get<string>('plantumlServerUrl', 'https://www.plantuml.com/plantuml'),
        plantumlLocalServerPort: cfg.get<number>('plantumlLocalServerPort', 0),
        mermaidTheme: cfg.get<string>('mermaidTheme', 'default'),
        mermaidScale: cfg.get<string>('mermaidScale', '80%'),
        htmlMaxWidth: cfg.get<string>('htmlMaxWidth', '960px'),
        htmlAlignment: cfg.get<string>('htmlAlignment', 'center'),
        enableMath: cfg.get<boolean>('enableMath', true),
        plantumlIncludePath: cfg.get<string>('plantumlIncludePath', ''),
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
 * @param [uri] - URI passed from a command invocation (e.g. explorer context menu).
 * @returns Absolute .md file path, or null if no Markdown source is available.
 */
function resolveMarkdownPath(uri?: vscode.Uri): string | null {
    const fsPath = uri?.fsPath
        || vscode.window.activeTextEditor?.document.uri.fsPath
        || getCurrentFilePath();
    return fsPath?.endsWith('.md') ? fsPath : null;
}

/** PlantUML file extensions supported for standalone preview. */
const PUML_EXTENSIONS = ['.puml', '.plantuml'];

/**
 * Check whether a file path has a PlantUML extension.
 */
function isPumlFile(fsPath: string): boolean {
    return PUML_EXTENSIONS.some(ext => fsPath.endsWith(ext));
}

/**
 * Resolve the target PlantUML file path from available sources.
 *
 * @param [uri] - URI passed from a command invocation.
 * @returns Absolute .puml file path, or null if unavailable.
 */
function resolvePumlPath(uri?: vscode.Uri): string | null {
    const fsPath = uri?.fsPath
        || vscode.window.activeTextEditor?.document.uri.fsPath
        || getCurrentPumlFilePath();
    return fsPath && isPumlFile(fsPath) ? fsPath : null;
}

/** Mermaid file extensions supported for standalone preview. */
const MERMAID_EXTENSIONS = ['.mmd', '.mermaid'];

/**
 * Check whether a file path has a Mermaid extension.
 */
function isMermaidFile(fsPath: string): boolean {
    return MERMAID_EXTENSIONS.some(ext => fsPath.endsWith(ext));
}

/**
 * Resolve the target Mermaid file path from available sources.
 *
 * @param [uri] - URI passed from a command invocation.
 * @returns Absolute .mmd/.mermaid file path, or null if unavailable.
 */
function resolveMermaidPath(uri?: vscode.Uri): string | null {
    const fsPath = uri?.fsPath
        || vscode.window.activeTextEditor?.document.uri.fsPath
        || getCurrentMermaidFilePath();
    return fsPath && isMermaidFile(fsPath) ? fsPath : null;
}

/**
 * Validate the Markdown file path, verify jarPath setting, and run export.
 *
 * Shows user-facing error messages when validation fails (not .md, jarPath not set).
 *
 * @param [uri] - URI passed from a command invocation.
 * @param [options] - Export options (fitToWidth, pdf).
 * @returns Absolute path of the generated file (HTML or PDF), or null on failure.
 */
async function runExport(uri?: vscode.Uri, options?: { fitToWidth?: boolean; pdf?: boolean }): Promise<string | null> {
    const filePath = resolveMarkdownPath(uri);
    if (!filePath) {
        vscode.window.showErrorMessage(vscode.l10n.t('No Markdown file (.md) is selected.'));
        return null;
    }

    const config = getConfig();

    // plantumlJarPath check is only needed for local mode
    if (config.renderMode !== 'server' && !config.plantumlJarPath) {
        const openSettingsLabel = vscode.l10n.t('Open Settings');
        const action = await vscode.window.showErrorMessage(
            vscode.l10n.t('PlantUML jar is not configured. Open settings?'),
            openSettingsLabel
        );
        if (action === openSettingsLabel) {
            void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'plantumlMarkdownPreview.plantumlJarPath'
            );
        }
        return null;
    }

    try {
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: options?.pdf
                    ? vscode.l10n.t('Exporting PDF...')
                    : vscode.l10n.t('Rendering diagrams...'),
                cancellable: false,
            },
            async () => {
                if (options?.pdf) {
                    return await exportToPdf(filePath, config);
                }
                return await exportToHtml(filePath, config, undefined, options?.fitToWidth);
            }
        );
    } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', (err as Error).message));
        return null;
    }
}

/**
 * Open a file with the system's default application.
 *
 * Uses child_process.execFile to pass the native filesystem path directly,
 * avoiding percent-encoding issues with non-ASCII characters in file:// URIs.
 *
 * @param filePath - Absolute path to the file to open.
 */
function openInDefaultApp(filePath: string): void {
    if (!existsSync(filePath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('File not found: {0}', filePath));
        return;
    }
    const cmd = process.platform === 'win32' ? 'explorer.exe'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = execFile(cmd, [filePath], (err) => {
        // explorer.exe returns exit code 1 on success; only show errors on non-Windows platforms
        if (err && process.platform !== 'win32') {
            vscode.window.showErrorMessage(vscode.l10n.t('Failed to open file: {0}', err.message));
        }
    });
    child.unref();
}

/** Reference to the in-flight Java check child process for cleanup on deactivate. */
let javaCheckChild: ReturnType<typeof execJava> | null = null;
/** Reference to the in-flight JVM warmup child process for cleanup on deactivate. */
let warmupChild: ReturnType<typeof execJava> | null = null;

/** Last known config for detecting local-server relevant changes. */
let lastKnownConfig: Config | null = null;

/**
 * Check if Java is available. When not found (or debugSimulateNoJava is true),
 * show a notification with options to switch to server mode or install Java.
 *
 * @param config - Current extension settings (javaPath, renderMode, serverUrl).
 * @returns `true` if Java was found, `false` otherwise.
 */
async function checkJavaAvailability(config: Config): Promise<boolean> {
    if (config.renderMode === 'server') return true;

    // Pre-check: if user specified an explicit path, verify it exists on disk
    const resolvedJava = config.javaPath;
    if (resolvedJava !== 'java' && !existsSync(resolvedJava)) {
        const openSettings = vscode.l10n.t('Open Settings');
        const useEasy = vscode.l10n.t('Use Easy Mode');
        const action = await vscode.window.showErrorMessage(
            vscode.l10n.t('Java path "{0}" does not exist. Check the plantumlMarkdownPreview.javaPath setting.', resolvedJava),
            openSettings, useEasy
        );
        if (action === openSettings) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'plantumlMarkdownPreview.javaPath');
        } else if (action === useEasy) {
            await promptSwitchToEasy(config);
        }
        return false;
    }

    const javaResult = await new Promise<{ found: boolean; versionOutput: string }>((resolve) => {
        if (config.debugSimulateNoJava) { resolve({ found: false, versionOutput: '' }); return; }
        if (javaCheckChild) { javaCheckChild.kill(); javaCheckChild = null; }
        javaCheckChild = execJava(config.javaPath, ['-version'], { timeout: 5000 }, (err, _stdout, stderr) => {
            javaCheckChild = null;
            resolve({ found: !err, versionOutput: stderr || '' });
        });
    });

    if (javaResult.found) {
        const major = parseJavaMajorVersion(javaResult.versionOutput);
        if (major !== null && major < 11) {
            const useEasy = vscode.l10n.t('Use Easy Mode');
            const installJava = vscode.l10n.t('Install Java');
            const dismiss = vscode.l10n.t('Dismiss');
            const action = await vscode.window.showWarningMessage(
                vscode.l10n.t('Java {0} is installed, but the bundled PlantUML requires Java 11 or later. Please upgrade Java.', String(major)),
                useEasy, installJava, dismiss
            );
            if (action === useEasy) {
                await promptSwitchToEasy(config);
            } else if (action === installJava) {
                void vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/'));
            }
            return false;
        }
        return true;
    }

    const useEasy = vscode.l10n.t('Use Easy Mode');
    const installJava = vscode.l10n.t('Install Java');
    const dismiss = vscode.l10n.t('Dismiss');

    const action = await vscode.window.showWarningMessage(
        vscode.l10n.t('Java is not found. PlantUML requires Java 11 or later for local rendering.'),
        useEasy, installJava, dismiss
    );

    if (action === useEasy) {
        await promptSwitchToEasy(config);
    } else if (action === installJava) {
        void vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/'));
    }
    return false;
}

/**
 * Show a confirmation dialog to switch to Easy mode.
 *
 * Warns the user that diagram source will be sent to a PlantUML server,
 * then updates the global mode setting if confirmed.
 *
 * @param config - Current extension settings (for server URL display).
 */
async function promptSwitchToEasy(config: Config): Promise<void> {
    const serverUrl = config.plantumlServerUrl || 'https://www.plantuml.com/plantuml';
    const yesLabel = vscode.l10n.t('Yes, switch to Easy mode');
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t('Easy mode sends diagram source to a PlantUML server ({0}). Continue?', serverUrl),
        yesLabel,
        vscode.l10n.t('Cancel')
    );
    if (confirm === yesLabel) {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await cfg.update('mode', 'easy', vscode.ConfigurationTarget.Global);
    }
}

/**
 * Parse the major version number from `java -version` stderr output.
 *
 * Handles formats like:
 *   java version "1.8.0_392"   -> 8
 *   java version "11.0.24"     -> 11
 *   openjdk version "21.0.6"   -> 21
 *
 * @param versionOutput - Stderr output from `java -version`.
 * @returns Major version number, or null if parsing fails.
 */
function parseJavaMajorVersion(versionOutput: string): number | null {
    const match = versionOutput.match(/version\s+"(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    const major = parseInt(match[1], 10);
    if (major === 1 && match[2]) return parseInt(match[2], 10);
    return major;
}

/**
 * Called by VS Code when the extension is activated.
 *
 * Registers all commands, the active editor tracker, and the configuration watcher.
 *
 * @param context - Extension context for managing subscriptions and storage.
 */
export function activate(context: vscode.ExtensionContext): { extendMarkdownIt: (md: MarkdownIt) => MarkdownIt } {
    extensionPath = context.extensionPath;

    // Create and register the shared output channel so its lifecycle is managed
    // by context.subscriptions regardless of preview panel state.
    const channel = vscode.window.createOutputChannel('PlantUML Markdown Preview');
    context.subscriptions.push(channel);
    setOutputChannel(channel);
    setLocalServerOutputChannel(channel);

    // Ensure builtInPreviewConfig has correct values after workspace is fully loaded
    const initialConfig = getConfig();

    // Notify if user-specified plantumlJarPath was invalid and fell back to bundled jar
    const userJarPathAtStartup = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('plantumlJarPath', '');
    if (userJarPathAtStartup && !existsSync(userJarPathAtStartup)) {
        void vscode.window.showWarningMessage(
            vscode.l10n.t('PlantUML jar "{0}" does not exist. Using bundled jar instead.', userJarPathAtStartup)
        );
    }

    lastKnownConfig = initialConfig;
    syncBuiltInPreviewConfig(initialConfig);

    function registerExportCommand(
        id: string,
        exportOptions: { fitToWidth?: boolean; pdf?: boolean } | undefined,
        autoOpen: boolean,
        showNotification?: (outputPath: string) => Thenable<void>
    ): vscode.Disposable {
        return vscode.commands.registerCommand(id, async (uri?: vscode.Uri) => {
            const outputPath = await runExport(uri, exportOptions);
            if (!outputPath) return;
            if (autoOpen) {
                openInDefaultApp(outputPath);
            } else if (showNotification) {
                await showNotification(outputPath);
            }
        });
    }

    async function notifyHtmlExported(outputPath: string): Promise<void> {
        const label = vscode.l10n.t('Open in Browser');
        const action = await vscode.window.showInformationMessage(
            vscode.l10n.t('HTML exported: {0}', path.basename(outputPath)),
            label
        );
        if (action === label) openInDefaultApp(outputPath);
    }

    async function notifyPdfExported(outputPath: string): Promise<void> {
        const label = vscode.l10n.t('Open');
        const action = await vscode.window.showInformationMessage(
            vscode.l10n.t('PDF exported: {0}', path.basename(outputPath)),
            label
        );
        if (action === label) openInDefaultApp(outputPath);
    }

    const exportCmd = registerExportCommand(
        'plantuml-markdown-preview.exportHtml', undefined, false, notifyHtmlExported
    );
    const exportAndOpenCmd = registerExportCommand(
        'plantuml-markdown-preview.exportHtmlAndOpen', undefined, true
    );
    const exportHtmlFitCmd = registerExportCommand(
        'plantuml-markdown-preview.exportHtmlFitToWidth', { fitToWidth: true }, false, notifyHtmlExported
    );
    const exportHtmlFitAndOpenCmd = registerExportCommand(
        'plantuml-markdown-preview.exportHtmlFitToWidthAndOpen', { fitToWidth: true }, true
    );
    const exportPdfCmd = registerExportCommand(
        'plantuml-markdown-preview.exportPdf', { pdf: true }, false, notifyPdfExported
    );
    const exportPdfAndOpenCmd = registerExportCommand(
        'plantuml-markdown-preview.exportPdfAndOpen', { pdf: true }, true
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
                    await openPreview(filePath, config, true, true);
                    checkJavaAvailability(config).catch(() => {});
                }
            );
        }
    );

    const pumlPreviewCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.openPumlPreview',
        async (uri?: vscode.Uri) => {
            const filePath = resolvePumlPath(uri);
            if (!filePath) {
                vscode.window.showErrorMessage(vscode.l10n.t('No PlantUML file is selected.'));
                return;
            }
            const config = getConfig();
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Opening preview...') },
                async () => {
                    await openPumlPreview(filePath, config);
                    checkJavaAvailability(config).catch(() => {});
                }
            );
        }
    );

    const mermaidPreviewCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.openMermaidPreview',
        async (uri?: vscode.Uri) => {
            const filePath = resolveMermaidPath(uri);
            if (!filePath) {
                vscode.window.showErrorMessage(vscode.l10n.t('No Mermaid file is selected.'));
                return;
            }
            const config = getConfig();
            await openMermaidPreview(filePath, config, context.extensionUri);
        }
    );

    const changeThemeCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.changeTheme',
        () => {
            if (getMermaidPreviewPanel()?.active) {
                void changeMermaidTheme();
            } else if (getPumlPreviewPanel()?.active) {
                void changePumlTheme();
            } else {
                void changeTheme();
            }
        }
    );

    /** Dispatch a save/copy diagram command to the appropriate webview panel. */
    function handleDiagramCommand(action: 'save' | 'copy', format: 'png' | 'svg'): void {
        const msgType = action === 'copy' ? 'copyDiagram' : 'exportDiagram';
        const mermaidPanel = getMermaidPreviewPanel();
        if (mermaidPanel?.active) {
            void mermaidPanel.webview.postMessage({ type: msgType, format });
            return;
        }
        const pumlPanel = getPumlPreviewPanel();
        if (pumlPanel?.active) {
            void pumlPanel.webview.postMessage({ type: msgType, format });
        } else {
            diagramAction(action, format, getPreviewPanel() ?? undefined);
        }
    }

    const openViewerCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.openDiagramViewer', () => openPendingDiagramViewer());
    const savePngCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.saveDiagramAsPng', () => handleDiagramCommand('save', 'png'));
    const saveSvgCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.saveDiagramAsSvg', () => handleDiagramCommand('save', 'svg'));
    const copyPngCmd = vscode.commands.registerCommand(
        'plantuml-markdown-preview.copyDiagramAsPng', () => handleDiagramCommand('copy', 'png'));

    const editorTracker = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const filePath = editor.document.uri.fsPath;

        // Track .mermaid files
        if (isMermaidFile(filePath) && getCurrentMermaidFilePath()) {
            if (filePath !== getCurrentMermaidFilePath()) {
                void openMermaidPreview(filePath, getConfig(), context.extensionUri);
            }
            return;
        }

        // Track .puml files
        if (isPumlFile(filePath) && getCurrentPumlFilePath()) {
            if (filePath !== getCurrentPumlFilePath()) {
                void openPumlPreview(filePath, getConfig());
            }
            return;
        }

        // Track .md files
        if (!getCurrentFilePath()) return;
        if (!filePath.endsWith('.md')) return;
        if (filePath === getCurrentFilePath() && !getLastRenderFailed()) return;
        void openPreview(filePath, getConfig(), true);
    });

    const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
            const config = getConfig();

            // Reject invalid javaPath: keep using the previous config
            if (config.javaPath !== 'java'
                && !existsSync(config.javaPath)) {
                const openSettings = vscode.l10n.t('Open Settings');
                void vscode.window.showErrorMessage(
                    vscode.l10n.t('Java path "{0}" does not exist. Check the plantumlMarkdownPreview.javaPath setting.', config.javaPath),
                    openSettings
                ).then((action) => {
                    if (action === openSettings) {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'plantumlMarkdownPreview.javaPath');
                    }
                });
                // Remember the rejected javaPath so that fixing it later triggers a change notification
                if (lastKnownConfig) { lastKnownConfig.javaPath = config.javaPath; }
                return;  // don't update lastKnownConfig — keep old valid config
            }

            // Notify if user-specified plantumlJarPath fell back to bundled jar
            const userJarPath = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('plantumlJarPath', '');
            const jarFellBackToBundled = !!userJarPath && !existsSync(userJarPath);
            if (jarFellBackToBundled) {
                void vscode.window.showWarningMessage(
                    vscode.l10n.t('PlantUML jar "{0}" does not exist. Using bundled jar instead.', userJarPath)
                );
            }

            // Notify when javaPath or plantumlJarPath changed successfully
            if (lastKnownConfig && lastKnownConfig.javaPath !== config.javaPath) {
                void vscode.window.showInformationMessage(
                    vscode.l10n.t('Java path changed to: {0}', config.javaPath)
                );
            }
            if (!jarFellBackToBundled && lastKnownConfig && lastKnownConfig.plantumlJarPath !== config.plantumlJarPath) {
                void vscode.window.showInformationMessage(
                    vscode.l10n.t('PlantUML jar path changed to: {0}', config.plantumlJarPath)
                );
            }

            // Manage local-server lifecycle on config change
            handleLocalServerConfigChange(lastKnownConfig, config);
            lastKnownConfig = config;

            updateConfig(config);
            updatePumlConfig(config);
            updateMermaidConfig(config);
            syncBuiltInPreviewConfig(config);
        }
    });

    context.subscriptions.push(exportCmd, exportAndOpenCmd, exportHtmlFitCmd, exportHtmlFitAndOpenCmd, exportPdfCmd, exportPdfAndOpenCmd, previewCmd, pumlPreviewCmd, mermaidPreviewCmd, changeThemeCmd, openViewerCmd, savePngCmd, saveSvgCmd, copyPngCmd, editorTracker, configWatcher);

    // Start local PlantUML picoweb server if local-server mode is selected.
    // prepareLocalServer() pre-creates the readyPromise so that any preview
    // opened while Java is being checked will wait instead of failing immediately.
    // Check Java availability first — if not found, show the server-mode switch
    // notification instead of attempting to start the local server.
    if (initialConfig.renderMode === 'local-server') {
        prepareLocalServer();
        checkJavaAvailability(initialConfig).then(javaFound => {
            if (javaFound) {
                startLocalServer(initialConfig).catch(err =>
                    channel.appendLine(`[local-server start error] ${err}`)
                );
            } else {
                stopLocalServer();
            }
        }).catch(() => {
            stopLocalServer();
        });
    }

    // For 'local' (secure) mode, check Java availability at startup and warm up JVM cache.
    if (initialConfig.renderMode === 'local') {
        checkJavaAvailability(initialConfig).then(javaFound => {
            if (javaFound && initialConfig.plantumlJarPath) {
                warmupChild = execJava(initialConfig.javaPath, ['-jar', initialConfig.plantumlJarPath, '-version'],
                    { timeout: 30000 }, (_err) => { warmupChild = null; });
            }
        }).catch(() => { /* checkJavaAvailability handles the error dialog */ });
    }

    return { extendMarkdownIt };
}

/** Keys that affect the local-server process and require a restart when changed. */
const LOCAL_SERVER_KEYS = ['plantumlJarPath', 'javaPath', 'dotPath', 'plantumlLocalServerPort'] as const;

/**
 * Handle local-server lifecycle when configuration changes.
 *
 * - If the user switched TO local-server mode: start the server.
 * - If the user switched AWAY from local-server mode: stop the server.
 * - If the user stayed in local-server mode but changed relevant settings: restart.
 *
 * @param oldConfig - Previous configuration snapshot, or null on first run.
 * @param newConfig - Newly read configuration values.
 */
function handleLocalServerConfigChange(oldConfig: Config | null, newConfig: Config): void {
    const wasLocalServer = oldConfig?.renderMode === 'local-server';
    const isLocalServer = newConfig.renderMode === 'local-server';

    if (!wasLocalServer && isLocalServer) {
        // Switched TO local-server mode — check Java first
        prepareLocalServer();
        checkJavaAvailability(newConfig).then(javaFound => {
            if (javaFound) startLocalServer(newConfig).catch(() => {});
            else stopLocalServer();
        }).catch(() => {
            stopLocalServer();
        });
    } else if (wasLocalServer && !isLocalServer) {
        // Switched AWAY from local-server mode
        stopLocalServer();
    } else if (wasLocalServer && isLocalServer && oldConfig) {
        // Stayed in local-server mode — check if relevant settings changed
        const needsRestart = LOCAL_SERVER_KEYS.some(key => oldConfig[key] !== newConfig[key]);
        if (needsRestart) {
            restartLocalServer(newConfig).catch(() => {});
        }
    }
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
    if (warmupChild) {
        warmupChild.kill();
        warmupChild = null;
    }
    stopLocalServer();
    clearCache();
    clearServerCache();
    clearMdCache();
    clearBrowserCache();
    disposeAllViewers();
    disposePumlPreview();
    disposeMermaidPreview();
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
const builtInPreviewConfig: Config = {
    mode: 'fast',
    plantumlJarPath: '',
    javaPath: 'java',
    dotPath: 'dot',
    plantumlTheme: 'default',
    plantumlScale: '100%',
    previewTheme: 'github-light',
    renderMode: 'local-server',
    plantumlServerUrl: 'https://www.plantuml.com/plantuml',
    plantumlLocalServerPort: 0,
    mermaidTheme: 'default',
    mermaidScale: '80%',
    htmlMaxWidth: '960px',
    htmlAlignment: 'center',
    allowLocalImages: true,
    allowHttpImages: false,
    enableMath: true,
    plantumlIncludePath: '',
    debounceNoDiagramChangeMs: 100,
    debounceDiagramChangeMs: 100,
    debugSimulateNoJava: false,
};

/**
 * Sync builtInPreviewConfig with the current extension settings.
 *
 * @param config - Current extension settings to apply.
 */
function syncBuiltInPreviewConfig(config: Config): void {
    Object.assign(builtInPreviewConfig, config);
}

/**
 * Inject PlantUML rendering into VS Code's built-in Markdown preview.
 *
 * Called by VS Code's markdown.markdownItPlugins contribution point.
 * Uses a mutable config reference that is updated when settings change.
 *
 * @param md - The markdown-it instance provided by VS Code.
 * @returns The same instance with the PlantUML fence rule applied.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
    return plantumlPlugin(md, builtInPreviewConfig);
}
