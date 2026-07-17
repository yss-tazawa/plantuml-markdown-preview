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
// JVM ヒープ設定（ローカル PlantUML サーバー起動時のみ適用 / mode: fast）
// 設計書: PlantUMLサーバ_ヒープ設定と起動モード.md §1
// ---------------------------------------------------------------------------

/** `plantumlLocalServerJvmHeapPreset` 設定で選べるヒーププリセット値。 */
export type JvmHeapPreset = 'small' | 'medium' | 'large' | 'unlimited' | 'custom';

/**
 * 名前付きプリセットの実効 Xms/Xmx（MB）。設計書 §1.1 と同一値。
 * `unlimited` は一切フラグを付けないため表に含めない。
 * `custom` は数値キー（Initial/Max heap）を使う。
 */
export const JVM_HEAP_PRESETS: Readonly<Record<'small' | 'medium' | 'large', { readonly xmsMb: number; readonly xmxMb: number }>> = {
    small:  { xmsMb: 16, xmxMb: 256 },
    medium: { xmsMb: 16, xmxMb: 512 },
    large:  { xmsMb: 64, xmxMb: 1024 },
};

/**
 * `unlimited` 以外で常に付与する固定 JVM フラグ（設計書 §1.2）。UI には露出しない。
 * SerialGC はローカルの単一リクエストサーバーに最適・管理構造が最小。
 */
export const JVM_FIXED_FLAGS: readonly string[] = [
    '-XX:+UseSerialGC',
    '-XX:MaxMetaspaceSize=128m',
    '-XX:ReservedCodeCacheSize=64m',
];

/** ヒープ数値のバリデーション範囲（設計書 §1.3、package.json の min/max と一致）。 */
export const JVM_HEAP_BOUNDS = {
    xmsMin: 8,
    xmsMax: 32768,
    xmxMin: 64,
    xmxMax: 32768,
} as const;

/** custom 選択時のデフォルト（package.json の default と一致）。 */
const JVM_CUSTOM_DEFAULTS = { xmsMb: 16, xmxMb: 512 } as const;

/**
 * ヒープ値を整数化してから [min, max] にクランプする。
 * JVM の -Xms/-Xmx は整数 MB のみ受け付けるため、settings.json 手編集で
 * 小数（例 16.5）が入っても Math.floor で切り捨てて不正引数（-Xms16.5m）を防ぐ。
 */
function clampHeap(value: number, min: number, max: number): number {
    return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * プリセット＋数値設定から、実効 JVM ヒープ引数列を解決する（設計書 §1）。
 *
 * - `unlimited`: 空配列を返す（JVM エルゴノミクス任せ ＝ 現行と完全に同一の引数）。
 * - `small`/`medium`/`large`: 表の Xms/Xmx ＋ 固定フラグ。
 * - `custom`: 数値キーを使用。範囲外はクランプ、Xms>Xmx の逆転は Xms を Xmx まで下げて安全化。
 * - NaN 等の不正値はデフォルト（16 / 512）に落とす。
 *
 * 返り値は JVM オプションなので、呼び出し側で必ず `-jar` より前に置くこと。
 *
 * @param config - ヒープ関連フィールドを持つ拡張設定。
 * @returns `['-Xms16m', '-Xmx512m', ...固定フラグ]` 形式の引数列。unlimited は `[]`。
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
        // 未知のプリセット文字列は medium にフォールバック（設定破損への保険）。
        const p = JVM_HEAP_PRESETS[preset] ?? JVM_HEAP_PRESETS.medium;
        xms = p.xmsMb;
        xmx = p.xmxMb;
    }

    // 不正値はデフォルトへ、その後で範囲クランプ（UI 検証の二重化）。
    xms = clampHeap(Number.isFinite(xms) ? xms : JVM_CUSTOM_DEFAULTS.xmsMb, JVM_HEAP_BOUNDS.xmsMin, JVM_HEAP_BOUNDS.xmsMax);
    xmx = clampHeap(Number.isFinite(xmx) ? xmx : JVM_CUSTOM_DEFAULTS.xmxMb, JVM_HEAP_BOUNDS.xmxMin, JVM_HEAP_BOUNDS.xmxMax);
    // 逆転（Xms>Xmx）は初期値を最大値まで下げる。最大値はハード上限なので超えさせない。
    if (xms > xmx) xms = xmx;

    return [`-Xms${xms}m`, `-Xmx${xmx}m`, ...JVM_FIXED_FLAGS];
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
     * When true (default), the extension spawns and manages its own local picoweb server (bound to 127.0.0.1).
     * When false, the extension does not spawn a server and instead connects to an existing one at
     * plantumlLocalServerHost:plantumlLocalServerPort. Only used in Fast mode.
     */
    plantumlLocalServerAutoStart: boolean;
    /**
     * Host to connect to when plantumlLocalServerAutoStart is false (e.g. a picoweb server on another
     * machine in the LAN). Ignored when auto-starting (spawned servers always bind to 127.0.0.1). Only used in Fast mode.
     */
    plantumlLocalServerHost: string;
    /**
     * JVM ヒーププリセット。実効 Xms/Xmx は resolveJvmHeapArgs() で解決する。
     * ローカルサーバーを spawn するとき（mode: fast）のみ適用。
     */
    plantumlLocalServerJvmHeapPreset: JvmHeapPreset;
    /** custom プリセット時の初期ヒープ（-Xms, MB）。他プリセットでは無視される。 */
    plantumlLocalServerJvmInitialHeapMb: number;
    /** custom プリセット時の最大ヒープ（-Xmx, MB）。他プリセットでは無視される。 */
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
