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
 * @depends node:path, node:fs/promises
 * @usedBy stages
 * @exports STAGES_DIR, CROPS_DIR, stageFile, writeStageFile, readStageFile, zoneList, scaleBox,
 *          cropSlug
 * @ai.tags stages, artifacts
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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
 * @param {string} outDir the output directory
 * @param {string} name the name of the stage
 * @param {object} data the content of the file
 * @returns {Promise<string>} the path of the written file
 * @exports
 * @ai.hint io
 */
export async function writeStageFile(outDir, name, data) {
    const file = stageFile(outDir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
