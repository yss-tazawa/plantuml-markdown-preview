/**
 * @module plantuml-color-provider
 * @description Color provider for diagram languages (PlantUML, Mermaid, D2).
 *
 * Scans document lines for hex color codes (#RGB, #RRGGBB) and PlantUML named
 * colors, providing inline color swatches and a color picker via the VS Code
 * DocumentColorProvider API.
 */
import * as vscode from 'vscode';
import { PLANTUML_NAMED_COLORS } from './plantuml-colors.js';

/** #RRGGBB | #RGB | #NamedColor (word boundary) */
const COLOR_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}|[A-Za-z]+)\b/g;

/** Supported diagram language identifiers. */
export type DiagramLanguage = 'plantuml' | 'mermaid' | 'd2';

/**
 * Provides inline color swatches and a color picker for diagram files.
 *
 * Supports hex colors (#RGB, #RRGGBB) for all languages and additionally
 * named colors (e.g. #Red, #Blue) for PlantUML.
 */
export class DiagramColorProvider implements vscode.DocumentColorProvider {

    /** @param language - Diagram language this provider instance handles. */
    constructor(private readonly language: DiagramLanguage) {}

    /**
     * Scan the entire document for color values.
     *
     * @param doc - The document to scan.
     * @returns Array of color information entries found in the document.
     */
    provideDocumentColors(
        doc: vscode.TextDocument,
    ): vscode.ColorInformation[] {
        return this.scanLines(doc, 0, doc.lineCount);
    }

    /**
     * Provide a #RRGGBB hex presentation for the given color.
     *
     * @param color - The color selected by the user in the color picker.
     * @returns Array containing a single hex color presentation.
     */
    provideColorPresentations(
        color: vscode.Color,
    ): vscode.ColorPresentation[] {
        const r = Math.round(color.red * 255);
        const g = Math.round(color.green * 255);
        const b = Math.round(color.blue * 255);
        const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
        return [new vscode.ColorPresentation(hex)];
    }

    /**
     * Scan lines [startLine, endLine) for color values.
     *
     * @param doc - The document to scan.
     * @param startLine - First line to scan (inclusive).
     * @param endLine - Last line to scan (exclusive).
     * @returns Array of color information entries found in the range.
     */
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

    /**
     * Check whether a line is a comment in the current diagram language.
     *
     * @param line - Raw line text from the document.
     * @returns `true` if the line is a comment.
     */
    private isComment(line: string): boolean {
        const trimmed = line.trimStart();
        switch (this.language) {
            case 'plantuml': return trimmed.startsWith("'");
            case 'mermaid':  return trimmed.startsWith('%%');
            case 'd2':       return /^#(\s|$)/.test(trimmed);
        }
    }

    /**
     * Parse a raw color string (without the leading '#') into a VS Code Color.
     *
     * @param raw - Color string: 6-digit hex, 3-digit hex, or named color.
     * @returns Parsed Color, or `undefined` if the string is not a valid color.
     */
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
