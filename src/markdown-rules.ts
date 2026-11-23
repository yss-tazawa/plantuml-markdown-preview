/**
 * markdown-it rules that bring the rendering closer to GitHub (cmark-gfm):
 *
 * - strikethroughPlugin: `~text~` and `~~text~~` strikethrough with cmark-gfm pairing.
 * - trimAutolinkTrailing: trailing punctuation of autolinks is trimmed like GitHub,
 *   and `ftp://` is not auto-linked.
 * - listLooseClassPlugin: adds the `list-loose` class to lists whose items are separated
 *   by blank lines (loose lists); render time only, the token stream is unchanged.
 * - footnotePlugin: GFM footnotes (`[^label]` / `[^label]: text`) laid out as on GitHub.
 * - alertPlugin: GitHub alerts (`> [!NOTE]` etc.) on quotes at the top level of the document.
 */

import type MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

type Token = ReturnType<MarkdownIt['parse']>[number];
type RuleInline = Parameters<MarkdownIt['inline']['ruler']['at']>[1];
type StateInline = Parameters<RuleInline>[0];
type Delimiter = StateInline['delimiters'][number];

const TILDE = 0x7e;

/** Autolink ranges per inline source: sorted [start, end) pairs, computed once per parse state. */
const linkRanges = new WeakMap<StateInline, Array<[number, number]>>();

/**
 * Whether `pos` lies inside an autolink that core linkify will apply later.
 * Inside link text (`[www.a.com/~b~](u)`) linkify does not apply, so it is not checked there.
 * The ranges come from one linkify pass over the whole text (matches never span whitespace).
 */
function insideAutolink(state: StateInline, pos: number): boolean {
    // linkLevel exists on markdown-it 14 states but is missing from the type definitions.
    if ((state as StateInline & { linkLevel?: number }).linkLevel) return false;
    let ranges = linkRanges.get(state);
    if (!ranges) {
        // linkify-it's default `www.` and bare-domain links are "fuzzy" matches (empty schema),
        // so every match (not only schema `www.`) is protected from being split by `~`.
        const found = state.md.linkify.pretest(state.src) ? (state.md.linkify.match(state.src) ?? []) : [];
        ranges = found.map((m): [number, number] => [m.index, m.lastIndex]);
        linkRanges.set(state, ranges);
    }
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ranges[mid]![1] <= pos) lo = mid + 1;
        else hi = mid;
    }
    return lo < ranges.length && ranges[lo]![0] < pos;
}

/**
 * Inline rule: reads a run of `~`. A run of 1 or 2 becomes a delimiter; 3 or more stay text.
 *
 * @param state - Inline parse state.
 * @param silent - Validation-only mode.
 * @returns Whether the rule consumed input.
 */
const tokenize: RuleInline = (state, silent) => {
    const start = state.pos;
    if (silent || state.src.charCodeAt(start) !== TILDE) return false;
    if (insideAutolink(state, start)) return false;
    const scanned = state.scanDelims(start, true);
    const length = scanned.length;
    if (length > 2 || !(scanned.can_open || scanned.can_close)) {
        // A run that cannot be a delimiter joins the surrounding text token.
        state.pending += '~'.repeat(length);
        state.pos += length;
        return true;
    }
    const token = state.push('text', '', 0);
    token.content = '~'.repeat(length);
    const delimiter: Delimiter = {
        marker: TILDE,
        length,
        token: state.tokens.length - 1,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close,
    };
    state.delimiters.push(delimiter);
    state.pos += length;
    return true;
};

/**
 * Pair delimiters (a port of markdown-it's balance_pairs plus the `~` run-length rule).
 * Closers are visited left to right and the nearest earlier opener is searched. A matched
 * range is skipped via `jumps`, so delimiters inside it are invisible to later closers
 * (as cmark discards them). For `~` with different run lengths the range is skipped the
 * same way but not paired: both stay text.
 *
 * @param delimiters - Delimiter list of one inline state.
 */
