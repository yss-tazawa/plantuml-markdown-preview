/**
 * @module completion/d2-keywords
 * @description D2 keyword definitions for completion.
 *
 * Contains keyword entries for line-start keywords, direction values,
 * shape types, constraint values, and style properties.
 */
import * as vscode from 'vscode';
import type { KeywordEntry } from './types.js';

const K = vscode.CompletionItemKind.Keyword;
const P = vscode.CompletionItemKind.Property;

export const d2Keywords: readonly KeywordEntry[] = [
    // --- line-start (structural keywords) ---
    { label: 'direction', kind: K, context: 'line-start', detail: 'Layout direction' },
    { label: 'grid-rows', kind: K, context: 'line-start', detail: 'Grid rows' },
    { label: 'grid-columns', kind: K, context: 'line-start', detail: 'Grid columns' },
    { label: 'layers', kind: K, context: 'line-start', detail: 'Layers' },
    { label: 'scenarios', kind: K, context: 'line-start', detail: 'Scenarios' },
    { label: 'steps', kind: K, context: 'line-start', detail: 'Steps' },
    { label: 'classes', kind: K, context: 'line-start', detail: 'Classes' },

    // --- line-start (node property names) ---
    { label: 'shape', kind: P, context: 'line-start', detail: 'Node shape' },
    { label: 'tooltip', kind: P, context: 'line-start', detail: 'Tooltip text' },
    { label: 'link', kind: P, context: 'line-start', detail: 'Hyperlink' },
    { label: 'icon', kind: P, context: 'line-start', detail: 'Icon URL' },
    { label: 'label', kind: P, context: 'line-start', detail: 'Display label' },
    { label: 'near', kind: P, context: 'line-start', detail: 'Position near' },
    { label: 'width', kind: P, context: 'line-start', detail: 'Width' },
    { label: 'height', kind: P, context: 'line-start', detail: 'Height' },

    // --- direction values (after-parent) ---
    { label: 'right', kind: P, context: 'after-parent', parent: 'direction' },
    { label: 'down', kind: P, context: 'after-parent', parent: 'direction' },
    { label: 'left', kind: P, context: 'after-parent', parent: 'direction' },
    { label: 'up', kind: P, context: 'after-parent', parent: 'direction' },

    // --- shape values (after-parent) ---
    { label: 'rectangle', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'square', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'page', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'parallelogram', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'document', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'cylinder', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'queue', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'package', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'step', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'callout', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'stored_data', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'person', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'diamond', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'oval', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'circle', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'hexagon', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'cloud', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'text', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'code', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'class', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'sql_table', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'image', kind: P, context: 'after-parent', parent: 'shape' },
    { label: 'sequence_diagram', kind: P, context: 'after-parent', parent: 'shape' },

    // --- constraint values (after-parent) ---
    { label: 'primary_key', kind: P, context: 'after-parent', parent: 'constraint' },
    { label: 'foreign_key', kind: P, context: 'after-parent', parent: 'constraint' },
    { label: 'unique', kind: P, context: 'after-parent', parent: 'constraint' },

    // --- style properties (after-dot) ---
    { label: 'fill', kind: P, context: 'after-dot', detail: 'Fill color' },
    { label: 'stroke', kind: P, context: 'after-dot', detail: 'Stroke color' },
    { label: 'stroke-width', kind: P, context: 'after-dot', detail: 'Stroke width' },
    { label: 'stroke-dash', kind: P, context: 'after-dot', detail: 'Dash pattern' },
    { label: 'border-radius', kind: P, context: 'after-dot', detail: 'Border radius' },
    { label: 'opacity', kind: P, context: 'after-dot', detail: 'Opacity' },
    { label: 'font-size', kind: P, context: 'after-dot', detail: 'Font size' },
    { label: 'font-color', kind: P, context: 'after-dot', detail: 'Font color' },
    { label: 'font', kind: P, context: 'after-dot', detail: 'Font family' },
    { label: 'shadow', kind: P, context: 'after-dot', detail: 'Shadow' },
    { label: '3d', kind: P, context: 'after-dot', detail: '3D effect' },
    { label: 'multiple', kind: P, context: 'after-dot', detail: 'Multiple instances' },
    { label: 'animated', kind: P, context: 'after-dot', detail: 'Animated' },
    { label: 'bold', kind: P, context: 'after-dot', detail: 'Bold text' },
    { label: 'italic', kind: P, context: 'after-dot', detail: 'Italic text' },
    { label: 'underline', kind: P, context: 'after-dot', detail: 'Underlined text' },
    { label: 'double-border', kind: P, context: 'after-dot', detail: 'Double border' },
    { label: 'text-transform', kind: P, context: 'after-dot', detail: 'Text transform' },
];
