/**
 * @module completion/mermaid-keywords
 * @description Mermaid keyword definitions for completion.
 *
 * Contains keyword entries for diagram type declarations, flowchart/graph
 * keywords, sequence diagram keywords, class/state/ER diagrams, direction
 * values, and more.
 */
import * as vscode from 'vscode';
import type { KeywordEntry } from './types.js';

const K = vscode.CompletionItemKind.Keyword;
const P = vscode.CompletionItemKind.Property;

export const mermaidKeywords: readonly KeywordEntry[] = [
    // --- diagram-type (first line declarations) ---
    { label: 'flowchart', kind: K, context: 'diagram-type', detail: 'Flowchart', sortPriority: 10 },
    { label: 'graph', kind: K, context: 'diagram-type', detail: 'Graph (flowchart)', sortPriority: 10 },
    { label: 'sequenceDiagram', kind: K, context: 'diagram-type', detail: 'Sequence diagram', sortPriority: 10 },
    { label: 'classDiagram', kind: K, context: 'diagram-type', detail: 'Class diagram', sortPriority: 10 },
    { label: 'stateDiagram-v2', kind: K, context: 'diagram-type', detail: 'State diagram', sortPriority: 10 },
    { label: 'erDiagram', kind: K, context: 'diagram-type', detail: 'ER diagram', sortPriority: 10 },
    { label: 'gantt', kind: K, context: 'diagram-type', detail: 'Gantt chart', sortPriority: 10 },
    { label: 'pie', kind: K, context: 'diagram-type', detail: 'Pie chart', sortPriority: 10 },
    { label: 'mindmap', kind: K, context: 'diagram-type', detail: 'Mind map', sortPriority: 10 },
    { label: 'timeline', kind: K, context: 'diagram-type', detail: 'Timeline', sortPriority: 10 },
    { label: 'gitGraph', kind: K, context: 'diagram-type', detail: 'Git graph', sortPriority: 10 },
    { label: 'quadrantChart', kind: K, context: 'diagram-type', detail: 'Quadrant chart', sortPriority: 10 },
    { label: 'sankey-beta', kind: K, context: 'diagram-type', detail: 'Sankey diagram', sortPriority: 10 },
    { label: 'xychart-beta', kind: K, context: 'diagram-type', detail: 'XY chart', sortPriority: 10 },

    // --- Common keywords ---
    { label: 'title', kind: K, context: 'line-start', detail: 'Diagram title' },
    { label: '%%{init:', kind: K, context: 'line-start', detail: 'Init directive', sortPriority: 20 },

    // --- flowchart / graph ---
    { label: 'subgraph', kind: K, context: 'line-start', detail: 'Subgraph', diagramType: 'flowchart' },
    { label: 'end', kind: K, context: 'line-start', detail: 'End block', diagramType: 'flowchart' },
    { label: 'style', kind: K, context: 'line-start', detail: 'Node style', diagramType: 'flowchart' },
    { label: 'classDef', kind: K, context: 'line-start', detail: 'Define class', diagramType: 'flowchart' },
    { label: 'class', kind: K, context: 'line-start', detail: 'Apply class', diagramType: 'flowchart' },
    { label: 'linkStyle', kind: K, context: 'line-start', detail: 'Link style', diagramType: 'flowchart' },
    { label: 'click', kind: K, context: 'line-start', detail: 'Click handler', diagramType: 'flowchart' },
    { label: 'direction', kind: K, context: 'line-start', detail: 'Flow direction', diagramType: 'flowchart' },

    // --- sequenceDiagram ---
    { label: 'actor', kind: K, context: 'line-start', detail: 'Actor', diagramType: 'sequenceDiagram' },
    { label: 'participant', kind: K, context: 'line-start', detail: 'Participant', diagramType: 'sequenceDiagram' },
    { label: 'activate', kind: K, context: 'line-start', detail: 'Activate', diagramType: 'sequenceDiagram' },
    { label: 'deactivate', kind: K, context: 'line-start', detail: 'Deactivate', diagramType: 'sequenceDiagram' },
    { label: 'Note', kind: K, context: 'line-start', detail: 'Note', diagramType: 'sequenceDiagram' },
    { label: 'alt', kind: K, context: 'line-start', detail: 'Alternative', diagramType: 'sequenceDiagram' },
    { label: 'else', kind: K, context: 'line-start', detail: 'Else branch', diagramType: 'sequenceDiagram' },
    { label: 'end', kind: K, context: 'line-start', detail: 'End block', diagramType: 'sequenceDiagram' },
    { label: 'loop', kind: K, context: 'line-start', detail: 'Loop', diagramType: 'sequenceDiagram' },
    { label: 'par', kind: K, context: 'line-start', detail: 'Parallel', diagramType: 'sequenceDiagram' },
    { label: 'and', kind: K, context: 'line-start', detail: 'And (parallel)', diagramType: 'sequenceDiagram' },
    { label: 'opt', kind: K, context: 'line-start', detail: 'Optional', diagramType: 'sequenceDiagram' },
    { label: 'critical', kind: K, context: 'line-start', detail: 'Critical', diagramType: 'sequenceDiagram' },
    { label: 'break', kind: K, context: 'line-start', detail: 'Break', diagramType: 'sequenceDiagram' },
    { label: 'rect', kind: K, context: 'line-start', detail: 'Rectangle highlight', diagramType: 'sequenceDiagram' },
    { label: 'autonumber', kind: K, context: 'line-start', detail: 'Auto numbering', diagramType: 'sequenceDiagram' },
    { label: 'box', kind: K, context: 'line-start', detail: 'Box grouping', diagramType: 'sequenceDiagram' },

    // --- classDiagram ---
    { label: 'class', kind: K, context: 'line-start', detail: 'Class', diagramType: 'classDiagram' },
    { label: 'namespace', kind: K, context: 'line-start', detail: 'Namespace', diagramType: 'classDiagram' },
    { label: 'note', kind: K, context: 'line-start', detail: 'Note', diagramType: 'classDiagram' },

    // --- stateDiagram-v2 ---
    { label: 'state', kind: K, context: 'line-start', detail: 'State', diagramType: 'stateDiagram-v2' },
    { label: 'note', kind: K, context: 'line-start', detail: 'Note', diagramType: 'stateDiagram-v2' },

    // --- gantt ---
    { label: 'dateFormat', kind: K, context: 'line-start', detail: 'Date format', diagramType: 'gantt' },
    { label: 'axisFormat', kind: K, context: 'line-start', detail: 'Axis format', diagramType: 'gantt' },
    { label: 'section', kind: K, context: 'line-start', detail: 'Section', diagramType: 'gantt' },
    { label: 'excludes', kind: K, context: 'line-start', detail: 'Exclude dates', diagramType: 'gantt' },
    { label: 'todayMarker', kind: K, context: 'line-start', detail: 'Today marker', diagramType: 'gantt' },
    { label: 'tickInterval', kind: K, context: 'line-start', detail: 'Tick interval', diagramType: 'gantt' },

    // --- direction values (after-parent) ---
    { label: 'TB', kind: P, context: 'after-parent', parent: 'direction', detail: 'Top to bottom' },
    { label: 'TD', kind: P, context: 'after-parent', parent: 'direction', detail: 'Top down' },
    { label: 'BT', kind: P, context: 'after-parent', parent: 'direction', detail: 'Bottom to top' },
    { label: 'RL', kind: P, context: 'after-parent', parent: 'direction', detail: 'Right to left' },
    { label: 'LR', kind: P, context: 'after-parent', parent: 'direction', detail: 'Left to right' },
];
