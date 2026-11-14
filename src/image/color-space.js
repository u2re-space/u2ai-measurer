/**
 * @file src/image/color-space.js
 * @module image/color-space
 * @purpose The colour spaces of CSS, on top of culori.
 *
 * The measurer reads colours as text as often as it reads them as pixels: a mockup quotes
 * `#f1463f`, a design file quotes `oklch(0.64 0.21 27)`, a stylesheet quotes `rgb(241 70 63)`.
 * One library has to speak all of them, and has to say how far two colours are from each other
 * in a way a human can judge. culori does that: it parses every CSS colour notation, converts
 * between the spaces, and measures the WCAG contrast and the CIEDE2000 difference.
 *
 * The pixel-side ground truth stays in image/colors: the bytes of the file are the truth, and
 * this module is the notation layer around them.
 *
 * @depends culori
 * @usedBy image/colors, agent/tools, stages/resolve
 * @exports parseColor, describeColor, contrastOf, contrastOver, deltaE, colorNotations
 * @ai.tags colors, css, culori, contrast, oklch
 * @ai.hint pure
 */

import {
    blend,
    clampChroma,
    converter,
    differenceCiede2000,
    differenceEuclidean,
    formatHex,
    formatHex8,
    inGamut,
    parse,
    wcagContrast,
    wcagLuminance,
} from 'culori';

const toRgb = converter('rgb');
const toOklch = converter('oklch');
const toOklab = converter('oklab');
const toHsl = converter('hsl');
const toHwb = converter('hwb');
const toLab = converter('lab');
const toLch = converter('lch');
const toP3 = converter('p3');
const toXyz = converter('xyz65');

/** The CIEDE2000 difference: the number a designer accepts as "the same colour". */
const ciede2000 = differenceCiede2000();
/** The cheap companion: the Euclidean distance in OKLab. */
const okDistance = differenceEuclidean('oklab');

/** Round a number for a stylesheet: the sheet is read by a human. */
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const alphaOf = (color) => (typeof color.alpha === 'number' ? color.alpha : 1);
const alphaPart = (alpha) => (alpha >= 1 ? '' : ` / ${round(alpha, 3)}`);
/** The hue of an achromatic colour is undefined; CSS writes 0 there. */
const hueOf = (color) => (Number.isFinite(color?.h) ? round(color.h, 1) : 0);