function processDelimiters(delimiters: Delimiter[]): void {
    const openersBottom: Record<number, number[]> = {};
    const max = delimiters.length;
    if (!max) return;
    // Start of the run (same marker, adjacent tokens) the closer belongs to.
    let headerIdx = 0;
    let lastTokenIdx = -2;
    const jumps: number[] = [];
    for (let closerIdx = 0; closerIdx < max; closerIdx++) {
        const closer = delimiters[closerIdx]!;
        jumps.push(0);
        if (delimiters[headerIdx]!.marker !== closer.marker || lastTokenIdx !== closer.token - 1) headerIdx = closerIdx;
        lastTokenIdx = closer.token;
        closer.length = closer.length || 0;
        if (!closer.close) continue;
        openersBottom[closer.marker] ??= [-1, -1, -1, -1, -1, -1];
        const bottomKey = (closer.open ? 3 : 0) + (closer.length % 3);
        const minOpenerIdx = openersBottom[closer.marker]![bottomKey]!;
        let openerIdx = headerIdx - jumps[headerIdx]! - 1;
        let newMinOpenerIdx = openerIdx;
        for (; openerIdx > minOpenerIdx; openerIdx -= jumps[openerIdx]! + 1) {
            const opener = delimiters[openerIdx]!;
            if (opener.marker !== closer.marker) continue;
            if (!opener.open || opener.end >= 0) continue;
            // When either side can both open and close, a length sum that is a multiple of 3
            // does not pair (unless both lengths are multiples of 3).
            const oddMatch = (opener.close || closer.open) &&
                (opener.length + closer.length) % 3 === 0 &&
                (opener.length % 3 !== 0 || closer.length % 3 !== 0);
            if (oddMatch) continue;
            const lastJump = openerIdx > 0 && !delimiters[openerIdx - 1]!.open ? jumps[openerIdx - 1]! + 1 : 0;
            jumps[closerIdx] = closerIdx - openerIdx + lastJump;
            jumps[openerIdx] = lastJump;
            closer.open = false;
            opener.close = false;
            if (closer.marker === TILDE && opener.length !== closer.length) {
                // A `~` pair of different run lengths: both stay text.
                opener.open = false;
            } else {
                opener.end = closerIdx;
            }
            newMinOpenerIdx = -1;
            lastTokenIdx = -2;
            break;
        }
        if (newMinOpenerIdx !== -1) openersBottom[closer.marker]![bottomKey] = newMinOpenerIdx;
    }
}

/**
 * Inline post-processing rule replacing balance_pairs.
 *
 * @param state - Inline parse state.
 * @returns Always false (post-processing rule).
 */
const balancePairs = (state: StateInline): boolean => {
    processDelimiters(state.delimiters);
    for (const meta of state.tokens_meta) {
        if (meta?.delimiters) processDelimiters(meta.delimiters);
    }
    return false;
};

/**
 * Turn the tokens of paired `~` delimiters into s_open / s_close.
 *
 * @param state - Inline parse state.
 * @param delimiters - Delimiter list to process.
 */
function postProcess(state: StateInline, delimiters: Delimiter[]): void {
    for (const open of delimiters) {
        if (open.marker !== TILDE || open.end < 0) continue;
        const close = delimiters[open.end]!;
        const markup = '~'.repeat(open.length);
        for (const [index, type, nesting] of [[open.token, 's_open', 1], [close.token, 's_close', -1]] as const) {
            const token = state.tokens[index]!;
            token.type = type;
            token.tag = 's';
            token.nesting = nesting;
            token.markup = markup;
            token.content = '';
        }
    }
}

/**
 * Post-process rule that converts paired `~` delimiters into strikethrough tokens.
 *
 * @param state - Inline parse state.
 * @returns Always false (post-processing rule).
 */
const strikethroughPostProcess = (state: StateInline): boolean => {
    postProcess(state, state.delimiters);
    for (const meta of state.tokens_meta) {
        if (meta?.delimiters) postProcess(state, meta.delimiters);
    }
    return false;
};

/**
 * Replace markdown-it's strikethrough with GFM's rules (`~` and `~~`, equal run lengths only).
 *
 * @param md - markdown-it instance.
 */
export function strikethroughPlugin(md: MarkdownIt): void {
    md.inline.ruler.at('strikethrough', tokenize);
    md.inline.ruler2.at('balance_pairs', balancePairs);
    md.inline.ruler2.at('strikethrough', strikethroughPostProcess);
}

type LinkifyMatch = NonNullable<ReturnType<MarkdownIt['linkify']['matchAtStart']>>;

