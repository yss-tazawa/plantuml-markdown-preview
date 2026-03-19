/**
 * @module completion/register
 * @description Registers completion providers for diagram languages.
 *
 * Sets up CompletionItemProvider instances for standalone PlantUML, Mermaid,
 * and D2 files, plus a Markdown router that delegates to the correct provider
 * based on the fenced code block language surrounding the cursor.
 */
import * as vscode from 'vscode';
import { PlantUMLCompletionProvider } from './plantuml-provider.js';
import { MermaidCompletionProvider } from './mermaid-provider.js';
import { D2CompletionProvider } from './d2-provider.js';
import { DIAGRAM_FENCE_OPEN_RE, DIAGRAM_FENCE_CLOSE_RE } from '../utils.js';

/**
 * Register completion providers for all supported diagram languages.
 *
 * @param context - Extension context for disposable management.
 */
export function registerCompletionProviders(context: vscode.ExtensionContext): void {
    const plantuml = new PlantUMLCompletionProvider();
    const mermaid = new MermaidCompletionProvider();
    const d2 = new D2CompletionProvider();

    context.subscriptions.push(
        // Standalone files
        vscode.languages.registerCompletionItemProvider(
            { language: 'plantuml' },
            plantuml,
            '@', '!', '#',
        ),
        vscode.languages.registerCompletionItemProvider(
            { language: 'mermaid' },
            mermaid,
        ),
        vscode.languages.registerCompletionItemProvider(
            { language: 'd2' },
            d2,
            ':', '.',
        ),
        // Markdown embedded blocks
        vscode.languages.registerCompletionItemProvider(
            { language: 'markdown' },
            new MarkdownCompletionRouter(plantuml, mermaid, d2),
            '@', '!', '#', ':', '.',
        ),
    );
}

/**
 * Detects fenced code blocks in Markdown and routes to the appropriate provider.
 */
class MarkdownCompletionRouter implements vscode.CompletionItemProvider {
    constructor(
        private readonly plantuml: PlantUMLCompletionProvider,
        private readonly mermaid: MermaidCompletionProvider,
        private readonly d2: D2CompletionProvider,
    ) {}

    /**
     * Provide completion items for the cursor position inside a diagram fence.
     * @param doc - The Markdown document.
     * @param pos - The cursor position.
     * @returns Completion items, or undefined if outside a diagram block.
     */
    provideCompletionItems(
        doc: vscode.TextDocument,
        pos: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        const lang = this.detectFencedLanguage(doc, pos.line);
        if (!lang) return undefined;

        // Delegate to the matching provider
        switch (lang) {
            case 'plantuml': return this.plantuml.provideCompletionItems(doc, pos);
            case 'mermaid': return this.mermaid.provideCompletionItems(doc, pos);
            case 'd2': return this.d2.provideCompletionItems(doc, pos);
            default: return undefined;
        }
    }

    /**
     * Search upward from the cursor line for a fenced diagram block opener.
     * @param doc - The Markdown document to search.
     * @param line - The current cursor line index.
     * @returns Language identifier string, or undefined if outside a diagram block.
     */
    private detectFencedLanguage(doc: vscode.TextDocument, line: number): string | undefined {
        for (let i = line; i >= 0; i--) {
            const text = doc.lineAt(i).text;
            const open = text.match(DIAGRAM_FENCE_OPEN_RE);
            if (open) return open[1];
            // Hit a closing fence -- outside any block (including cursor line itself)
            if (DIAGRAM_FENCE_CLOSE_RE.test(text)) return undefined;
        }
        return undefined;
    }
}
