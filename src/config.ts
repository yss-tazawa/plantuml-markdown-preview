/**
 * @module config
 * @description Unified configuration type and constants.
 *
 * All extension settings are represented by the single {@link Config} interface.
 * Modules import this type to annotate their config parameters — the actual
 * reading of VS Code settings stays in extension.ts (getConfig).
 */

/** Preset mode values exposed via the `mode` setting. */
export type Mode = 'fast' | 'secure' | 'easy';

/** Properties controlled by the preset mode. */
interface ModePreset {
    readonly renderMode: 'local' | 'server' | 'local-server';
    readonly debounceNoDiagramChangeMs: number;
    readonly debounceDiagramChangeMs: number;
    readonly allowLocalImages: boolean;
}

/** Preset definitions: mode → renderMode + debounce + security defaults. */
export const MODE_PRESETS: Readonly<Record<Mode, ModePreset>> = {
    fast:   { renderMode: 'local-server', debounceNoDiagramChangeMs: 100, debounceDiagramChangeMs: 100, allowLocalImages: true },
    secure: { renderMode: 'local',        debounceNoDiagramChangeMs: 100, debounceDiagramChangeMs: 300, allowLocalImages: false },
    easy:   { renderMode: 'server',       debounceNoDiagramChangeMs: 100, debounceDiagramChangeMs: 300, allowLocalImages: true },
};

/** Full extension configuration — single flat type used everywhere. */
export interface Config {
    /** Preset mode: 'fast' (default), 'secure', or 'easy'. */
    mode: Mode;
    /** Absolute path to the PlantUML jar file. */
    plantumlJarPath: string;
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
    /** Rendering mode resolved from preset: 'local', 'server', or 'local-server'. Not directly configurable. */
    renderMode: 'local' | 'server' | 'local-server';
    /** PlantUML server base URL (e.g. 'https://www.plantuml.com/plantuml'). */
    plantumlServerUrl: string;
    /** Port for the local PlantUML picoweb server. 0 = auto-assign a free port. Only used in Fast mode. */
    plantumlLocalServerPort: number;
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
    /** Debounce delay (ms) when only non-diagram text changed (diagrams served from cache). */
    debounceNoDiagramChangeMs: number;
    /** Debounce delay (ms) when diagram content changed. */
    debounceDiagramChangeMs: number;
    /** When true, enable KaTeX math rendering ($...$ inline, $$...$$ block). */
    enableMath: boolean;
    /** Hidden debug flag: simulate Java not found, even when installed. */
    debugSimulateNoJava?: boolean;
}

/** Mermaid built-in theme keys, ordered for display. */
export const MERMAID_THEME_KEYS = ['default', 'dark', 'forest', 'neutral', 'base'] as const;

/** Pre-built Set for O(1) validation of Mermaid theme values. */
export const MERMAID_THEME_SET: ReadonlySet<string> = new Set(MERMAID_THEME_KEYS);

/** VS Code settings section name. */
export const CONFIG_SECTION = 'plantumlMarkdownPreview';
