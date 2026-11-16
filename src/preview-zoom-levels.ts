/**
 * @module preview-zoom-levels
 * @description Zoom levels of the Markdown preview and Reading View, and the pure
 * arithmetic over them. Free of the `vscode` module so the webview script bundles it too.
 */

/** Smallest zoom level (%). */
const MIN_PREVIEW_ZOOM = 50;
/** Largest zoom level (%). */
const MAX_PREVIEW_ZOOM = 200;
/** Distance (%) between neighbouring levels. */
const PREVIEW_ZOOM_STEP = 5;

/** Zoom levels (%) in order: 50 to 200 in steps of 5. */
export const PREVIEW_ZOOM_LEVELS: readonly number[] = Array.from(
    { length: (MAX_PREVIEW_ZOOM - MIN_PREVIEW_ZOOM) / PREVIEW_ZOOM_STEP + 1 },
    (_, i) => MIN_PREVIEW_ZOOM + i * PREVIEW_ZOOM_STEP,
);

/** Zoom level (%) used when the setting holds no usable number. */
export const DEFAULT_PREVIEW_ZOOM = 100;

/** Wheel distance (px) that moves the zoom by one level. A mouse notch is at least this
 *  in one event (a slow notch on macOS is 4px, on Windows about 100px); a trackpad pinch
 *  arrives as events of a fraction of a pixel to a few pixels, which add up to it. */
export const WHEEL_ZOOM_STEP_PX = 4;

/**
 * Snap a value to the nearest zoom level. A tie goes to the smaller level.
 *
 * @param value - Zoom in percent, e.g. from a hand-edited setting.
 * @returns The nearest level, or the default when the value is not a finite number.
 */
export function snapPreviewZoom(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PREVIEW_ZOOM;
    let best = PREVIEW_ZOOM_LEVELS[0];
    for (const level of PREVIEW_ZOOM_LEVELS) {
        if (Math.abs(level - value) < Math.abs(best - value)) best = level;
    }
    return best;
}

/**
 * Move one level up or down from a zoom, stopping at the ends.
 *
 * @param zoom - Current zoom in percent (snapped first when it is not a level).
 * @param direction - 1 to zoom in, -1 to zoom out.
 * @returns The next level, or the same level at an end.
 */
export function stepPreviewZoom(zoom: number, direction: 1 | -1): number {
    const index = PREVIEW_ZOOM_LEVELS.indexOf(snapPreviewZoom(zoom));
    const next = Math.min(PREVIEW_ZOOM_LEVELS.length - 1, Math.max(0, index + direction));
    return PREVIEW_ZOOM_LEVELS[next];
}

/**
 * Add one zooming wheel event to the accumulated distance. One event moves at most one
 * level, so a mouse notch is one level whatever its size, and the rest of it is dropped;
 * a trackpad's small deltas add up to a level. A change of direction drops what was
 * accumulated the other way.
 *
 * @param accumulated - Distance (px) carried over from earlier events.
 * @param deltaY - The event's vertical distance (px); negative zooms in.
 * @param stepPx - Distance per level.
 * @returns The distance to carry over, and the level change: 1 zooms in, -1 out, 0 none.
 */
export function accumulateWheelZoom(accumulated: number, deltaY: number, stepPx = WHEEL_ZOOM_STEP_PX): { accumulated: number; steps: -1 | 0 | 1 } {
    const total = deltaY === 0 || Math.sign(accumulated) === Math.sign(deltaY) ? accumulated + deltaY : deltaY;
    if (Math.abs(total) < stepPx) return { accumulated: total, steps: 0 };
    return { accumulated: 0, steps: total < 0 ? 1 : -1 };
}
