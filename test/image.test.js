/**
 * @file test/image.test.js
 * @purpose Tests of the raster layer: the metadata, the crop, the split and the copy that goes
 *          to the model.
 * @depends node:test, image/sharp, image/crop
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';

import { modelBytes, rasterCrop, rasterInfo, rasterSplit, splitGrid } from '../src/image/sharp.js';
import { clampRect, normalizeBox } from '../src/image/crop.js';

/**
 * A picture in a temporary directory.
 * @param {{ width?: number, height?: number }} options
 * @returns {Promise<{ dir: string, file: string, cleanup: () => Promise<void> }>}
 */
async function picture({ width = 100, height = 50 } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-image-'));
    const file = path.join(dir, 'picture.png');
    await sharp({
        create: { width, height, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } },
    }).png().toFile(file);
    return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the metadata of a picture holds its size and its format', async () => {
    const pic = await picture({ width: 120, height: 60 });
    try {
        const info = await rasterInfo(pic.file);
        assert.equal(info.width, 120);
        assert.equal(info.height, 60);
        assert.equal(info.format, 'png');
    } finally {
        await pic.cleanup();
    }
});

test('a crop has the size it was asked for', async () => {
    const pic = await picture();
    try {
        const output = path.join(pic.dir, 'cut.png');
        const cut = await rasterCrop({ input: pic.file, output, x: 10, y: 5, width: 30, height: 20 });
        assert.equal(cut.width, 30);
        assert.equal(cut.height, 20);
        const info = await rasterInfo(output);
        assert.equal(info.width, 30);
        assert.equal(info.height, 20);
    } finally {
        await pic.cleanup();
    }
});

test('a rectangle is clamped to the picture', () => {
    const frame = { width: 100, height: 50 };
    const box = clampRect({ x: 90, y: 40, width: 40, height: 40 }, frame);
    assert.equal(box.x, 90);
    assert.equal(box.y, 40);
    assert.equal(box.width, 10);
    assert.equal(box.height, 10);
});

test('a rectangle with a negative edge is moved into the picture', () => {
    const box = clampRect({ x: -10, y: -5, width: 40, height: 20 }, { width: 100, height: 50 });
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    assert.equal(box.width, 40);
    assert.equal(box.height, 20);
});

test('the box of a picture is normalized into numbers', () => {
    const box = normalizeBox({ x: '10', y: '5', width: '30', height: '20' });
    assert.deepEqual(box, { x: 10, y: 5, width: 30, height: 20 });
});

test('a picture is split into a grid of tiles', async () => {
    const pic = await picture({ width: 100, height: 50 });
    try {
        const outDir = path.join(pic.dir, 'tiles');
        const tiles = await rasterSplit({ input: pic.file, outputDir: outDir, rows: 2, cols: 4, baseName: 'tile' });
        assert.equal(tiles.length, 8);
        for (const tile of tiles) {
            const info = await rasterInfo(tile.file);
            assert.equal(info.width, tile.width);
            assert.equal(info.height, tile.height);
        }
        // Every tile of a row covers the row, and the rows cover the picture.
        const row = tiles.filter((tile) => tile.row === 0);
        assert.equal(row.reduce((sum, tile) => sum + tile.width, 0), 100);
    } finally {
        await pic.cleanup();
    }
});

test('the grid of a picture divides it exactly', () => {
    const tiles = splitGrid({ width: 100, height: 50, rows: 2, cols: 2 });
    assert.equal(tiles.length, 4);
    assert.deepEqual(tiles.map((tile) => [tile.x, tile.y, tile.width, tile.height]), [
        [0, 0, 50, 25],
        [50, 0, 50, 25],
        [0, 25, 50, 25],
        [50, 25, 50, 25],
    ]);
});

test('the copy for the model is downscaled to the longest edge', async () => {
    const pic = await picture({ width: 400, height: 200 });
    try {
        const copy = await modelBytes(pic.file, { maxSide: 100, format: 'png' });
        assert.equal(copy.width, 100);
        assert.equal(copy.height, 50);
        assert.equal(copy.mime, 'image/png');
        assert.equal(copy.sourceWidth, 400);
        assert.ok(copy.bytes.length > 0);
    } finally {
        await pic.cleanup();
    }
});
