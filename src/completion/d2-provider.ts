/**
 * @module completion/d2-provider
 * @description Completion provider for D2 diagrams.
 *
 * Provides context-aware keyword suggestions including line-start keywords,
 * shape/direction/constraint values after colons, and style properties after
 * `style.` prefixes.
 */
import * as vscode from 'vscode';
import type { KeywordContext, KeywordEntry } from './types.js';
import { toCompletionItem } from './types.js';
import { d2Keywords } from './d2-keywords.js';

/** Completion provider for D2 diagrams. */
export class D2CompletionProvider implements vscode.CompletionItemProvider {
    private readonly keywords = d2Keywords;

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

        // After 'style.' -- style properties
        if (before.match(/style\.\w*$/)) {
            const dotPos = before.lastIndexOf('.');
            const range = new vscode.Range(pos.line, dotPos + 1, pos.line, pos.character);
            return this.getItems('after-dot', range);
        }

        // After 'shape:' / 'direction:' / 'constraint:' -- corresponding values
        const colonMatch = before.match(/\b(shape|direction|constraint)\s*:\s*(\w*)$/);
        if (colonMatch) {
            return this.getItems('after-parent', undefined, colonMatch[1]);
        }

        // Line start -- line-start keywords
        if (before.match(/^\s*\S*$/)) {
            return this.getItems('line-start');
        }

        return undefined;
    }

    /**
     * Filter keywords by context and optional parent, returning completion items.
     *
     * @param context - Keyword context to filter by.
     * @param range - Optional replacement range for the completion.
     * @param parent - Optional parent keyword for after-parent context.
     * @returns Filtered completion items.
     */
    private getItems(
        context: KeywordContext,
        range?: vscode.Range,
        parent?: string,
    ): vscode.CompletionItem[] {
        return this.keywords
            .filter((e: KeywordEntry) =>
                e.context === context && (!parent || e.parent === parent),
            )
            .map((e: KeywordEntry) => toCompletionItem(e, range));
    }
}
