/**
 * @module reading-view
 * @description Shape shared by the Reading Views of every file kind.
 *
 * A Reading View shows one file in a panel VS Code hands over (a custom editor
 * tab), unlike the preview, which creates its own panel beside the source and
 * follows the active editor. VS Code owns the panel: a Reading View never
 * disposes it.
 */
import type * as vscode from 'vscode';
import type { Config } from './config.js';

/** Kind of file a Reading View shows. */
export type ReadingViewKind = 'markdown' | 'puml' | 'mermaid' | 'd2';

/** A panel VS Code handed over, with the file it shows. */
export interface AdoptedPanel {
    /** The panel of the custom editor tab. */
    panel: vscode.WebviewPanel;
    /** Absolute path of the file the panel shows. */
    filePath: string;
}

/** Members every Reading View has, whatever its kind. */
interface ReadingViewBase {
    /** Kind of file the view shows. */
    readonly kind: ReadingViewKind;
    /** Absolute path of the file shown. */
    filePath(): string;
    /** The panel VS Code handed over. */
    panel(): vscode.WebviewPanel;
    /** Settles when the first render ends, whether or not it drew the file. */
    readonly firstRender: Promise<void>;
    /** Apply a settings change. */
    updateConfig(config: Config): void;
    /** Show the theme QuickPick for this view. */
    changeTheme(): Promise<void>;
    /** Source text of the most recent completed render, or null before the first. */
    getLastRenderedText(): string | null;
    /** Stop listening and rendering; the panel stays with VS Code. */
    dispose(): void;
}

/** A Reading View of a Markdown file. */
export interface MarkdownReadingView extends ReadingViewBase {
    readonly kind: 'markdown';
    /** Whether the diagram right-clicked last was in this view. */
    ownsPendingDiagram(): boolean;
    /** Last scroll instruction handed to the webview (observation point for tests). */
    getLastPostedScroll(): { line: number; maxTopLine: number; atBottom: boolean; force: boolean; instant: boolean } | null;
    /** Deliver a message as if the webview had posted it (tests cannot make it post). */
    dispatchWebviewMessage(message: unknown): void;
}

/** A Reading View of a PlantUML, Mermaid or D2 file. */
export interface DiagramReadingView extends ReadingViewBase {
    readonly kind: 'puml' | 'mermaid' | 'd2';
}

/** One Reading View, as created by the factory of its kind. */
export type ReadingView = MarkdownReadingView | DiagramReadingView;
