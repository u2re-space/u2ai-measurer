/**
 * @file src/stages/measure.js
 * @module stages/measure
 * @purpose Stage `measure`: the geometry of the zones the segmentation named.
 *
 * The stage does not look for the zones: it reads them from the segmentation. It does not read
 * the texts and it does not name the colours: those are the stages after it. What it does is put
 * the numbers on the zones — the display, the inner and the outer spacing, the borders, the
 * radius, the rotation, the placement — and to name the measures that repeat.
 *
 * The answer is written into `<out>/stages/geometry.json`, so that the stages after it — and the
 * next run — read the numbers without asking the model again.
 *
 * @depends agent/schemas, stages/artifacts, stages/references
 * @usedBy stages/index, shared/pipeline
 * @exports runMeasureStage, zoneLines
 * @ai.tags stage, measure, vision
 * @ai.hint io
 */

import path from 'node:path';
import { GEOMETRY_SCHEMA } from '../agent/schemas.js';
import { attachReference, attachmentBlock, pictureBlock, splitReferences } from './references.js';
import { cropRelPath, readStageFile, writeStageFile } from './artifacts.js';

/**
 * The zones of one source, as a list a person and a model can read.
 * @param {object[]} zones the zones of the source
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function zoneLines(zones = []) {
    return zones
        .map((zone) => {
            const box = zone?.box ?? {};
            const parts = [
                `- ${String(zone?.name ?? '')} (${String(zone?.kind ?? '')})`,
                `at ${box.x ?? '?'},${box.y ?? '?'} ${box.width ?? '?'}×${box.height ?? '?'}`,
            ];
            if (zone?.role) parts.push(`role: ${zone.role}`);
            if (zone?.use) parts.push(`use: ${zone.use}`);
            return parts.join(' — ');
        })
        .join('\n');
}

/**
 * Run the measurement stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, references?: object[],
 *   outDir?: string, notify?: Function|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ geometry: object|null, file: string|null, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runMeasureStage({
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
    const maxTurns = Math.max(1, Number(config?.stages?.measure?.maxTurns) || 8);

    const segmentation = await readStageFile(outDir, 'segmentation');
    if (!segmentation) {
        return { geometry: null, file: null, warnings: ['There is no segmentation to measure: run the segmentate stage first.'] };
    }
    const sources = Array.isArray(segmentation.sources) ? segmentation.sources : [];
    if (!sources.length) {
        return { geometry: null, file: null, warnings: ['The segmentation holds no source.'] };
    }

    // The fragments of the crop stage: they are the parts too small to read in the picture.
    const cropFile = await readStageFile(outDir, 'crops');
    const crops = Array.isArray(cropFile?.crops) ? cropFile.crops : [];

    const { attached } = splitReferences(references);
    const answers = [];
    for (const entry of sources) {
        const source = String(entry?.source ?? '');
        const reference = attached.find((item) => item.rel === source || path.basename(item.rel) === path.basename(source));
        const zones = Array.isArray(entry?.zones) ? entry.zones : [];
        if (!zones.length) continue;

        const parts = [];
        const captions = [];
        if (reference) {
            const image = await attachReference({ root, rel: reference.rel, config });
            if (image) {
                parts.push(image.part);
                captions.push({ rel: reference.rel, role: reference.kind === 'subref' ? 'sub-reference' : 'original' });
            }
        }
        if (!parts.length) {
            warnings.push(`The reference ${source} could not be read: it was not measured.`);
            continue;
        }

        const fragments = crops.filter((crop) => String(crop?.source ?? '') === source);
        const lines = [
            attachmentBlock(captions),
            '',
            '# Zones',
            zoneLines(zones),
        ];
        if (fragments.length) {
            lines.push('', '# Fragments');
            // The paths count from the root of the run: that is where the model opens them.
            lines.push(fragments
                .map((crop) => `- ${cropRelPath({ root, outDir, crop: crop.crop })} — ${crop.kind} "${crop.name}"`)
                .join('\n'));
        }
        lines.push('', pictureBlock(attached), '');
        lines.push('Measure the geometry of these zones. Give the numbers of the zones that carry them.');

        const answer = await runner.run('measurer', {
            text: lines.join('\n'),
            parts,
            schema: GEOMETRY_SCHEMA,
            schemaName: 'geometry',
            maxTurns,
            effort: config?.stages?.measure?.effort ?? null,
            signal,
            stage: 'measure',
        });
        if (answer.error) {
            warnings.push(`The measurer failed on ${source}: ${answer.error}`);
            continue;
        }
        if (!answer.data) {
            warnings.push(`The measurer did not return the geometry of ${source}.`);
            continue;
        }
        answers.push({
            source,
            summary: String(answer.data.summary ?? ''),
            unit: String(answer.data.unit ?? 'px'),
            units: answer.data.units ?? null,
            confidence: String(answer.data.confidence ?? 'unknown'),
            assumptions: Array.isArray(answer.data.assumptions) ? answer.data.assumptions : [],
            elements: Array.isArray(answer.data.elements) ? answer.data.elements : [],
            rules: Array.isArray(answer.data.rules) ? answer.data.rules : [],
            notes: String(answer.data.notes ?? ''),
        });
        notify?.({
            type: 'measure.geometry',
            source,
            elements: answers.at(-1).elements.length,
            rules: answers.at(-1).rules.length,
        });
    }

    if (!answers.length) {
        return { geometry: null, file: null, warnings };
    }

    const geometry = {
        generatedBy: 'ai-measure',
        stage: 'measure',
        createdAt: new Date().toISOString(),
        sources: answers,
    };
    const file = outDir ? await writeStageFile(outDir, 'geometry', geometry) : null;
    return { geometry, file, warnings };
}
