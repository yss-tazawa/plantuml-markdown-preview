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
import { prepareLocalServer, startLocalServer, stopLocalServer, restartLocalServer, setLocalServerOutputChannel } from './src/local-server.js';
import { openPreview, getCurrentFilePath, updateConfig, changeTheme, disposePreview, setOutputChannel } from './src/preview.js';
import { execJava } from './src/utils.js';
import { CONFIG_SECTION, MODE_PRESETS, type Config, type Mode } from './src/config.js';
import type MarkdownIt from 'markdown-it';

/** Resolve the allowLocalImages tri-state ('mode-default' | 'on' | 'off') to a boolean. */
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
        plantumlJarPath: userJarPath || resolveBundledJarPath(),
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

/**
 * Validate the Markdown file path, verify jarPath setting, and run HTML export.
 *
 * Shows user-facing error messages when validation fails (not .md, jarPath not set).
 *
 * @param [uri] - URI passed from a command invocation.
 * @returns Absolute path of the generated HTML file, or null on failure.
 */
async function runExport(uri?: vscode.Uri): Promise<string | null> {
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
        return await exportToHtml(filePath, config);
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
    execFile(cmd, [filePath], () => { /* explorer.exe returns exit code 1 on success; ignore all errors */ });
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

    const javaFound = await new Promise<boolean>((resolve) => {
        if (config.debugSimulateNoJava) { resolve(false); return; }
        javaCheckChild = execJava(config.javaPath, ['-version'], { timeout: 5000 }, (err) => {
            javaCheckChild = null;
            resolve(!err);
        });
    });
    if (javaFound) return true;

    const useEasy = vscode.l10n.t('Use Easy Mode');
    const installJava = vscode.l10n.t('Install Java');
    const dismiss = vscode.l10n.t('Dismiss');

    const action = await vscode.window.showWarningMessage(
        vscode.l10n.t('Java is not found. PlantUML requires Java for local rendering.'),
        useEasy, installJava, dismiss
    );

    if (action === useEasy) {
        const serverUrl = config.plantumlServerUrl || 'https://www.plantuml.com/plantuml';
        const yesLabel = vscode.l10n.t('Yes, switch to Easy mode');
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('Easy mode sends diagram source to an external server ({0}). Continue?', serverUrl),
            yesLabel,
            vscode.l10n.t('Cancel')
        );
        if (confirm === yesLabel) {
            const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
            await cfg.update('mode', 'easy', vscode.ConfigurationTarget.Global);
        }
    } else if (action === installJava) {
        void vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/'));
    }
    return false;
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
    lastKnownConfig = initialConfig;
    syncBuiltInPreviewConfig(initialConfig);

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
                    await openPreview(filePath, config, true, true);
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
        if (event.affectsConfiguration(CONFIG_SECTION)) {
            const config = getConfig();

            // Manage local-server lifecycle on config change
            handleLocalServerConfigChange(lastKnownConfig, config);
            lastKnownConfig = config;

            updateConfig(config);
            syncBuiltInPreviewConfig(config);
        }
    });

    context.subscriptions.push(exportCmd, exportAndOpenCmd, previewCmd, changeThemeCmd, editorTracker, configWatcher);

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

    // Warm up JVM/JAR file cache in the background so the first render is faster.
    // On Windows, cold-starting the JVM loads java.exe + plantuml.jar from disk;
    // this fire-and-forget call primes the OS file cache before the user opens preview.
    // Only for 'local' mode — 'local-server' has its own startup, 'server' doesn't need Java.
    if (initialConfig.renderMode === 'local' && initialConfig.plantumlJarPath) {
        warmupChild = execJava(initialConfig.javaPath, ['-jar', initialConfig.plantumlJarPath, '-version'],
            { timeout: 30000 }, (_err) => { warmupChild = null; /* errors are expected when Java is missing */ });
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
    debounceNoDiagramChangeMs: 100,
    debounceDiagramChangeMs: 100,
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
