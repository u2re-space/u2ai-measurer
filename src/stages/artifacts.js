/**
 * @file src/stages/artifacts.js
 * @module stages/artifacts
 * @purpose The files the stages leave for each other.
 *
 * Every stage writes its own file into `<out>/stages/` and reads the files of the stages before
 * it from the same place. The file is the contract, not the state of the process: that is what
 * lets a stage run on its own, in another run, on the artifacts of the previous one.
 *
 *   segmentation.json  the zones and the boxes of the references
 *   crops.json         the fragments that were cut, and the boxes they were cut from
 *   geometry.json      the numbers of the zones
 *   recognition.json   the texts and the typography
 *   palette.json       the colours
 *
 * The path of a fragment is counted from the root of the project — the stage files, the prompt
 * and the sheet of the delivery name it the same way.
 *
 * @depends node:path, node:fs/promises, shared/house
 * @usedBy stages
 * @exports STAGES_DIR, CROPS_DIR, stageFile, writeStageFile, readStageFile, zoneList, scaleBox,
 *          cropSlug, cropRelPath, deliveryRel
 * @ai.tags stages, artifacts
 * @ai.hint io
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../shared/house.js';

/** The directory of the stage files, relative to the output directory. */
export const STAGES_DIR = 'stages';

/** The directory of the fragments, relative to the output directory. */
export const CROPS_DIR = 'crops';

/**
 * The path of the file of one stage.
 * @param {string} outDir the output directory
 * @param {string} name the name of the stage
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stageFile(outDir, name) {
    return path.join(outDir, STAGES_DIR, `${name}.json`);
}

/**
 * Write the file of one stage.
 *
 * The write is atomic: the file appears whole, so a stage that dies in the middle leaves the
 * old file and not half of a new one.
 * @param {string} outDir the output directory
 * @param {string} name the name of the stage
 * @param {object} data the content of the file
 * @returns {Promise<string>} the path of the written file
 * @exports
 * @ai.hint io
 */
export async function writeStageFile(outDir, name, data) {
    const file = stageFile(outDir, name);
    await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    return file;
}

/**
 * Read the file of one stage.
 *
 * A stage that never ran has no file: the reader gets null and decides what to do with it.
 * @param {string} outDir the output directory
 * @param {string} name the name of the stage
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function readStageFile(outDir, name) {
    if (!outDir) return null;
    try {
        return JSON.parse(await readFile(stageFile(outDir, name), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The zones of a segmentation, as one flat list.
 *
 * Every zone carries the source it belongs to: the segmentation of several references keeps
 * them apart, and the stages after it do not have to care.
 * @param {object} segmentation the segmentation file
 * @returns {Array<object>}
 * @exports
 * @ai.hint pure
 */
export function zoneList(segmentation) {
    const sources = Array.isArray(segmentation?.sources) ? segmentation.sources : [];
    const out = [];
    for (const entry of sources) {
        const zones = Array.isArray(entry?.zones) ? entry.zones : [];
        for (const zone of zones) {
            out.push({ ...zone, source: String(entry?.source ?? '') });
        }
    }
    return out;
}

/**
 * A filesystem-safe short name for a crop file.
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function cropSlug(value, fallback = 'crop') {
    const base = String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return (base || fallback).slice(0, 48);
}

/**
 * The delivery of the run, as the project sees it: relative, with slashes.
 *
 * The delivery is where the run puts what it made: `measurements/` by default. The path is
 * counted from the root of the project, so it means the same thing in the prompt, in the
 * manifest and in the contract of the project.
 * @param {string} root the root of the project
 * @param {string|null} [outDir] the delivery, absolute or relative to the root
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function deliveryRel(root, outDir = null) {
    const base = path.resolve(String(root ?? '.'));
    const abs = outDir ? path.resolve(base, outDir) : base;
    const rel = path.relative(base, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '.';
    return rel.split(path.sep).join('/');
}

/**
 * The path of a fragment the way the model has to name it.
 *
 * One base for every path of a fragment: the stage files, the prompt and the sheet of the
 * delivery name it from the root of the project. A path of an older run counts from the
 * delivery and is repointed to the root.
 * @param {{ root: string, outDir?: string|null, crop?: string }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function cropRelPath({ root, outDir = null, crop = '' }) {
    const base = path.resolve(String(root ?? '.'));
    const text = String(crop ?? '').trim().replace(/\\/g, '/');
    if (!text) return '';
    if (path.isAbsolute(text)) return text.split(path.sep).join('/');
    const delivery = deliveryRel(root, outDir);
    if (delivery !== '.' && !text.startsWith(`${delivery}/`)) {
        const rel = path.relative(base, path.resolve(base, delivery, text));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    return text;
}

/**
 * The box of a zone in the pixels of the file, not of the picture the model saw.
 *
 * The model answers in the pixels of the picture it was given, and that picture may be smaller
 * than the file. The factor of the source tells how much one of its pixels is worth.
 * @param {object} box the box of the zone
 * @param {number} scale the factor of the source
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 * @exports
 * @ai.hint pure
 */
export function scaleBox(box, scale) {
    const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const num = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.round(parsed * factor) : null;
    };
    const out = {
        x: num(box?.x),
        y: num(box?.y),
        width: num(box?.width),
        height: num(box?.height),
    };
    return Object.values(out).every((value) => value !== null) ? out : null;
}
