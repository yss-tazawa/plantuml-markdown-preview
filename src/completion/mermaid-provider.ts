/**
 * @module completion/mermaid-provider
 * @description Completion provider for Mermaid diagrams.
 *
 * Provides context-aware keyword suggestions including diagram type
 * declarations, diagram-specific keywords (flowchart, sequence, class, etc.),
 * and direction values.
 */
import * as vscode from 'vscode';
import type { KeywordContext } from './types.js';
import { DIAGRAM_FENCE_OPEN_RE, DIAGRAM_FENCE_CLOSE_RE } from '../utils.js';
import { toCompletionItem } from './types.js';
import { mermaidKeywords } from './mermaid-keywords.js';

/** Completion provider for Mermaid diagrams. */
export class MermaidCompletionProvider implements vscode.CompletionItemProvider {
    private readonly keywords = mermaidKeywords;

    /**
     * Provide completion items based on the cursor context.
     *
     * @param doc - The active text document.
     * @param pos - The cursor position.
     * @returns Completion items, or `undefined` if no completions apply.
     */
    provideCompletionItems(
        doc: vscode.TextDocument,
        pos: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        const line = doc.lineAt(pos.line).text;
        const before = line.substring(0, pos.character);
        const blockStart = this.findBlockStart(doc, pos.line);

        // First content line -- diagram type declaration
        if (this.isFirstContentLine(doc, pos.line, blockStart)) {
            return this.getItems('diagram-type');
        }

        // After 'direction '
        const dirMatch = before.match(/^\s*direction\s+(\w*)$/i);
        if (dirMatch) {
            return this.getItems('after-parent', undefined, 'direction');
        }

        // Line start -- keywords for the current diagram type
        if (before.match(/^\s*\S*$/)) {
            const diagramType = this.detectDiagramType(doc, blockStart);
            return this.getItems('line-start', undefined, undefined, diagramType);
        }

        return undefined;
    }

    /**
     * Find the first content line of the block (line after the fence, or line 0).
     *
     * @param doc - The active text document.
     * @param line - The current cursor line.
     * @returns Line number of the first content line in the block.
     */
    private findBlockStart(doc: vscode.TextDocument, line: number): number {
        for (let i = line; i >= 0; i--) {
            const text = doc.lineAt(i).text;
            if (text.match(DIAGRAM_FENCE_OPEN_RE)?.[1] === 'mermaid') return i + 1;
            if (i < line && DIAGRAM_FENCE_CLOSE_RE.test(text)) return 0;
        }
        return 0;
    }

    /**
     * Detect the Mermaid diagram type from the first non-empty line after block start.
     *
     * @param doc - The active text document.
     * @param blockStart - Line number of the first content line in the block.
     * @returns Diagram type identifier, or `undefined` if not detected.
     */
    private detectDiagramType(doc: vscode.TextDocument, blockStart: number): string | undefined {
        for (let i = blockStart; i < Math.min(doc.lineCount, blockStart + 5); i++) {
            const text = doc.lineAt(i).text.trim();
            if (text) {
                const match = text.match(
                    /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph)/,
                );
                return match?.[1];
            }
        }
        return undefined;
    }

    /**
     * Check whether the given line is the first non-empty line in the block.
     *
     * @param doc - The active text document.
     * @param line - The current cursor line.
     * @param blockStart - Line number of the first content line in the block.
     * @returns `true` if no non-empty lines exist between blockStart and line.
     */
    private isFirstContentLine(doc: vscode.TextDocument, line: number, blockStart: number): boolean {
        for (let i = blockStart; i < line; i++) {
            if (doc.lineAt(i).text.trim()) {
                return false;
            }
        }
        return true;
    }

    /**
     * Filter keywords by context, parent, and diagram type, returning completion items.
     *
     * @param context - Keyword context to filter by.
     * @param range - Optional replacement range for the completion.
     * @param parent - Optional parent keyword for after-parent context.
     * @param diagramType - Optional Mermaid diagram type to filter keywords.
     * @returns Filtered completion items.
     */
    private getItems(
        context: KeywordContext,
        range?: vscode.Range,
        parent?: string,
        diagramType?: string,
    ): vscode.CompletionItem[] {
        return this.keywords
            .filter(e => {
                if (e.context !== context) return false;
                if (parent && e.parent !== parent) return false;
                if (context === 'line-start' && e.diagramType && e.diagramType !== diagramType) {
                    if (!(diagramType === 'graph' && e.diagramType === 'flowchart')) return false;
                }
                return true;
            })
            .map(e => toCompletionItem(e, range));
    }
}
