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

// ---------------------------------------------------------------------------
// JVM heap settings (only applied when spawning the local PlantUML server / mode: fast)
// Design: PlantUML server heap & start-mode spec §1
// ---------------------------------------------------------------------------

/** Heap preset values selectable via the `plantumlLocalServerJvmHeapPreset` setting. */
export type JvmHeapPreset = 'small' | 'medium' | 'large' | 'unlimited' | 'custom';

/**
 * Effective Xms/Xmx (MB) for each named preset. Same values as design §1.1.
 * `unlimited` is not listed here because it adds no flags at all.
 * `custom` uses the numeric keys (Initial/Max heap) instead.
 */
export const JVM_HEAP_PRESETS: Readonly<Record<'small' | 'medium' | 'large', { readonly xmsMb: number; readonly xmxMb: number }>> = {
    small:  { xmsMb: 16, xmxMb: 256 },
    medium: { xmsMb: 16, xmxMb: 512 },
    large:  { xmsMb: 64, xmxMb: 1024 },
};

/**
 * Fixed JVM flags always added for every preset except `unlimited` (design §1.2).
 * Not exposed in the UI. SerialGC suits a single-request local server best and
 * keeps the GC's management structures minimal.
 */
export const JVM_FIXED_FLAGS: readonly string[] = [
    '-XX:+UseSerialGC',
    '-XX:MaxMetaspaceSize=128m',
    '-XX:ReservedCodeCacheSize=64m',
];

/** Heap value validation bounds (design §1.3, matches package.json min/max). */
export const JVM_HEAP_BOUNDS = {
    xmsMin: 8,
    xmsMax: 32768,
    xmxMin: 64,
    xmxMax: 32768,
} as const;

/** Defaults used for the custom preset (match the package.json defaults). */
const JVM_CUSTOM_DEFAULTS = { xmsMb: 16, xmxMb: 512 } as const;

/**
 * Coerce a heap value to an integer, then clamp it to [min, max].
 * The JVM's -Xms/-Xmx accept whole MB only, so a fractional value (e.g. 16.5)
 * hand-edited into settings.json is floored to avoid an invalid arg like -Xms16.5m.
 */
