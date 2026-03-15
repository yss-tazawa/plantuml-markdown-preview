import * as vscode from 'vscode';
import { PLANTUML_NAMED_COLORS } from './plantuml-colors.js';

/** #RRGGBB | #RGB | #NamedColor (word boundary) */
const COLOR_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}|[A-Za-z]+)\b/g;

export type DiagramLanguage = 'plantuml' | 'mermaid' | 'd2';

export class DiagramColorProvider implements vscode.DocumentColorProvider {

    constructor(private readonly language: DiagramLanguage) {}

    provideDocumentColors(
        doc: vscode.TextDocument,
    ): vscode.ColorInformation[] {
        return this.scanLines(doc, 0, doc.lineCount);
    }

    provideColorPresentations(
        color: vscode.Color,
    ): vscode.ColorPresentation[] {
        const r = Math.round(color.red * 255);
        const g = Math.round(color.green * 255);
        const b = Math.round(color.blue * 255);
        const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
        return [new vscode.ColorPresentation(hex)];
    }

    /** Scan lines [startLine, endLine) for color values. */
    scanLines(
        doc: vscode.TextDocument,
        startLine: number,
        endLine: number,
    ): vscode.ColorInformation[] {
        const results: vscode.ColorInformation[] = [];

        for (let i = startLine; i < endLine; i++) {
            const text = doc.lineAt(i).text;

            // Skip comment lines per language
            if (this.isComment(text)) continue;

            COLOR_RE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = COLOR_RE.exec(text)) !== null) {
                const raw = match[0].substring(1); // strip '#'
                const color = this.parseColor(raw);
                if (!color) continue;

                const range = new vscode.Range(
                    i, match.index,
                    i, match.index + match[0].length,
                );
                results.push(new vscode.ColorInformation(range, color));
            }
        }
        return results;
    }

    private isComment(line: string): boolean {
        const trimmed = line.trimStart();
        switch (this.language) {
            case 'plantuml': return trimmed.startsWith("'");
            case 'mermaid':  return trimmed.startsWith('%%');
            case 'd2':       return trimmed.startsWith('#');
        }
    }

    private parseColor(raw: string): vscode.Color | undefined {
        // 6-digit hex
        if (/^[0-9a-fA-F]{6}$/.test(raw)) {
            const r = parseInt(raw.substring(0, 2), 16) / 255;
            const g = parseInt(raw.substring(2, 4), 16) / 255;
            const b = parseInt(raw.substring(4, 6), 16) / 255;
            return new vscode.Color(r, g, b, 1);
        }
        // 3-digit hex
        if (/^[0-9a-fA-F]{3}$/.test(raw)) {
            const r = parseInt(raw[0] + raw[0], 16) / 255;
            const g = parseInt(raw[1] + raw[1], 16) / 255;
            const b = parseInt(raw[2] + raw[2], 16) / 255;
            return new vscode.Color(r, g, b, 1);
        }
        // Named color (PlantUML only)
        if (this.language === 'plantuml') {
            const rgb = PLANTUML_NAMED_COLORS.get(raw.toLowerCase());
            if (rgb) {
                return new vscode.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
            }
        }
        return undefined;
    }
}