/**
 * Number of characters GFM (cmark-gfm) removes from the end of an autolink `link`:
 * trailing `? ! . , : * _ ~ ' "`, an unbalanced `)`, and a trailing entity-like `&...;`.
 *
 * @param link - Autolink text.
 * @returns Count of trailing characters to drop.
 */
function gfmTrailingTrim(link: string): number {
    let end = link.indexOf('<');
    if (end < 0) end = link.length;
    let opening = 0;
    let closing = 0;
    for (let i = 0; i < end; i++) {
        if (link[i] === '(') opening++;
        else if (link[i] === ')') closing++;
    }
    while (end > 0) {
        const c = link[end - 1]!;
        if (c === ')') {
            if (closing <= opening) break;
            closing--;
            end--;
        } else if ('?!.,:*_~\'"'.includes(c)) {
            end--;
        } else if (c === ';') {
            let start = end - 2;
            while (start > 0 && /[A-Za-z]/.test(link[start]!)) start--;
            end = start < end - 2 && link[start] === '&' ? start : end - 1;
        } else {
            break;
        }
    }
    return link.length - end;
}

/**
 * Trim the end of a linkify match by GFM's rules (a match that becomes empty is dropped).
 * linkify leaves a trailing `;` out of the match but GFM looks at it to drop entity-like
 * endings, so the following `;` is counted when deciding the cut. E-mail matches are unchanged.
 *
 * @param match - linkify match.
 * @param text - Text the match came from.
 * @returns The trimmed match, or null if nothing is left.
 */
function trimMatch(match: LinkifyMatch, text: string): LinkifyMatch | null {
    // Schemeless matches (`www.x.com`, `example.com`; empty schema in linkify-it) are trimmed
    // like explicit-scheme ones; only e-mail matches are left alone.
    if (match.schema.toLowerCase() === 'mailto:') return match;
    const semicolon = text[match.lastIndex] === ';' ? 1 : 0;
    const cut = gfmTrailingTrim(match.raw + (semicolon ? ';' : '')) - semicolon;
    if (cut <= 0) return match;
    if (cut >= match.raw.length) return null;
    match.raw = match.raw.slice(0, -cut);
    match.text = match.text.slice(0, -cut);
    match.url = match.url.slice(0, -cut);
    match.lastIndex -= cut;
    return match;
}

/**
 * Make autolinks end like GitHub's: wrap the two linkify entry points (core linkify uses
 * `match`, the inline `://` rule uses `matchAtStart`) with the trailing trim, and do not
 * auto-link `ftp://`. The set of recognized links is otherwise linkify-it's default.
 *
 * @param md - markdown-it instance created with `linkify: true`.
 */
export function trimAutolinkTrailing(md: MarkdownIt): void {
    const linkify = md.linkify;
    const match = linkify.match.bind(linkify);
    const matchAtStart = linkify.matchAtStart.bind(linkify);
    // Return an empty array when nothing matches (core linkify reads the length after linkify.test).
    linkify.match = (text: string) => {
        const found: LinkifyMatch[] = [];
        for (const m of match(text) ?? []) {
            const trimmed = trimMatch(m, text);
            if (trimmed) found.push(trimmed);
        }
        return found;
    };
    linkify.matchAtStart = (text: string) => {
        const found = matchAtStart(text);
        return found ? trimMatch(found, text) : null;
    };
    // GitHub does not auto-link `ftp://`.
    linkify.add('ftp:', null);
}

/** Class added to lists whose items are separated by blank lines (loose lists). */
const LIST_LOOSE_CLASS = 'list-loose';

type RenderRule = NonNullable<MarkdownIt['renderer']['rules'][string]>;

/**
 * Whether the list opened at `tokens[idx]` is loose: the first item's direct paragraph is not hidden.
 *
 * @param tokens - Token stream.
 * @param idx - Index of the bullet_list_open / ordered_list_open token.
 * @returns True for a loose list.
 */
function listTokenLoose(tokens: Token[], idx: number): boolean {
    const level = tokens[idx]!.level;
    for (let i = idx + 1; i < tokens.length; i++) {
        const t = tokens[i]!;
        // Back at the same depth: the list closed.
        if (t.level <= level) return false;
        if (t.type === 'paragraph_open' && t.level === level + 2) return !t.hidden;
    }
    return false;
}

