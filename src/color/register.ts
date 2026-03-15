import * as vscode from 'vscode';
import { DiagramColorProvider, type DiagramLanguage } from './plantuml-color-provider.js';

export function registerColorProviders(context: vscode.ExtensionContext): void {
    const plantuml = new DiagramColorProvider('plantuml');
    const mermaid = new DiagramColorProvider('mermaid');
    const d2 = new DiagramColorProvider('d2');

    context.subscriptions.push(
        // Standalone files
        vscode.languages.registerColorProvider({ language: 'plantuml' }, plantuml),
        vscode.languages.registerColorProvider({ language: 'mermaid' }, mermaid),
        vscode.languages.registerColorProvider({ language: 'd2' }, d2),
        // Markdown embedded fenced blocks
        vscode.languages.registerColorProvider(
            { language: 'markdown' },
            new MarkdownColorRouter(plantuml, mermaid, d2),
        ),
    );
}

/**
 * Detects fenced code blocks in Markdown and delegates color scanning
 * to the matching DiagramColorProvider.
 */
class MarkdownColorRouter implements vscode.DocumentColorProvider {
    constructor(
        private readonly plantuml: DiagramColorProvider,
        private readonly mermaid: DiagramColorProvider,
        private readonly d2: DiagramColorProvider,
    ) {}

    provideDocumentColors(doc: vscode.TextDocument): vscode.ColorInformation[] {
        const results: vscode.ColorInformation[] = [];
        let currentLang: DiagramLanguage | null = null;
        let blockStart = 0;

        for (let i = 0; i < doc.lineCount; i++) {
            const text = doc.lineAt(i).text;
            if (!currentLang) {
                const open = text.match(/^\s*```(plantuml|mermaid|d2)\s*$/);
                if (open) {
                    currentLang = open[1] as DiagramLanguage;
                    blockStart = i + 1;
                }
            } else if (/^\s*```\s*$/.test(text)) {
                results.push(...this.getProvider(currentLang).scanLines(doc, blockStart, i));
                currentLang = null;
            }
        }
        return results;
    }

    provideColorPresentations(color: vscode.Color): vscode.ColorPresentation[] {
        // All languages use the same #RRGGBB format
        return this.plantuml.provideColorPresentations(color);
    }

    private getProvider(lang: DiagramLanguage): DiagramColorProvider {
        switch (lang) {
            case 'plantuml': return this.plantuml;
            case 'mermaid':  return this.mermaid;
            case 'd2':       return this.d2;
        }
    }
}
