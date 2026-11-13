/**
 * @file test/colors.test.js
 * @purpose Tests of the colour layer: the conversions, the contrast and the sampling of the
 *          actual pixels.
 * @depends node:test, image/colors, image/sharp
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import {
    contrastRatio, hslFromRgb, oklchCss, relLuminance, srgbToOklch, sampleColors, colorSpaceNote,
} from '../src/image/colors.js';
import { rasterInfo } from '../src/image/sharp.js';

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/**
 * A solid picture in a temporary directory.
 * @param {{ width?: number, height?: number, r?: number, g?: number, b?: number }} options
 * @returns {Promise<{ dir: string, file: string, cleanup: () => Promise<void> }>}
 */
async function solidPicture({ width = 64, height = 64, r = 255, g = 0, b = 0 } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-colors-'));
    const file = path.join(dir, 'solid.png');
    const sharp = (await import('sharp')).default;
    await sharp({
        create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } },
    }).png().toFile(file);
    return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the relative luminance of black and white are the ends of the scale', () => {
    assert.equal(relLuminance(WHITE), 1);
    assert.equal(relLuminance(BLACK), 0);
});

test('the contrast of black on white is 21:1', () => {
    assert.equal(Math.round(contrastRatio(WHITE, BLACK) * 100) / 100, 21);
    assert.equal(Math.round(contrastRatio(WHITE, WHITE) * 100) / 100, 1);
});

test('the contrast is symmetric', () => {
    assert.equal(contrastRatio(WHITE, BLACK), contrastRatio(BLACK, WHITE));
});

test('sRGB is converted to OKLCH', () => {
    const white = srgbToOklch(WHITE);
    assert.equal(Math.round(white.l * 1000) / 1000, 1);
    assert.equal(Math.round(white.c * 1000) / 1000, 0);
    const red = srgbToOklch({ r: 255, g: 0, b: 0 });
    assert.ok(red.l > 0.5 && red.l < 0.7);
    assert.ok(red.c > 0.2);
});

test('the OKLCH value is written in the CSS form', () => {
    const value = srgbToOklch({ r: 255, g: 0, b: 0 });
    assert.match(oklchCss(value), /^oklch\(/);
});

test('HSL is converted from the bytes', () => {
    const hsl = hslFromRgb({ r: 255, g: 0, b: 0 });
    assert.equal(Math.round(hsl.h), 0);
    assert.equal(Math.round(hsl.s), 100);
    assert.equal(Math.round(hsl.l), 50);
});

test('the sampled colour of a solid picture is the colour of the picture', async () => {
    const picture = await solidPicture({ r: 255, g: 0, b: 0 });
    try {
        const info = await rasterInfo(picture.file);
        assert.equal(info.width, 64);
        assert.equal(info.height, 64);
        const result = await sampleColors({ abs: picture.file, k: 3 });
        assert.ok(result.colors.length >= 1);
        assert.equal(result.colors[0].hex.toLowerCase(), '#ff0000');
        assert.ok(result.colors[0].oklch.startsWith('oklch('));
        assert.ok(result.background);
        assert.equal(result.background.hex.toLowerCase(), '#ff0000');
    } finally {
        await picture.cleanup();
    }
});

test('the sampling reads a box of the picture', async () => {
    const picture = await solidPicture({ width: 100, height: 100, r: 0, g: 0, b: 255 });
    try {
        const result = await sampleColors({ abs: picture.file, box: { x: 10, y: 10, width: 20, height: 20 }, k: 2 });
        assert.equal(result.colors[0].hex.toLowerCase(), '#0000ff');
    } finally {
        await picture.cleanup();
    }
});

test('the colour space note names the working space', () => {
    const note = colorSpaceNote();
    assert.equal(note.working, 'sRGB');
    assert.match(note.assumption, /ICC profile/);
});