/**
 * Wrap the render rule `name` so loose lists get the `list-loose` class first.
 *
 * @param md - markdown-it instance.
 * @param name - Renderer rule name.
 */
function looseRule(md: MarkdownIt, name: string): void {
    const original = md.renderer.rules[name];
    const rule: RenderRule = (tokens, idx, options, env, self) => {
        const token = tokens[idx]!;
        const classes = (token.attrGet('class') ?? '').split(/\s+/);
        if (listTokenLoose(tokens, idx) && !classes.includes(LIST_LOOSE_CLASS)) token.attrJoin('class', LIST_LOOSE_CLASS);
        return original ? original(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
    md.renderer.rules[name] = rule;
}

/**
 * Register the loose-list class on bullet and ordered lists (render time only).
 *
 * @param md - markdown-it instance.
 */
export function listLooseClassPlugin(md: MarkdownIt): void {
    for (const name of ['bullet_list_open', 'ordered_list_open']) looseRule(md, name);
}

/**
 * Read GFM footnotes with markdown-it-footnote and render them as GitHub does: every
 * reference reads `[n]` (the plugin shows later references to the same footnote as
 * `[n:m]`; their anchor ids stay apart, so each back link still returns to its own
 * reference), and no rule is drawn above the footnote section (the section's top
 * border separates it, as on GitHub). Inline footnotes (`text^[note]`) are not GFM,
 * so they stay text as on GitHub.
 *
 * @param md - markdown-it instance.
 */
export function footnotePlugin(md: MarkdownIt): void {
    md.use(footnote);
    md.inline.ruler.disable('footnote_inline');
    md.renderer.rules.footnote_caption = (tokens, idx) => `[${Number(tokens[idx]!.meta.id) + 1}]`;
    md.renderer.rules.footnote_block_open = () => '<section class="footnotes">\n<ol class="footnotes-list">\n';
}

/** A GitHub alert type: its marker, the class key and title, and its Octicon. */
interface AlertKind {
    /** Marker inside `[!...]`, in uppercase (a marker matches in any case, as on GitHub). */
    marker: string;
    /** Lowercase key for the `markdown-alert-<key>` class. */
    key: string;
    /** Title shown in the alert's first line. */
    label: string;
    /** Octicon class name (`octicon-<name>`), as GitHub emits it. */
    icon: string;
    /** The 16px Octicon's `<path>` (@primer/octicons 19.11.0, MIT License), copied as is. */
    path: string;
}

/** The five GitHub alert types. */
const ALERT_KINDS: readonly AlertKind[] = [
    {
        marker: 'NOTE', key: 'note', label: 'Note', icon: 'info',
        path: '<path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>',
    },
    {
        marker: 'TIP', key: 'tip', label: 'Tip', icon: 'light-bulb',
        path: '<path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path>',
    },
    {
        marker: 'IMPORTANT', key: 'important', label: 'Important', icon: 'report',
        path: '<path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>',
    },
    {
        marker: 'WARNING', key: 'warning', label: 'Warning', icon: 'alert',
        path: '<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>',
    },
    {
        marker: 'CAUTION', key: 'caution', label: 'Caution', icon: 'stop',
        path: '<path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>',
    },
];

/**
 * A line that is only an alert marker, in any case (`[!note]` too), as on GitHub. Only ASCII
 * spaces and tabs after it, or one backslash (a hard break, so only when the paragraph goes on).
 */
const ALERT_MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*|(\\))$/i;

type RuleCore = Parameters<MarkdownIt['core']['ruler']['after']>[2];

/**
 * The alert type of a quote whose first paragraph starts with `firstLine`: the line must be a
 * marker and nothing else, and something must follow the marker (a next line of the paragraph
 * or a block with content in the quote), as on GitHub.
 *
 * @param firstLine - Source of the paragraph's first line after the `>` and the ASCII spaces and
 *     tabs after it (a no-break space stays a character, as on GitHub).
 * @param linesFollow - Whether the paragraph has lines after the first.
 * @param blocksFollow - Whether the quote has blocks with content after its first paragraph.
 * @returns The alert type, or undefined for a plain quote.
 */
function alertKindOf(firstLine: string, linesFollow: boolean, blocksFollow: boolean): AlertKind | undefined {
    const match = ALERT_MARKER_RE.exec(firstLine);
    if (!match) return undefined;
    if (!linesFollow && (match[2] !== undefined || !blocksFollow)) return undefined;
    return ALERT_KINDS.find(kind => kind.marker === match[1]!.toUpperCase());
}

/**
 * Whether an HTML block counts as content of an alert. GitHub drops comments and does not count a
 * block that leaves no element (only a comment, or a comment and text after it).
 *
 * @param html - Source of the HTML block.
 */
function htmlCountsAsAlertBody(html: string): boolean {
    return /<[A-Za-z]/.test(html.replace(/<!--[\s\S]*?-->/g, ''));
}

/**
 * Whether the quote has a block with content directly in it between `from` and `close`.
 * Footnote definitions (still in place before the footnote core rule moves them) and HTML blocks
 * that leave no element do not count, as on GitHub; reference definitions leave no token.
 *
 * @param tokens - Token stream.
 * @param from - Index after the first paragraph.
 * @param close - Index of the quote's close.
 */
function hasBodyBlock(tokens: Token[], from: number, close: number): boolean {
    for (let j = from; j < close; j++) {
        const t = tokens[j]!;
        if (t.level !== 1 || t.nesting === -1) continue;
        if (t.type === 'footnote_reference_open') continue;
        if (t.type === 'html_block' && !htmlCountsAsAlertBody(t.content)) continue;
        return true;
    }
    return false;
}

/**
 * Core rule (between block and inline parsing) that turns a quote into an alert when it
 * is at the top level of the document and its first paragraph starts with a marker line.
 * Quotes in list items, quotes and footnotes stay quotes, as on GitHub.
 *
 * @param state - markdown-it core state.
 */
const alertRule: RuleCore = (state) => {
    const tokens = state.tokens;
    let lines: string[] | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const open = tokens[i]!;
        // Quotes in other blocks have a level above 0.
        if (open.type !== 'blockquote_open' || open.level !== 0) continue;
        // The next top-level close is this quote's (quotes inside it close at a deeper level).
        let closeIdx = -1;
        for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j]!.type === 'blockquote_close' && tokens[j]!.level === 0) { closeIdx = j; break; }
        }
        if (closeIdx < 0) continue;
        const pOpen = tokens[i + 1];
        const inline = tokens[i + 2];
        if (pOpen?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
        // The paragraph's content is cut with trim(), which also drops no-break spaces, so the
        // first line is read from the source (a quote's first line always starts with `>`).
        if (!pOpen.map) continue;
        lines ??= state.src.split('\n');
        const firstLine = lines[pOpen.map[0]]!.replace(/^ {0,3}>[ \t]*/, '');
        const kind = alertKindOf(firstLine, pOpen.map[1] - pOpen.map[0] > 1, hasBodyBlock(tokens, i + 4, closeIdx));
        if (!kind) continue;
        open.tag = 'div';
        open.attrSet('class', `markdown-alert markdown-alert-${kind.key}`);
        tokens[closeIdx]!.tag = 'div';
        const title = new state.Token('html_block', '', 0);
        title.block = true;
        title.content = '<p class="markdown-alert-title">'
            + `<svg class="octicon octicon-${kind.icon} mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true">`
            + `${kind.path}</svg>${kind.label}</p>\n`;
        tokens.splice(i + 1, 0, title);
        const nl = inline.content.indexOf('\n');
        if (nl < 0) {
            // A paragraph with only the marker (or lines that trim() empties) is dropped, so no
            // empty <p> is left (paragraph_open, inline, paragraph_close).
            tokens.splice(i + 2, 3);
        } else {
            // The marker line is cut off and the rest stays the first paragraph, starting one source line later.
            inline.content = inline.content.slice(nl + 1);
            pOpen.map[0] += 1;
            if (inline.map) inline.map[0] += 1;
        }
    }
};

/**
 * GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) in the
 * markup GitHub uses: `div.markdown-alert.markdown-alert-<type>` with a
 * `p.markdown-alert-title` holding the Octicon and the title. A marker line with other
 * text (`> [!NOTE] Title`) leaves a plain quote, as on GitHub; the marker's case does not matter.
 *
 * @param md - markdown-it instance.
 */
export function alertPlugin(md: MarkdownIt): void {
    md.core.ruler.after('block', 'github_alert', alertRule);
}
