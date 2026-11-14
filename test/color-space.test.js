/**
 * @file test/color-space.test.js
 * @purpose Tests of the colour spaces: the parsing of a CSS colour, the notations, the contrast
 *          and the distance between two colours.
 * @depends node:test, image/color-space
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { colorNotations, contrastOf, contrastOver, deltaE, describeColor, parseColor, toSrgb } from '../src/image/color-space.js';

test('a CSS colour is parsed in every notation', () => {
    const parsed = parseColor('#f1463f');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.error, null);

    const notations = colorNotations('#f1463f');
    assert.equal(notations.hex, '#f1463f');
    assert.equal(notations.rgb, 'rgb(241 70 63)');
    assert.match(notations.hsl, /^hsl\(2\.4 86\.4% 59\.6%\)$/);
    assert.match(notations.oklch, /^oklch\(0\.6414 0\.2087 27\.2\)$/);
    assert.match(notations.lab, /^lab\(/);
    assert.match(notations.p3, /^color\(display-p3 /);
    assert.equal(notations.alpha, 1);
    assert.equal(notations.inSrgb, true);
});

test('an OKLCH colour is parsed back into hex', () => {
    const notations = colorNotations('oklch(0.64 0.21 27)');
    assert.match(notations.hex, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(Number(notations.oklch.match(/oklch\(([^ ]+)/)[1]) - 0.64) < 0.001);
});

test('an alpha is kept', () => {
    const notations = colorNotations('rgb(241 70 63 / 0.5)');
    assert.equal(notations.alpha, 0.5);
    assert.match(notations.oklch, /\/ 0\.5\)$/);
    assert.equal(notations.hex8, '#f1463f80');
});

test('a colour that is not a colour is refused', () => {
    const parsed = parseColor('not-a-colour');
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error);
    assert.equal(colorNotations('not-a-colour'), null);
    assert.equal(describeColor('not-a-colour'), null);
});

test('the contrast of black on white is 21:1', () => {
    assert.ok(Math.abs(contrastOf('#000000', '#ffffff') - 21) < 0.001);
    assert.ok(Math.abs(contrastOf('#ffffff', '#000000') - 21) < 0.001);
    assert.ok(Math.abs(contrastOf('#ffffff', '#ffffff') - 1) < 0.001);
});

test('the contrast of a translucent colour is the contrast of the composite', () => {
    const solid = contrastOver('#000000', '#ffffff');
    const half = contrastOver('rgb(0 0 0 / 0.5)', '#ffffff');
    assert.ok(half < solid, 'a translucent black is lighter than an opaque one');
    assert.ok(half > 1);
});

test('the distance between two colours is told', () => {
    const near = deltaE('#f1463f', '#f04030');
    const far = deltaE('#f1463f', '#1c1c1b');
    assert.ok(near.deltaE2000 < far.deltaE2000);
    assert.ok(near.deltaEOk < far.deltaEOk);
});

test('a wide gamut colour is told from an sRGB one', () => {
    const wide = colorNotations('color(display-p3 1 0 0)');
    assert.equal(wide.inSrgb, false);
    assert.match(wide.note, /does not fit sRGB/);
    assert.equal(toSrgb('color(display-p3 1 0 0)') !== null, true);
});

test('a colour is described with the contrast against a second one', () => {
    const described = describeColor('#f1463f', { against: '#ffffff' });
    assert.equal(described.against, '#ffffff');
    assert.ok(Math.abs(described.contrast - 3.692) < 0.01);
});
