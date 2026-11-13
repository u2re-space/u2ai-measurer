/**
 * @file src/image/crop.js
 * @module image/crop
 * @purpose The geometry of a crop: which rectangle of a picture may be cut and where it
 *          lands on the canvas.
 *
 * The rules are the same everywhere: a box is clamped to the frame, a box that
 * does not fit is shrunk, and two boxes with the same rounded numbers are the
 * same fragment and share one file.
 *
 * @exports clampRect, normalizeBox, boxKey, sameBox, boxCenter
 * @ai.tags image, crop, geometry
 * @ai.hint pure
 */

/**
 * True for a finite number.
 * @param {unknown} value
 * @returns {boolean}
 * @ai.hint pure
 */
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read a box from an arbitrary object: every side may be missing.
 * @param {object} args
 * @returns {{ x: number|null, y: number|null, width: number|null, height: number|null }}
 * @ai.hint pure
 */
export function normalizeBox(args) {
    const box = args?.box ?? args ?? {};
    const num = (value) => {
        const parsed = Number(value);
        return finite(parsed) ? parsed : null;
    };
    return {
        x: num(box.x),
        y: num(box.y),
        width: num(box.width),
        height: num(box.height),
    };
}

/**
 * Clamp a rectangle to the frame of a picture.
 *
 * A rectangle that starts outside the frame is moved inside it; a rectangle
 * that is wider than the frame is cut down to the frame.
 * @param {object} args the box: { x, y, width, height }
 * @param {{ width: number, height: number }} info the size of the frame
 * @returns {{ x: number, y: number, width: number, height: number }}
 * @ai.hint pure
 */
export function clampRect(args, info) {
    const box = normalizeBox(args);
    const frameWidth = Math.max(1, Math.trunc(info?.width ?? 0));
    const frameHeight = Math.max(1, Math.trunc(info?.height ?? 0));
    const left = Math.max(0, Math.min(Math.trunc(box.x ?? 0), frameWidth - 1));
    const top = Math.max(0, Math.min(Math.trunc(box.y ?? 0), frameHeight - 1));
    const width = Math.max(1, Math.min(Math.trunc(box.width ?? 0), frameWidth - left));
    const height = Math.max(1, Math.min(Math.trunc(box.height ?? 0), frameHeight - top));
    return { x: left, y: top, width, height };
}

/**
 * The key of a box: two boxes with the same key are the same fragment.
 * @param {object} box
 * @returns {string}
 * @ai.hint pure
 */
export function boxKey(box) {
    return [
        Math.round(Number(box?.x ?? 0)),
        Math.round(Number(box?.y ?? 0)),
        Math.round(Number(box?.width ?? 0)),
        Math.round(Number(box?.height ?? 0)),
    ].join(':');
}

/**
 * True when two boxes describe the same fragment.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 * @ai.hint pure
 */
export function sameBox(a, b) {
    return boxKey(a) === boxKey(b);
}

/**
 * The middle point of a box.
 * @param {object} box
 * @returns {{ x: number, y: number }}
 * @ai.hint pure
 */
export function boxCenter(box) {
    return {
        x: Math.round(Number(box?.x ?? 0) + Number(box?.width ?? 0) / 2),
        y: Math.round(Number(box?.y ?? 0) + Number(box?.height ?? 0) / 2),
    };
}
