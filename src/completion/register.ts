import * as vscode from 'vscode';
import { PlantUMLCompletionProvider } from './plantuml-provider.js';
import { MermaidCompletionProvider } from './mermaid-provider.js';
import { D2CompletionProvider } from './d2-provider.js';

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

    /** Search upward from the cursor line for a fenced block opener and return its language ID. */
    private detectFencedLanguage(doc: vscode.TextDocument, line: number): string | undefined {
        for (let i = line; i >= 0; i--) {
            const text = doc.lineAt(i).text;
            const open = text.match(/^\s*```(plantuml|mermaid|d2)\s*$/);
            if (open) return open[1];
            // Hit a closing fence -- outside any block
            if (i < line && text.match(/^\s*```\s*$/)) return undefined;
        }
        return undefined;
    }
}
