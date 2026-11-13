/**
 * @file src/image/sharp.js
 * @module image/sharp
 * @purpose The raster operations of the CLI, done with sharp: metadata, RGBA frames,
 *          cropping, splitting into a grid and the copy that goes to the model.
 *
 * Everything here is local: no network, no API. The measurer needs exact pixels,
 * not a picture the model may guess about.
 *
 * @depends sharp
 * @usedBy image/colors, image/crop, agent/tools, stages/crop
 * @exports rasterInfo, rasterRgba, rasterCrop, rasterSplit, rasterResize, modelBytes, splitGrid
 * @ai.tags image, raster, sharp
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

/** Formats sharp is asked to read. */
const SUPPORTED = Object.freeze(['png', 'jpeg', 'jpg', 'webp', 'gif', 'tiff', 'avif']);

/**
 * The metadata of a picture: its pixel size and its format.
 * @param {string} abs absolute path of the file
 * @returns {Promise<{ width: number, height: number, format: string }>}
 * @ai.hint io
 */
export async function rasterInfo(abs) {
    const meta = await sharp(abs).metadata();
    const format = String(meta.format ?? '').toLowerCase();
    return {
        width: Number(meta.width ?? 0),
        height: Number(meta.height ?? 0),
        format: SUPPORTED.includes(format) ? format : (format || 'unknown'),
    };
}

/**
 * Decode a picture into an RGBA frame.
 *
 * The frame is what the colour sampler reads: `data` holds four bytes per pixel
 * in the order red, green, blue, alpha.
 * @param {string} abs absolute path of the file
 * @param {{ maxSide?: number|null }} [options] longest-edge cap of the decoded frame
 * @returns {Promise<{ width: number, height: number, data: Buffer }>}
 * @ai.hint io
 */
export async function rasterRgba(abs, { maxSide = null } = {}) {
    let pipeline = sharp(abs, { failOn: 'none' }).ensureAlpha();
    if (Number.isSafeInteger(maxSide) && maxSide > 0) {
        pipeline = pipeline.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    }
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}

/**
 * Cut a rectangle out of a picture and write it as a PNG.
 * @param {{ input: string, output: string, x: number, y: number, width: number, height: number }} params
 * @returns {Promise<{ width: number, height: number, bytes: number }>}
 * @ai.hint io
 */
export async function rasterCrop({ input, output, x = 0, y = 0, width, height }) {
    await mkdir(path.dirname(output), { recursive: true });
    const pipeline = sharp(input, { failOn: 'none' })
        .extract({ left: Math.max(0, Math.trunc(x)), top: Math.max(0, Math.trunc(y)), width: Math.trunc(width), height: Math.trunc(height) });
    const info = await pipeline.png().toFile(output);
    return { width: info.width, height: info.height, bytes: info.size };
}

/**
 * The tiles of a grid: their boxes and their positions inside the picture.
 * @param {{ width: number, height: number, rows: number, cols: number }} params
 * @returns {Array<{ x: number, y: number, width: number, height: number, row: number, col: number }>}
 * @ai.hint pure
 */
export function splitGrid({ width, height, rows = 1, cols = 1 }) {
    const rowCount = Math.max(1, Math.trunc(rows));
    const colCount = Math.max(1, Math.trunc(cols));
    const tiles = [];
    for (let row = 0; row < rowCount; row++) {
        for (let col = 0; col < colCount; col++) {
            const x = Math.floor((width * col) / colCount);
            const y = Math.floor((height * row) / rowCount);
            const right = Math.floor((width * (col + 1)) / colCount);
            const bottom = Math.floor((height * (row + 1)) / rowCount);
            tiles.push({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y), row, col });
        }
    }
    return tiles;
}

/**
 * Cut a picture into a grid of equal tiles.
 * @param {{ input: string, outputDir: string, rows?: number, cols?: number, baseName?: string }} params
 * @returns {Promise<Array<{ file: string, x: number, y: number, width: number, height: number, row: number, col: number }>>}
 * @ai.hint io
 */
export async function rasterSplit({ input, outputDir, rows = 1, cols = 1, baseName = 'tile' }) {
    await mkdir(outputDir, { recursive: true });
    const info = await rasterInfo(input);
    const tiles = splitGrid({ width: info.width, height: info.height, rows, cols });
    const out = [];
    for (const tile of tiles) {
        const file = path.join(outputDir, `${baseName}-${tile.row + 1}-${tile.col + 1}.png`);
        const cut = await rasterCrop({
            input, output: file,
            x: tile.x, y: tile.y, width: tile.width, height: tile.height,
        });
        out.push({ file, ...tile, width: cut.width, height: cut.height });
    }
    return out;
}

/**
 * Write a copy of a picture with the longest edge capped at `maxSide`.
 * @param {{ input: string, output: string, maxSide?: number|null, format?: string, quality?: number }} params
 * @returns {Promise<{ width: number, height: number, bytes: number }>}
 * @ai.hint io
 */
export async function rasterResize({ input, output, maxSide = null, format = 'png', quality = 90 }) {
    await mkdir(path.dirname(output), { recursive: true });
    let pipeline = sharp(input, { failOn: 'none' });
    if (Number.isSafeInteger(maxSide) && maxSide > 0) {
        pipeline = pipeline.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    }
    if (format === 'jpeg' || format === 'jpg') pipeline = pipeline.jpeg({ quality });
    else if (format === 'webp') pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.png();
    const info = await pipeline.toFile(output);
    return { width: info.width, height: info.height, bytes: info.size };
}

/**
 * The bytes of a picture as the model should see it: downscaled to the configured
 * longest edge and encoded in the configured format.
 * @param {string} abs absolute path of the file
 * @param {{ maxSide?: number|null, format?: string, quality?: number }} [options]
 * @returns {Promise<{ bytes: Buffer, mime: string, width: number, height: number }>}
 * @ai.hint io
 */
export async function modelBytes(abs, { maxSide = 1536, format = 'png', quality = 90 } = {}) {
    const info = await rasterInfo(abs);
    let pipeline = sharp(abs, { failOn: 'none' });
    if (Number.isSafeInteger(maxSide) && maxSide > 0) {
        pipeline = pipeline.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    }
    if (format === 'jpeg' || format === 'jpg') pipeline = pipeline.jpeg({ quality });
    else if (format === 'webp') pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.png();
    const { data, info: out } = await pipeline.toBuffer({ resolveWithObject: true });
    const mime = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : (format === 'webp' ? 'image/webp' : 'image/png');
    return { bytes: data, mime, width: out.width, height: out.height, sourceWidth: info.width, sourceHeight: info.height };
}
