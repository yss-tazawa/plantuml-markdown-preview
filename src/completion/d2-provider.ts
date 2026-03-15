import * as vscode from 'vscode';
import type { KeywordContext, KeywordEntry } from './types.js';
import { toCompletionItem } from './types.js';
import { d2Keywords } from './d2-keywords.js';

export class D2CompletionProvider implements vscode.CompletionItemProvider {
    private readonly keywords = d2Keywords;

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