const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * Parse a CSS colour: a hex, a named colour, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`,
 * `oklab()`, `oklch()`, `color()` or a CSS colour function of a modern space.
 * @param {string} value
 * @returns {{ ok: boolean, color: object|null, error: string|null }}
 * @exports
 * @ai.hint pure
 */
export function parseColor(value) {
    const text = textOf(value).trim();
    if (!text) return { ok: false, color: null, error: 'The colour is empty.' };
    try {
        const color = parse(text);
        if (!color || typeof color !== 'object') {
            return { ok: false, color: null, error: `Not a CSS colour: ${text}` };
        }
        return { ok: true, color, error: null };
    } catch (error) {
        return { ok: false, color: null, error: error?.message ?? `Not a CSS colour: ${text}` };
    }
}

/**
 * Every notation of one colour, in the forms a stylesheet and a sheet may use.
 * @param {string|object} value a CSS colour or a culori colour
 * @returns {object|null} null when the colour cannot be read
 * @exports
 * @ai.hint pure
 */
export function colorNotations(value) {
    const parsed = typeof value === 'object' && value !== null ? { ok: true, color: value, error: null } : parseColor(value);
    if (!parsed.ok) return null;
    const color = parsed.color;
    const rgb = toRgb(color);
    const oklch = toOklch(color);
    const hsl = toHsl(color);
    const hwb = toHwb(color);
    const lab = toLab(color);
    const lch = toLch(color);
    const p3 = toP3(color);
    const xyz = toXyz(color);
    const alpha = alphaOf(rgb);
    const inSrgb = inGamut('rgb')(color);
    return {
        hex: formatHex(color),
        hex8: formatHex8(color),
        rgb: `rgb(${Math.round(clamp01(rgb.r) * 255)} ${Math.round(clamp01(rgb.g) * 255)} ${Math.round(clamp01(rgb.b) * 255)}${alphaPart(alpha)})`,
        hsl: `hsl(${hueOf(hsl)} ${round(hsl.s * 100, 1)}% ${round(hsl.l * 100, 1)}%${alphaPart(alpha)})`,
        hwb: `hwb(${hueOf(hwb)} ${round(hwb.w * 100, 1)}% ${round(hwb.b * 100, 1)}%${alphaPart(alpha)})`,
        oklab: `oklab(${round(toOklab(color).l, 4)} ${round(toOklab(color).a, 4)} ${round(toOklab(color).b, 4)}${alphaPart(alpha)})`,
        oklch: `oklch(${round(oklch.l, 4)} ${round(oklch.c, 4)} ${hueOf(oklch)}${alphaPart(alpha)})`,
        lab: `lab(${round(lab.l, 2)} ${round(lab.a, 2)} ${round(lab.b, 2)}${alphaPart(alpha)})`,
        lch: `lch(${round(lch.l, 2)} ${round(lch.c, 2)} ${hueOf(lch)}${alphaPart(alpha)})`,
        p3: `color(display-p3 ${round(p3.r, 4)} ${round(p3.g, 4)} ${round(p3.b, 4)}${alphaPart(alpha)})`,
        xyz: `color(xyz-d65 ${round(xyz.x, 5)} ${round(xyz.y, 5)} ${round(xyz.z, 5)}${alphaPart(alpha)})`,
        alpha: Number(alpha.toFixed(4)),
        luminance: Number(wcagLuminance(color).toFixed(4)),
        inSrgb,
        note: inSrgb
            ? 'The colour fits sRGB; every notation above is the same colour.'
            : 'The colour does not fit sRGB: the hex value is the sRGB approximation of the wide-gamut colour.',
    };
}

/**
 * Describe a colour: the notations and, when a second colour is given, the contrast.
 * @param {string} value the CSS colour
 * @param {{ against?: string|null }} [options]
 * @returns {object|null}
 * @exports
 * @ai.hint pure
 */
export function describeColor(value, { against = null } = {}) {
    const notations = colorNotations(value);
    if (!notations) return null;
    const out = { color: textOf(value).trim(), ...notations };
    if (against) {
        const other = parseColor(against);
        if (other.ok) {
            out.against = textOf(against).trim();
            out.contrast = Number(contrastOf(value, against).toFixed(3));
            out.contrastOnWhite = Number(contrastOf(value, '#ffffff').toFixed(3));
            out.contrastOnBlack = Number(contrastOf(value, '#000000').toFixed(3));
        }
    }
    return out;
}

/**
 * The WCAG 2.1 contrast ratio of two opaque colours.
 * @param {string|object} a
 * @param {string|object} b
 * @returns {number} 1..21, or 0 when a colour cannot be read
 * @exports
 * @ai.hint pure
 */
export function contrastOf(a, b) {
    const first = typeof a === 'object' && a !== null ? a : parseColor(a).color;
    const second = typeof b === 'object' && b !== null ? b : parseColor(b).color;
    if (!first || !second) return 0;
    return wcagContrast(first, second);
}

/**
 * The contrast of a foreground over a background, with the alpha of the foreground applied.
 *
 * A translucent colour has no contrast of its own: it has the contrast of the composite over
 * the surface it sits on.
 * @param {string|object} foreground
 * @param {string|object} background
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function contrastOver(foreground, background) {
    const fg = typeof foreground === 'object' && foreground !== null ? foreground : parseColor(foreground).color;
    const bg = typeof background === 'object' && background !== null ? background : parseColor(background).color;
    if (!fg || !bg) return 0;
    const alpha = typeof toRgb(fg).alpha === 'number' ? toRgb(fg).alpha : 1;
    if (alpha >= 1) return wcagContrast(fg, bg);
    // The backdrop is the background, the source is the translucent colour over it.
    return wcagContrast(blend([bg, fg], 'normal', 'rgb'), bg);
}

/**
 * The perceptual distance between two colours.
 *
 * CIEDE2000 is the default: it is the number a designer accepts as "the same colour seen on
 * two screens". The Euclidean distance in OKLab is the cheap companion.
 * @param {string|object} a
 * @param {string|object} b
 * @returns {{ deltaE2000: number, deltaEOk: number }}
 * @exports
 * @ai.hint pure
 */
export function deltaE(a, b) {
    const first = typeof a === 'object' && a !== null ? a : parseColor(a).color;
    const second = typeof b === 'object' && b !== null ? b : parseColor(b).color;
    if (!first || !second) return { deltaE2000: 0, deltaEOk: 0 };
    return {
        deltaE2000: Number(ciede2000(first, second).toFixed(3)),
        deltaEOk: Number(okDistance(first, second).toFixed(4)),
    };
}

/**
 * The sRGB colour that looks the same as a wide-gamut one: the chroma is clamped until the
 * colour fits the sRGB gamut. A sheet that has to ship a hex needs this.
 * @param {string|object} value
 * @returns {object|null} the culori colour
 * @exports
 * @ai.hint pure
 */
export function toSrgb(value) {
    const color = typeof value === 'object' && value !== null ? value : parseColor(value).color;
    if (!color) return null;
    return clampChroma(color, 'oklch', 'rgb');
}
