/**
 * @module completion/plantuml-keywords
 * @description PlantUML keyword definitions for completion.
 *
 * Contains keyword entries for @start/@end tags, participant types, control
 * flow, structure, formatting, activity, notes, preprocessor directives,
 * skinparam properties, and color names.
 */
import * as vscode from 'vscode';
import type { KeywordEntry } from './types.js';
import { PLANTUML_NAMED_COLORS } from '../color/plantuml-colors.js';

const K = vscode.CompletionItemKind.Keyword;
const P = vscode.CompletionItemKind.Property;
const C = vscode.CompletionItemKind.Color;

export const plantumlKeywords: readonly KeywordEntry[] = [
    // --- @start / @end ---
    { label: '@startuml', kind: K, context: 'line-start', detail: 'UML diagram', sortPriority: 10 },
    { label: '@startmindmap', kind: K, context: 'line-start', detail: 'Mind map', sortPriority: 10 },
    { label: '@startjson', kind: K, context: 'line-start', detail: 'JSON data', sortPriority: 10 },
    { label: '@startyaml', kind: K, context: 'line-start', detail: 'YAML data', sortPriority: 10 },
    { label: '@startsalt', kind: K, context: 'line-start', detail: 'Salt UI mockup', sortPriority: 10 },
    { label: '@startdot', kind: K, context: 'line-start', detail: 'Graphviz DOT', sortPriority: 10 },
    { label: '@startditaa', kind: K, context: 'line-start', detail: 'Ditaa diagram', sortPriority: 10 },
    { label: '@startlatex', kind: K, context: 'line-start', detail: 'LaTeX math', sortPriority: 10 },
    { label: '@startgantt', kind: K, context: 'line-start', detail: 'Gantt chart', sortPriority: 10 },
    { label: '@startwbs', kind: K, context: 'line-start', detail: 'Work breakdown structure', sortPriority: 10 },
    { label: '@enduml', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endmindmap', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endjson', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endyaml', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endsalt', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@enddot', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endditaa', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endlatex', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endgantt', kind: K, context: 'line-start', sortPriority: 11 },
    { label: '@endwbs', kind: K, context: 'line-start', sortPriority: 11 },

    // --- Participant declarations ---
    { label: 'participant', kind: K, context: 'line-start', detail: 'Sequence participant' },
    { label: 'actor', kind: K, context: 'line-start', detail: 'Actor' },
    { label: 'boundary', kind: K, context: 'line-start', detail: 'Boundary' },
    { label: 'control', kind: K, context: 'line-start', detail: 'Control' },
    { label: 'entity', kind: K, context: 'line-start', detail: 'Entity' },
    { label: 'database', kind: K, context: 'line-start', detail: 'Database' },
    { label: 'collections', kind: K, context: 'line-start', detail: 'Collections' },
    { label: 'queue', kind: K, context: 'line-start', detail: 'Queue' },

    // --- Control flow ---
    { label: 'alt', kind: K, context: 'line-start', detail: 'Alternative' },
    { label: 'else', kind: K, context: 'line-start', detail: 'Else branch' },
    { label: 'end', kind: K, context: 'line-start', detail: 'End block' },
    { label: 'loop', kind: K, context: 'line-start', detail: 'Loop' },
    { label: 'group', kind: K, context: 'line-start', detail: 'Group' },
    { label: 'opt', kind: K, context: 'line-start', detail: 'Optional' },
    { label: 'par', kind: K, context: 'line-start', detail: 'Parallel' },
    { label: 'break', kind: K, context: 'line-start', detail: 'Break' },
    { label: 'critical', kind: K, context: 'line-start', detail: 'Critical' },
    { label: 'ref', kind: K, context: 'line-start', detail: 'Reference' },

    // --- Structure ---
    { label: 'class', kind: K, context: 'line-start', detail: 'Class' },
    { label: 'abstract', kind: K, context: 'line-start', detail: 'Abstract class' },
    { label: 'interface', kind: K, context: 'line-start', detail: 'Interface' },
    { label: 'enum', kind: K, context: 'line-start', detail: 'Enum' },
    { label: 'package', kind: K, context: 'line-start', detail: 'Package' },
    { label: 'rectangle', kind: K, context: 'line-start', detail: 'Rectangle' },
    { label: 'node', kind: K, context: 'line-start', detail: 'Node' },
    { label: 'cloud', kind: K, context: 'line-start', detail: 'Cloud' },
    { label: 'storage', kind: K, context: 'line-start', detail: 'Storage' },
    { label: 'usecase', kind: K, context: 'line-start', detail: 'Use case' },
    { label: 'object', kind: K, context: 'line-start', detail: 'Object' },
    { label: 'state', kind: K, context: 'line-start', detail: 'State' },
    { label: 'component', kind: K, context: 'line-start', detail: 'Component' },

    // --- Formatting ---
    { label: 'skinparam', kind: K, context: 'line-start', detail: 'Skin parameter' },
    { label: 'hide', kind: K, context: 'line-start', detail: 'Hide element' },
    { label: 'show', kind: K, context: 'line-start', detail: 'Show element' },
    { label: 'title', kind: K, context: 'line-start', detail: 'Diagram title' },
    { label: 'header', kind: K, context: 'line-start', detail: 'Header' },
    { label: 'footer', kind: K, context: 'line-start', detail: 'Footer' },
    { label: 'legend', kind: K, context: 'line-start', detail: 'Legend' },
    { label: 'caption', kind: K, context: 'line-start', detail: 'Caption' },

    // --- Activity ---
    { label: 'start', kind: K, context: 'line-start', detail: 'Activity start' },
    { label: 'stop', kind: K, context: 'line-start', detail: 'Activity stop' },
    { label: 'if', kind: K, context: 'line-start', detail: 'If condition' },
    { label: 'elseif', kind: K, context: 'line-start', detail: 'Else if' },
    { label: 'endif', kind: K, context: 'line-start', detail: 'End if' },
    { label: 'fork', kind: K, context: 'line-start', detail: 'Fork' },
    { label: 'detach', kind: K, context: 'line-start', detail: 'Detach' },

    // --- Notes ---
    { label: 'note', kind: K, context: 'line-start', detail: 'Note' },
    { label: 'hnote', kind: K, context: 'line-start', detail: 'Hexagonal note' },
    { label: 'rnote', kind: K, context: 'line-start', detail: 'Rectangle note' },

    // --- Preprocessor ---
    { label: '!include', kind: K, context: 'line-start', detail: 'Include file', sortPriority: 20 },
    { label: '!define', kind: K, context: 'line-start', detail: 'Define macro', sortPriority: 20 },
    { label: '!ifdef', kind: K, context: 'line-start', detail: 'If defined', sortPriority: 20 },
    { label: '!endif', kind: K, context: 'line-start', detail: 'End if', sortPriority: 20 },
    { label: '!ifndef', kind: K, context: 'line-start', detail: 'If not defined', sortPriority: 20 },
    { label: '!theme', kind: K, context: 'line-start', detail: 'Apply theme', sortPriority: 20 },
    { label: '!pragma', kind: K, context: 'line-start', detail: 'Pragma directive', sortPriority: 20 },

    // --- skinparam parameters (after-parent) ---
    { label: 'backgroundColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'defaultFontName', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'defaultFontSize', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'defaultFontColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'arrowColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'arrowFontColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'arrowFontSize', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'classFontColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'classFontSize', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'classBackgroundColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'classBorderColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'sequenceLifeLineBorderColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'sequenceGroupBackgroundColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'noteBackgroundColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'noteBorderColor', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'handwritten', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'shadowing', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'linetype', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'padding', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'roundCorner', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'monochrome', kind: P, context: 'after-parent', parent: 'skinparam' },
    { label: 'style', kind: P, context: 'after-parent', parent: 'skinparam' },

    // --- Color names (after-hash) — generated from PLANTUML_NAMED_COLORS ---
    ...([...PLANTUML_NAMED_COLORS.keys()].map(name => ({
        label: name[0].toUpperCase() + name.slice(1),
        kind: C,
        context: 'after-hash' as const,
    }))),
];
