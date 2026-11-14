/**
 * @file src/stages/references.js
 * @module stages/references
 * @purpose The references of a run: which picture the model sees, and which one is only a path.
 *
 * The rules are the same for every stage that looks at a picture:
 *   - a picture is downscaled to the configured longest edge before the model sees it;
 *   - the sub-references come first, because they are the flat screens;
 *   - the originals that produced a sub-reference stay out of the picture, they are paths.
 *
 * @depends node:path, image/sharp, openai/responses
 * @usedBy stages/measure, stages/segmentate, stages/recognize
 * @exports attachReference, attachmentBlock, splitReferences
 * @ai.tags stage, references, vision
 * @ai.hint io
 */

import path from 'node:path';
import { modelBytes, rasterInfo } from '../image/sharp.js';
import { imagePart, textPart } from '../openai/responses.js';

/**
 * Read a reference picture and turn it into an input part the model can see.
 *
 * The picture is downscaled to the configured longest edge: the model reads the layout, and a
 * 4K screenshot costs a lot of tokens for nothing.
 *
 * The size of the file is returned next to the size of the picture the model sees: the model
 * answers in the pixels of the picture it was given, and the stages that cut the file need the
 * pixels of the file.
 * @param {{ root: string, rel: string, config?: object }} options
 * @returns {Promise<{ part: object, width: number, height: number, sourceWidth: number,
 *   sourceHeight: number, scale: number }|null>}
 * @exports
 * @ai.hint io
 */
export async function attachReference({ root, rel, config = {} }) {
    const abs = path.resolve(root, rel);
    const image = await modelBytes(abs, {
        maxSide: Number.isSafeInteger(config?.image?.maxSide) ? config.image.maxSide : 1536,
        format: config?.image?.format === 'jpeg' ? 'jpeg' : 'png',
        quality: Number.isSafeInteger(config?.image?.jpegQuality) ? config.image.jpegQuality : 90,
    }).catch(() => null);
    if (!image) return null;
    const info = await rasterInfo(abs).catch(() => null);
    const sourceWidth = info?.width ?? image.width;
    const sourceHeight = info?.height ?? image.height;
    return {
        part: imagePart(image.bytes, image.mime),
        width: image.width,
        height: image.height,
        sourceWidth,
        sourceHeight,
        // How many pixels of the file one pixel of the picture the model sees is worth.
        scale: image.width ? sourceWidth / image.width : 1,
    };
}

/**
 * The text that tells the model which picture is which.
 *
 * The caption is the only identity of a picture: the model must not count pictures or guess by
 * their position.
 * @param {Array<{ rel: string, role: string }>} attachments
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function attachmentBlock(attachments = []) {
    return attachments
        .map((item, index) => `Attached image ${index + 1}: ${item.rel} (${item.role})`)
        .join('\n');
}

/**
 * The references of a run: the sub-references first, then the originals.
 *
 * The originals that produced a sub-reference are context only: they are not attached, because a
 * tilted picture would invite numbers that belong to no screen.
 * @param {object[]} references
 * @returns {{ attached: object[], context: object[] }}
 * @exports
 * @ai.hint pure
 */
export function splitReferences(references = []) {
    const subrefs = references.filter((item) => item?.kind === 'subref');
    const originals = references.filter((item) => item?.kind === 'original');
    const covered = new Set();
    for (const sub of subrefs) {
        const source = String(sub.source ?? '').trim();
        if (source) covered.add(path.basename(source));
    }
    const context = originals.filter((item) => !covered.has(path.basename(item.rel)));
    return { attached: [...subrefs, ...context], context: originals };
}
