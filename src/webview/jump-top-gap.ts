/**
 * Stop where the TOC or an in-page link (`#…`) jumps to a little below the top of the view.
 *
 * The gap goes into scroll-margin-top through a <style> in the head only while scrollIntoView runs,
 * and is taken out right after. A gap left on the headings would also apply whenever the browser
 * brings a heading into view for other reasons. The target's own attributes are not touched.
 * The gap is in on-screen px: inside a CSS zoom it is divided by the product of the zooms of the
 * target and its ancestors. Plotdown jumps the same way (src/services/jump-top-gap.ts).
 */

/** Gap (on-screen px) left above the target. Kept below TOC_SCROLL_OFFSET (scroll-sync-webview.ts), the line the TOC takes a heading as the current one at. */
export const JUMP_TOP_GAP = 16;

/** Zoom applied to el: the product of the CSS zoom of el and its ancestors. */
function effectiveZoom(el: Element): number {
    const view = el.ownerDocument.defaultView;
    if (!view) return 1;
    let zoom = 1;
    for (let e: Element | null = el; e; e = e.parentElement) {
        const z = parseFloat(view.getComputedStyle(e).zoom);
        if (z > 0 && Number.isFinite(z)) zoom *= z;
    }
    return zoom;
}

/** A narrow selector for target: its id when it has one, its element name otherwise. */
function targetSelector(target: Element): string {
    return target.id ? `[id="${target.id.replace(/["\\]/g, '\\$&')}"]` : target.localName;
}

/**
 * Bring target into view with JUMP_TOP_GAP above it.
 * @param target - Where to jump to.
 * @param options - Passed to scrollIntoView as they are.
 */
export function scrollIntoViewWithTopGap(target: Element, options: ScrollIntoViewOptions): void {
    const doc = target.ownerDocument;
    const style = doc.createElement('style');
    // The rule matches the target's id (or its element name), so adding and removing it recalculates
    // little style. !important keeps any other scroll-margin-top rule from winning.
    style.textContent = `${targetSelector(target)} { scroll-margin-top: ${JUMP_TOP_GAP / effectiveZoom(target)}px !important; }`;
    doc.head.appendChild(style);
    try {
        target.scrollIntoView(options);
    } finally {
        style.remove();
    }
}
