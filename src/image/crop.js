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
 * @exports clampRect, normalizeBox, boxKey, sameBox, boxCenter, overlapRatio, sameFragment
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

/**
 * How much two boxes cover each other: the area they share over the area they make together.
 *
 * One is the same box, 0.9 is the same box with a couple of pixels off, and 0 is nothing in
 * common.
 * @param {object} a
 * @param {object} b
 * @returns {number} a number from 0 to 1
 * @exports
 * @ai.hint pure
 */
export function overlapRatio(a, b) {
    const [shared, areaA, areaB] = boxOverlap(a, b);
    const union = areaA + areaB - shared;
    return union > 0 ? shared / union : 0;
}

/**
 * True when two boxes are the same thing: the same place and about the same size.
 *
 * A model that looks at the same object twice names its box a little differently both times:
 * the edges move by a pixel or two, the size changes by a few percent. The same object is
 * therefore the same place *and* about the same size.
 *
 * The size matters as much as the place: a chess piece that stands on a numbered board covers
 * the board only partly, and the piece is not the board. Two boxes of about the same size that
 * cover most of each other are the same object.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function sameFragment(a, b) {
    const widthA = Number(a?.width ?? 0);
    const heightA = Number(a?.height ?? 0);
    const widthB = Number(b?.width ?? 0);
    const heightB = Number(b?.height ?? 0);
    if (!(widthA > 0) || !(heightA > 0) || !(widthB > 0) || !(heightB > 0)) return false;
    // The same object, named twice: the edges move, the size hardly moves.
    if (Math.min(widthA, widthB) / Math.max(widthA, widthB) < 0.8) return false;
    if (Math.min(heightA, heightB) / Math.max(heightA, heightB) < 0.8) return false;
    const [shared] = boxOverlap(a, b);
    const smaller = Math.min(widthA * heightA, widthB * heightB);
    if (!smaller) return false;
    // Most of the smaller box lies inside the bigger one: the same thing, seen twice.
    return shared / smaller >= 0.85;
}

/**
 * The area two boxes share, and their own areas.
 * @param {object} a
 * @param {object} b
 * @returns {[number, number, number]}
 */
function boxOverlap(a, b) {
    const left = Math.max(Number(a?.x ?? 0), Number(b?.x ?? 0));
    const top = Math.max(Number(a?.y ?? 0), Number(b?.y ?? 0));
    const right = Math.min(
        Number(a?.x ?? 0) + Number(a?.width ?? 0),
        Number(b?.x ?? 0) + Number(b?.width ?? 0),
    );
    const bottom = Math.min(
        Number(a?.y ?? 0) + Number(a?.height ?? 0),
        Number(b?.y ?? 0) + Number(b?.height ?? 0),
    );
    const shared = Math.max(0, right - left) * Math.max(0, bottom - top);
    const areaA = Math.max(0, Number(a?.width ?? 0)) * Math.max(0, Number(a?.height ?? 0));
    const areaB = Math.max(0, Number(b?.width ?? 0)) * Math.max(0, Number(b?.height ?? 0));
    return [shared, areaA, areaB];
}
