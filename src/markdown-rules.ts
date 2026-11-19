/**
 * markdown-it rules that bring the rendering closer to GitHub (cmark-gfm):
 *
 * - strikethroughPlugin: `~text~` and `~~text~~` strikethrough with cmark-gfm pairing.
 * - trimAutolinkTrailing: trailing punctuation of autolinks is trimmed like GitHub,
 *   and `ftp://` is not auto-linked.
 * - listLooseClassPlugin: adds the `list-loose` class to lists whose items are separated
 *   by blank lines (loose lists); render time only, the token stream is unchanged.
 */

import type MarkdownIt from 'markdown-it';

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
