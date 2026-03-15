import * as vscode from 'vscode';

/** Context in which a keyword is valid. */
export type KeywordContext =
    | 'line-start'      // shown at the beginning of a line (after indentation)
    | 'after-parent'    // shown after a specific keyword + space
    | 'after-hash'      // shown right after '#' (PlantUML color names)
    | 'after-dot'       // shown right after '.' (D2 style properties)
    | 'diagram-type'    // diagram type declaration on the first line (Mermaid)
    ;

/** Keyword definition with context metadata. */
export interface KeywordEntry {
    label: string;
    kind: vscode.CompletionItemKind;
    detail?: string;
    /** Context in which this keyword is valid. */
    context: KeywordContext;
    /** Parent keyword (used when context is 'after-parent'). */
    parent?: string;
    /** Sort priority (lower = higher rank; defaults to 50). */
    sortPriority?: number;
    /** Mermaid only: restrict to a specific diagram type. */
    diagramType?: string;
}

/** Convert a KeywordEntry to a vscode.CompletionItem. */
export function toCompletionItem(entry: KeywordEntry, range?: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(entry.label, entry.kind);
    if (entry.detail) item.detail = entry.detail;
    const priority = entry.sortPriority ?? 50;
    item.sortText = String(priority).padStart(3, '0') + entry.label;
    if (range) item.range = range;
    return item;
}