function clampHeap(value: number, min: number, max: number): number {
    return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * Resolve the effective JVM heap argument list from the preset + numeric settings (design §1).
 *
 * - `unlimited`: returns an empty array (defers to JVM ergonomics = exactly the legacy args).
 * - `small`/`medium`/`large`: the table's Xms/Xmx plus the fixed flags.
 * - `custom`: uses the numeric keys. Out-of-range values are clamped; a reversed
 *   Xms > Xmx is made safe by lowering Xms down to Xmx.
 * - Invalid values such as NaN fall back to the defaults (16 / 512).
 *
 * The result is a list of JVM options, so the caller must place it before `-jar`.
 *
 * @param config - Extension settings carrying the heap-related fields.
 * @returns Args like `['-Xms16m', '-Xmx512m', ...fixed flags]`; `[]` for unlimited.
 */
export function resolveJvmHeapArgs(config: Config): string[] {
    const preset = config.plantumlLocalServerJvmHeapPreset;
    if (preset === 'unlimited') return [];

    let xms: number;
    let xmx: number;
    if (preset === 'custom') {
        xms = config.plantumlLocalServerJvmInitialHeapMb;
        xmx = config.plantumlLocalServerJvmMaxHeapMb;
    } else {
        // An unknown preset string falls back to medium (guard against corrupted settings).
        const p = JVM_HEAP_PRESETS[preset] ?? JVM_HEAP_PRESETS.medium;
        xms = p.xmsMb;
        xmx = p.xmxMb;
    }

    // Invalid values fall back to the defaults, then clamp to range (mirrors the UI validation).
    xms = clampHeap(Number.isFinite(xms) ? xms : JVM_CUSTOM_DEFAULTS.xmsMb, JVM_HEAP_BOUNDS.xmsMin, JVM_HEAP_BOUNDS.xmsMax);
    xmx = clampHeap(Number.isFinite(xmx) ? xmx : JVM_CUSTOM_DEFAULTS.xmxMb, JVM_HEAP_BOUNDS.xmxMin, JVM_HEAP_BOUNDS.xmxMax);
    // A reversed Xms > Xmx lowers the initial value to the max; the max is a hard ceiling.
    if (xms > xmx) xms = xmx;

    return [`-Xms${xms}m`, `-Xmx${xmx}m`, ...JVM_FIXED_FLAGS];
}

/**
 * Local server start mode (the `plantumlLocalServerStartMode` setting).
 * - 'on'   : spawn/manage a local server eagerly when the extension activates.
 * - 'lazy' : spawn the local server at the first diagram render (saves memory while idle). Default.
 * - 'off'  : do not spawn; connect to an already-running server at the configured host/port.
 */
export type LocalServerStartMode = 'on' | 'lazy' | 'off';

/** Default start mode when nothing is configured (matches the package.json default). */
export const DEFAULT_START_MODE: LocalServerStartMode = 'lazy';

/**
 * Resolve the effective start mode, honoring the legacy `plantumlLocalServerAutoStart` boolean.
 *
 * Precedence: an explicitly set `plantumlLocalServerStartMode` wins; otherwise the legacy
 * autoStart is read (explicit true -> 'on', explicit false -> 'off'); otherwise the default 'lazy'.
 * "Explicit" means a value actually set by the user (inspect() global/workspace/workspaceFolder),
 * not a package.json default, so an unset StartMode does not mask a user's explicit legacy autoStart.
 * A user who explicitly set autoStart=true intended eager start, so it maps to 'on', not the new default.
 *
 * @param explicitStartMode - User-set StartMode value, or undefined when only the default applies.
 * @param explicitAutoStart - User-set legacy autoStart value, or undefined when unset.
 * @returns The effective start mode.
 */
export function resolveStartMode(
    explicitStartMode: string | undefined,
    explicitAutoStart: boolean | undefined,
): LocalServerStartMode {
    if (explicitStartMode === 'on' || explicitStartMode === 'lazy' || explicitStartMode === 'off') {
        return explicitStartMode;
    }
    if (explicitAutoStart === true) return 'on';
    if (explicitAutoStart === false) return 'off';
    return DEFAULT_START_MODE;
}

/**
 * Whether the extension spawns/manages its own local server (start mode 'on' or 'lazy')
 * rather than connecting to an external one ('off'). Mirrors the old autoStart=true meaning.
 *
 * @param config - Current extension settings.
 * @returns True for managed-server modes, false for external-connect ('off').
 */
export function isManagedServerMode(config: Config): boolean {
    return config.plantumlLocalServerStartMode !== 'off';
}

/**
 * Whether lazy deferral applies for this config (design §2.3): local-server mode with
 * start mode 'lazy'. Only then is spawning deferred to the first render request.
 *
 * @param config - Current extension settings.
 * @returns True when lazy deferral should apply.
 */
export function isLazyDeferralActive(config: Config): boolean {
    return config.renderMode === 'local-server'
        && config.plantumlLocalServerStartMode === 'lazy';
}

/** Display name of the extension's Output channel (vscode.window.createOutputChannel). */
export const OUTPUT_CHANNEL_NAME = 'PlantUML Markdown Preview';

/**
 * Why the local server URL is unavailable at render time, based on the start mode.
 * - 'external-not-found': start mode 'off' — no server was reachable at the configured host/port.
 * - 'managed-failed'    : start mode 'on'/'lazy' — our own spawned server failed to start.
 */
export type ServerUnavailableReason = 'external-not-found' | 'managed-failed';

/**
 * Classify why the local server is unavailable, so callers can show a cause-specific message.
 *
 * @param config - Current extension settings.
 * @returns The unavailability reason implied by the start mode.
 */
export function serverUnavailableReason(config: Config): ServerUnavailableReason {
    return config.plantumlLocalServerStartMode === 'off' ? 'external-not-found' : 'managed-failed';
}

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
    /**
     * How the local PlantUML server is started (resolved from the `plantumlLocalServerStartMode`
     * setting, with the legacy `plantumlLocalServerAutoStart` boolean read through by resolveStartMode).
     * 'on' spawns eagerly on activation, 'lazy' spawns at the first render, 'off' connects to an
     * existing server at plantumlLocalServerHost:plantumlLocalServerPort. Only used in Fast mode.
     */
    plantumlLocalServerStartMode: LocalServerStartMode;
    /**
     * Host to connect to when the start mode is 'off' (e.g. a picoweb server on another machine
     * in the LAN). Ignored for 'on'/'lazy' (spawned servers always bind to 127.0.0.1). Only used in Fast mode.
     */
    plantumlLocalServerHost: string;
    /**
     * JVM heap preset. The effective Xms/Xmx is resolved by resolveJvmHeapArgs().
     * Only applied when spawning the local server (mode: fast).
     */
    plantumlLocalServerJvmHeapPreset: JvmHeapPreset;
    /** Initial heap (-Xms, MB) for the custom preset. Ignored for other presets. */
    plantumlLocalServerJvmInitialHeapMb: number;
    /** Max heap (-Xmx, MB) for the custom preset. Ignored for other presets. */
    plantumlLocalServerJvmMaxHeapMb: number;
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
    /** PDF export scale factor (0.1–2.0). Scales text and diagrams uniformly. */
    pdfScale: number;
    /** Base directory for PlantUML `!include` directives. Empty string = workspace root. */
    plantumlIncludePath: string;
    /** D2 diagram theme name (maps to a themeID internally). */
    d2Theme: string;
    /** D2 layout engine: 'dagre' or 'elk'. */
    d2Layout: string;
    /** D2 diagram scale ('auto', '70%'–'120%'). 'auto' = shrink to fit. */
    d2Scale: string;
    /** Hidden debug flag: simulate Java not found, even when installed. */
    debugSimulateNoJava: boolean;
}

