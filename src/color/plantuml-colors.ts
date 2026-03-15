/**
 * @module plantuml-colors
 * @description PlantUML named color definitions.
 *
 * Maps common color names used in PlantUML diagrams to their RGB values
 * for inline color swatch rendering.
 */

/** PlantUML named color → [R, G, B] (0-255) */
export const PLANTUML_NAMED_COLORS: ReadonlyMap<string, readonly [number, number, number]> = new Map([
    ['red',         [255,   0,   0]],
    ['blue',        [  0,   0, 255]],
    ['green',       [  0, 128,   0]],
    ['yellow',      [255, 255,   0]],
    ['orange',      [255, 165,   0]],
    ['purple',      [128,   0, 128]],
    ['pink',        [255, 192, 203]],
    ['white',       [255, 255, 255]],
    ['black',       [  0,   0,   0]],
    ['gray',        [128, 128, 128]],
    ['lightblue',   [173, 216, 230]],
    ['lightgreen',  [144, 238, 144]],
    ['lightyellow', [255, 255, 224]],
    ['darkred',     [139,   0,   0]],
    ['darkblue',    [  0,   0, 139]],
    ['salmon',      [250, 128, 114]],
    ['coral',       [255, 127,  80]],
    ['aqua',        [  0, 255, 255]],
    ['gold',        [255, 215,   0]],
    ['lime',        [  0, 255,   0]],
]);
