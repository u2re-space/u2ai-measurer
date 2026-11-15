/**
 * @file src/stages/cropper.js
 * @module stages/cropper
 * @purpose Stage `crop`: cut the fragments of the references into files.
 *
 * The stage works in two modes:
 *   - local (the default): the harness cuts the boxes the segmentation named. No model, no
 *     tokens, no money — and the boxes are the ones the segmentator already looked at.
 *   - ai: the cropper reads the picture and names the fragments that are worth cutting; the
 *     harness cuts them anyway.
 *
 * The fragments land in `<out>/crops/` and their list in `<out>/stages/crops.json`, so that the
 * stages after this one — and the next run — know what was cut and from where.
 *
 * @depends node:path, node:fs/promises, image/sharp, image/crop, agent/schemas,
 *          stages/artifacts, stages/references
 * @usedBy stages/index, shared/pipeline
 * @exports runCropStage, planFromZones
 * @ai.tags stage, crops, images
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { rasterCrop, rasterInfo } from '../image/sharp.js';
import { clampRect, sameFragment } from '../image/crop.js';
import { CROP_PLAN_SCHEMA } from '../agent/schemas.js';
import { attachReference, attachmentBlock, pictureBlock, splitReferences } from './references.js';
import { CROPS_DIR, cropSlug, readStageFile, scaleBox, writeStageFile } from './artifacts.js';

/**
 * The fragments the segmentation named.
 *
 * A zone that is marked `none` is not cut: the box of the zone is enough. A zone that is marked
 * `asset` or `detail` is worth a file of its own.
 * @param {object} segmentation the segmentation file
 * @returns {Array<object>}
 * @exports
 * @ai.hint pure
 */
export function planFromZones(segmentation) {
    const sources = Array.isArray(segmentation?.sources) ? segmentation.sources : [];
    const plan = [];
    for (const entry of sources) {
        for (const zone of Array.isArray(entry?.zones) ? entry.zones : []) {
            const kind = String(zone?.crop ?? 'none');
            if (kind === 'none') continue;
            const box = zone?.box ?? {};
            if (![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(Number(value)))) continue;
            plan.push({
                name: String(zone?.name ?? ''),
                kind: kind === 'asset' ? 'asset' : 'detail',
                box,
                source: String(entry?.source ?? ''),
                role: String(zone?.role ?? ''),
                use: String(zone?.use ?? ''),
            });
        }
    }
    return plan;
}