/** Mermaid built-in theme keys, ordered for display. */
export const MERMAID_THEME_KEYS = ['default', 'dark', 'forest', 'neutral', 'base'] as const;

/** Pre-built Set for O(1) validation of Mermaid theme values. */
export const MERMAID_THEME_SET: ReadonlySet<string> = new Set(MERMAID_THEME_KEYS);

/** D2 theme keys ordered for display, with name → themeID mapping. */
export const D2_THEME_KEYS = [
    'Neutral Default', 'Neutral Grey', 'Flagship Terrastruct', 'Cool Classics',
    'Mixed Berry Blue', 'Grape Soda', 'Aubergine', 'Colorblind Clear',
    'Vanilla Nitro Cola', 'Orange Creamsicle', 'Shirley Temple', 'Earth Tones',
    'Everglade Green', 'Buttered Toast',
    'Dark Mauve', 'Dark Flagship Terrastruct',
    'Terminal', 'Terminal Grayscale', 'Origami',
] as const;

/** Map from theme display name to D2 themeID number. */
export const D2_THEME_MAP: ReadonlyMap<string, number> = new Map([
    ['Neutral Default', 0], ['Neutral Grey', 1], ['Flagship Terrastruct', 3],
    ['Cool Classics', 4], ['Mixed Berry Blue', 5], ['Grape Soda', 6],
    ['Aubergine', 7], ['Colorblind Clear', 8],
    ['Vanilla Nitro Cola', 100], ['Orange Creamsicle', 101], ['Shirley Temple', 102],
    ['Earth Tones', 103], ['Everglade Green', 104], ['Buttered Toast', 105],
    ['Dark Mauve', 200], ['Dark Flagship Terrastruct', 201],
    ['Terminal', 300], ['Terminal Grayscale', 301], ['Origami', 302],
]);

/** D2 layout engine keys. */
export const D2_LAYOUT_KEYS = ['dagre', 'elk'] as const;

/** VS Code settings section name. */
export const CONFIG_SECTION = 'plantumlMarkdownPreview';
