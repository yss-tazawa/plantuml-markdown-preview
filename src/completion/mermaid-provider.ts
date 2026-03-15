import * as vscode from 'vscode';
import type { KeywordContext, KeywordEntry } from './types.js';
import { toCompletionItem } from './types.js';
import { mermaidKeywords } from './mermaid-keywords.js';

export class MermaidCompletionProvider implements vscode.CompletionItemProvider {
    private readonly keywords = mermaidKeywords;

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

    /** Find the first content line of the block (line after the fence, or line 0). */
    private findBlockStart(doc: vscode.TextDocument, line: number): number {
        for (let i = line; i >= 0; i--) {
            if (doc.lineAt(i).text.match(/^\s*```mermaid\s*$/)) {
                return i + 1;
            }
        }
        return 0;
    }

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

    private isFirstContentLine(doc: vscode.TextDocument, line: number, blockStart: number): boolean {
        for (let i = blockStart; i < line; i++) {
            if (doc.lineAt(i).text.trim()) {
                return false;
            }
        }
        return true;
    }

    private getItems(
        context: KeywordContext,
        range?: vscode.Range,
        parent?: string,
        diagramType?: string,
    ): vscode.CompletionItem[] {
        return this.keywords
            .filter((e: KeywordEntry) => {
                if (e.context !== context) return false;
                if (parent && e.parent !== parent) return false;
                if (context === 'line-start' && e.diagramType && e.diagramType !== diagramType) {
                    if (!(diagramType === 'graph' && e.diagramType === 'flowchart')) return false;
                }
                return true;
            })
            .map((e: KeywordEntry) => toCompletionItem(e, range));
    }
}
