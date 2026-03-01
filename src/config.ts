/**
 * @module config
 * @description Unified configuration type and constants.
 *
 * All extension settings are represented by the single {@link Config} interface.
 * Modules import this type to annotate their config parameters — the actual
 * reading of VS Code settings stays in extension.ts (getConfig).
 */

/** Full extension configuration — single flat type used everywhere. */
export interface Config {
    /** Absolute path to the PlantUML jar file. */
    jarPath: string;
    /** Path or command name for the Java executable (default: 'java'). */
    javaPath: string;
    /** Path or command name for the Graphviz dot executable (default: 'dot'). */
    dotPath: string;
    /** PlantUML theme name passed via -theme CLI arg. 'default' means no theme. */
    plantumlTheme: string;
    /** PlantUML diagram scale ('auto', '70%'–'120%'). '100%' = natural size. */
    plantumlScale: string;
    /** Preview theme key (e.g. 'github-light', 'dracula'). */
    previewTheme: string;
    /** Rendering mode: 'local' (Java) or 'server' (HTTP). */
    renderMode: 'local' | 'server';
    /** PlantUML server base URL (e.g. 'https://www.plantuml.com/plantuml'). */
    serverUrl: string;
    /** Mermaid diagram theme (e.g. 'default', 'dark', 'forest'). */
    mermaidTheme: string;
    /** Mermaid diagram scale ('auto' or '50%'–'100%'). */
    mermaidScale: string;
    /** Maximum width of the HTML export body (e.g. '960px', '1200px'). */
    htmlMaxWidth: string;
    /** HTML export body alignment ('center' or 'left'). */
    htmlAlignment: string;
    /** When true, resolve relative image paths in the preview. */
    allowLocalImages: boolean;
    /** When true, allow loading images over HTTP (unencrypted) in the preview CSP. */
    allowHttpImages: boolean;
    /** Debounce delay (ms) when only non-PlantUML content changed. */
    debounceNoPlantUmlMs: number;
    /** Debounce delay (ms) when PlantUML content changed. */
    debouncePlantUmlMs: number;
    /** Hidden debug flag: simulate Java not found, even when installed. */
    debugSimulateNoJava?: boolean;
}

/** VS Code settings section name. */
export const CONFIG_SECTION = 'plantumlMarkdownPreview';
