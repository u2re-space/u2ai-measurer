/**
 * @file src/stages/segmentate.js
 * @module stages/segmentate
 * @purpose Stage `segmentate`: name the zones of the references and give the box of each one.
 *
 * The segmentation is the cheapest stage of the pipeline and the one the others build on. It
 * answers one question — what is where — and it answers it with boxes, not with measurements.
 * The stage after it does not look for the zones again: it reads them from the file.
 *
 * The boxes the model returns are the pixels of the picture it saw. That picture may be smaller
 * than the file, so the boxes are scaled to the file before they are written down: every stage
 * after this one speaks the pixels of the file.
 *
 * @depends node:path, agent/schemas, stages/references, stages/artifacts
 * @usedBy stages/index, shared/pipeline
 * @exports runSegmentStage
 * @ai.tags stage, segmentation, vision
 * @ai.hint io
 */

import { SEGMENTATION_SCHEMA } from '../agent/schemas.js';
import { attachReference, attachmentBlock, pictureBlock, splitReferences } from './references.js';
import { scaleBox, writeStageFile } from './artifacts.js';

/**
 * Run the segmentation stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, references?: object[],
 *   outDir?: string, notify?: Function|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ segmentation: object|null, file: string|null, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runSegmentStage({
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
    const maxTurns = Math.max(1, Number(config?.stages?.segmentate?.maxTurns) || 6);
    const { attached } = splitReferences(references);
    if (!attached.length) {
        return { segmentation: null, file: null, warnings: ['There is no reference to segment.'] };
    }

    const sources = [];
    const done = new Set();
    for (const item of attached) {
        // The same picture is segmented once: two segmentations of one picture would cut every
        // fragment twice and leave two zone lists of the same screen in the file.
        const key = process.platform === 'win32' ? String(item.rel ?? '').toLowerCase() : String(item.rel ?? '');
        if (done.has(key)) {
            warnings.push(`The reference ${item.rel} was segmented already: it is segmented once.`);
            continue;
        }
        done.add(key);
        const image = await attachReference({ root, rel: item.rel, config });
        if (!image) {
            warnings.push(`The reference ${item.rel} could not be read.`);
            continue;
        }
        const text = [
            attachmentBlock([{ rel: item.rel, role: item.kind === 'subref' ? 'sub-reference' : 'original' }]),
            '',
            pictureBlock(attached),
            '',
            'Split this picture into zones. Give the box of every zone and nothing else.',
            'One zone is one thing: an object that stands in front of another — a piece in front of a board — is two zones, and the box of a zone does not swallow the neighbours it only touches.',
        ].join('\n');
        const answer = await runner.run('segmentator', {
            text,
            parts: [image.part],
            schema: SEGMENTATION_SCHEMA,
            schemaName: 'segmentation',
            maxTurns,
            effort: config?.stages?.segmentate?.effort ?? null,
            signal,
            stage: 'segmentate',
        });
        if (answer.error) {
            warnings.push(`The segmentator failed on ${item.rel}: ${answer.error}`);
            continue;
        }
        const data = answer.data;
        if (!data) {
            warnings.push(`The segmentator did not return a segmentation of ${item.rel}.`);
            continue;
        }
        const zones = [];
        for (const zone of Array.isArray(data.zones) ? data.zones : []) {
            const box = scaleBox(zone?.box, image.scale);
            if (!box) {
                warnings.push(`The zone "${String(zone?.name ?? '')}" of ${item.rel} has no usable box.`);
                continue;
            }
            zones.push({
                name: String(zone?.name ?? ''),
                kind: String(zone?.kind ?? 'other'),
                box,
                role: String(zone?.role ?? ''),
                use: String(zone?.use ?? ''),
                crop: String(zone?.crop ?? 'none'),
                hasText: Boolean(zone?.hasText),
                notes: String(zone?.notes ?? ''),
            });
        }
        sources.push({
            source: item.rel,
            summary: String(data.summary ?? ''),
            canvas: { x: 0, y: 0, width: image.sourceWidth, height: image.sourceHeight },
            scale: image.scale,
            zones,
            notes: String(data.notes ?? ''),
        });
        notify?.({ type: 'segment.zones', source: item.rel, zones: zones.length });
    }

    if (!sources.length) {
        return { segmentation: null, file: null, warnings };
    }

    const segmentation = {
        generatedBy: 'ai-measure',
        stage: 'segmentate',
        createdAt: new Date().toISOString(),
        sources,
    };
    const file = outDir ? await writeStageFile(outDir, 'segmentation', segmentation) : null;
    return { segmentation, file, warnings };
}