/**
 * Run the crop stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, references?: object[],
 *   outDir?: string, notify?: Function|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ crops: object[], file: string|null, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runCropStage({
    root,
    workId,
    config,
    runner,
    references = [],
    outDir = null,
    notify = null,
    signal = null,
}) {
    const warnings = [];
    const mode = config?.stages?.crop?.mode ?? 'local';
    const maxTurns = Math.max(1, Number(config?.stages?.crop?.maxTurns) || 6);
    const maxCrops = Number.isSafeInteger(config?.stages?.crop?.maxCrops) ? config.stages.crop.maxCrops : 192;

    const segmentation = await readStageFile(outDir, 'segmentation');
    if (!segmentation) {
        return { crops: [], file: null, warnings: ['There is no segmentation to cut: run the segmentate stage first.'] };
    }

    // The folder of the fragments belongs to this run.
    //
    // The fragments of the previous run are not the fragments of this one: a folder that keeps
    // them holds every picture ever cut, and the reader cannot tell which of them the
    // measurement sheet talks about.
    const dir = path.join(outDir, CROPS_DIR);
    await mkdir(dir, { recursive: true });
    await clearCrops(dir, warnings);

    let plan = planFromZones(segmentation);
    if (mode === 'ai') {
        const asked = await askCropper({ root, workId, config, runner, references, segmentation, maxTurns, signal, warnings });
        if (asked.length) plan = asked;
        else warnings.push('The cropper named no fragment: the fragments of the segmentation are cut.');
    }
    if (!plan.length) {
        return { crops: [], file: null, warnings };
    }

    // The files the fragments are cut from: the references of the run.
    const files = new Map();
    for (const item of references) {
        if (item?.rel) files.set(item.rel, path.resolve(root, item.rel));
        if (item?.rel) files.set(path.basename(item.rel), path.resolve(root, item.rel));
    }

    const crops = [];
    // The rectangles that are already cut, per picture.
    //
    // Two zones of the same picture that name the same object are the same fragment: the model
    // names the box a little differently every time it looks, so the boxes are compared by the
    // place they cover and the size they have, not by their numbers. Two pictures may hold the
    // same box: the key is the picture, not the box.
    const cutRects = new Map();
    const cap = maxCrops > 0 ? maxCrops : null;
    for (const item of plan) {
        if (cap && crops.length >= cap) {
            warnings.push(`The cap of ${cap} fragments was reached: the rest was not cut.`);
            break;
        }
        const source = String(item?.source ?? '');
        const file = files.get(source) ?? files.get(path.basename(source)) ?? [...files.values()][0];
        if (!file) {
            warnings.push(`The source "${source}" of the fragment "${String(item?.name ?? '')}" is not among the references.`);
            continue;
        }
        // The boxes of the plan are the pixels of the file already: the segmentation scaled them
        // when it wrote them down, and the cropper scaled them when it named them.
        const box = item?.box ?? {};
        if (![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(Number(value)))) {
            warnings.push(`The fragment "${String(item?.name ?? '')}" has no usable box.`);
            continue;
        }
        const info = await rasterInfo(file).catch(() => null);
        if (!info?.width || !info?.height) {
            warnings.push(`The size of ${path.basename(file)} could not be read: the fragment was not cut.`);
            continue;
        }
        const rect = clampRect(box, info);
        const taken = cutRects.get(file) ?? [];
        const twin = taken.find((other) => sameFragment(other, rect));
        if (twin) {
            warnings.push(`The fragment "${String(item?.name ?? '')}" covers the same object as the fragment "${twin.name}": it was not cut again.`);
            continue;
        }
        taken.push({ ...rect, name: String(item?.name ?? '') });
        cutRects.set(file, taken);
        const name = `${String(crops.length + 1).padStart(2, '0')}-${item.kind === 'asset' ? 'asset' : 'detail'}-${cropSlug(item?.name, 'crop')}.png`;
        const output = path.join(dir, name);
        try {
            const cut = await rasterCrop({
                input: file,
                output,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            });
            crops.push({
                name: String(item?.name ?? ''),
                kind: item.kind === 'asset' ? 'asset' : 'detail',
                crop: `${CROPS_DIR}/${name}`,
                box: rect,
                source: source || path.basename(file),
                role: String(item?.role ?? ''),
                use: String(item?.use ?? ''),
                width: cut.width,
                height: cut.height,
                bytes: cut.bytes,
            });
        } catch (error) {
            warnings.push(`The fragment "${String(item?.name ?? '')}" could not be cut: ${error?.message ?? error}`);
        }
    }

    if (crops.length) {
        notify?.({
            type: 'crop.done',
            crops: crops.map((item) => ({ crop: item.crop, kind: item.kind, name: item.name })),
        });
    }

    const file = outDir ? await writeStageFile(outDir, 'crops', {
        generatedBy: 'ai-measure',
        stage: 'crop',
        mode,
        createdAt: new Date().toISOString(),
        crops,
    }) : null;
    return { crops, file, warnings };
}

/**
 * Clear the folder of the fragments before the run cuts new ones.
 *
 * Only the files are removed: a folder of the run that holds something else is left alone.
 * @param {string} dir the folder of the fragments
 * @param {string[]} warnings the warnings of the stage
 * @returns {Promise<void>}
 */
async function clearCrops(dir, warnings) {
    let names = [];
    try {
        names = await readdir(dir);
    } catch {
        return;
    }
    for (const name of names) {
        const file = path.join(dir, name);
        try {
            const info = await stat(file);
            if (!info.isFile()) continue;
            await rm(file, { force: true });
        } catch (error) {
            warnings.push(`The old fragment ${name} could not be removed: ${error?.message ?? error}`);
        }
    }
}

/**
 * Ask the cropper which fragments are worth cutting.
 * @param {object} options the options of the stage
 * @returns {Promise<Array<object>>}
 */
async function askCropper({ root, workId, config, runner, references, segmentation, maxTurns, signal, warnings }) {
    const { attached } = splitReferences(references);
    const plan = [];
    for (const item of attached) {
        const image = await attachReference({ root, rel: item.rel, config });
        if (!image) continue;
        const text = [
            attachmentBlock([{ rel: item.rel, role: item.kind === 'subref' ? 'sub-reference' : 'original' }]),
            '',
            pictureBlock(attached),
            '',
            'Name the fragments of this picture that are worth cutting out.',
            'One fragment per object: an object that stands in front of another — a piece in front of a board — is two fragments.',
        ].join('\n');
        const answer = await runner.run('cropper', {
            text,
            parts: [image.part],
            schema: CROP_PLAN_SCHEMA,
            schemaName: 'crop_plan',
            maxTurns,
            effort: config?.stages?.crop?.effort ?? null,
            signal,
            stage: 'crop',
        });
        if (answer.error) {
            warnings.push(`The cropper failed on ${item.rel}: ${answer.error}`);
            continue;
        }
        for (const crop of Array.isArray(answer.data?.crops) ? answer.data.crops : []) {
            const box = scaleBox(crop?.box, image.scale);
            if (!box) continue;
            plan.push({
                name: String(crop?.name ?? ''),
                kind: 'asset',
                box,
                source: item.rel,
                role: String(crop?.how ?? ''),
                use: String(crop?.use ?? ''),
            });
        }
    }
    return plan;
}
