/**
 * @file src/image/canvas.js
 * @module image/canvas
 * @purpose The canvas fallback and the annotation renderer.
 *
 * Two jobs:
 *  - decode a picture when sharp cannot (node-canvas reads the common formats);
 *  - draw the measured boxes over a copy of the reference, so a human can check
 *    the numbers against the picture they came from.
 *
 * @depends canvas
 * @usedBy image/colors, stages/resolve
 * @exports canvasInfo, canvasRgba, annotateImage
 * @ai.tags image, canvas, annotation
 * @ai.hint io
 */

import { createCanvas, loadImage } from 'canvas';

/**
 * The size of a picture, read with node-canvas.
 * @param {string} abs absolute path of the file
 * @returns {Promise<{ width: number, height: number, format: string }>}
 * @ai.hint io
 */
export async function canvasInfo(abs) {
    const image = await loadImage(abs);
    return { width: image.width, height: image.height, format: String(image.type ?? 'unknown') };
}

/**
 * Decode a picture into an RGBA frame with node-canvas.
 * @param {string} abs absolute path of the file
 * @returns {Promise<{ width: number, height: number, data: Buffer }>}
 * @ai.hint io
 */
export async function canvasRgba(abs) {
    const image = await loadImage(abs);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const frame = context.getImageData(0, 0, image.width, image.height);
    return { width: image.width, height: image.height, data: Buffer.from(frame.data) };
}

/**
 * Draw boxes over a copy of a picture.
 *
 * @param {{ input: string, output: string, items?: Array<{ box?: object, label?: string }>, color?: string }} params
 * @returns {Promise<{ width: number, height: number, bytes: number }>}
 * @ai.hint io
 */
export async function annotateImage({ input, output, items = [], color = '#ff3b30' }) {
    const image = await loadImage(input);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    context.lineWidth = Math.max(1, Math.round(Math.min(image.width, image.height) / 400));
    context.strokeStyle = color;
    context.font = `${Math.max(12, Math.round(image.height / 60))}px sans-serif`;
    for (const item of items) {
        const box = item?.box;
        if (!box) continue;
        const x = Math.round(Number(box.x ?? 0));
        const y = Math.round(Number(box.y ?? 0));
        const width = Math.round(Number(box.width ?? 0));
        const height = Math.round(Number(box.height ?? 0));
        if (!(width > 0 && height > 0)) continue;
        context.strokeRect(x, y, width, height);
        const label = String(item.label ?? '').trim();
        if (label) {
            context.fillStyle = color;
            context.fillText(label, x + 2, Math.max(12, y - 4));
        }
    }
    const buffer = canvas.toBuffer('image/png');
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, buffer);
    return { width: image.width, height: image.height, bytes: buffer.length };
}
