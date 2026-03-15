/**
 * @module completion/plantuml-provider
 * @description Completion provider for PlantUML.
 *
 * Provides context-aware keyword suggestions including @start/@end tags,
 * preprocessor directives, skinparam properties, and color names.
 */
import * as vscode from 'vscode';
import type { KeywordContext, KeywordEntry } from './types.js';
import { toCompletionItem } from './types.js';
import { plantumlKeywords } from './plantuml-keywords.js';

/** Completion provider for PlantUML diagrams. */
export class PlantUMLCompletionProvider implements vscode.CompletionItemProvider {
    private readonly keywords = plantumlKeywords;

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

        // After '#' -- color names
        if (before.match(/#\w*$/)) {
            const hashPos = before.lastIndexOf('#');
            const range = new vscode.Range(pos.line, hashPos + 1, pos.line, pos.character);
            return this.getItems('after-hash', range);
        }

        // After 'skinparam ' -- skinparam parameters
        const parentMatch = before.match(/^\s*(skinparam)\s+(\w*)$/i);
        if (parentMatch) {
            return this.getItems('after-parent', undefined, 'skinparam');
        }

        // Line start -- line-start keywords
        if (before.match(/^\s*\S*$/)) {
            // '@' and '!' are outside word boundaries, so set an explicit range
            const prefixMatch = before.match(/^\s*([@!]\S*)$/);
            const range = prefixMatch
                ? new vscode.Range(pos.line, pos.character - prefixMatch[1].length, pos.line, pos.character)
                : undefined;
            return this.getItems('line-start', range);
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
