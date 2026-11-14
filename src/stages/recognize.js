/**
 * @file src/stages/recognize.js
 * @module stages/recognize
 * @purpose Stage `recognize`: read the texts and the typography of the zones.
 *
 * The stage reads the segmentation to know which zones hold text, and the fragments of the crop
 * stage to read them: a fragment of a caption is cheaper to read than a whole screen, and it is
 * read more accurately.
 *
 * The answer is written into `<out>/stages/recognition.json`: the words, the font families, the
 * sizes, the weights and the line heights.
 *
 * @depends agent/schemas, stages/artifacts, stages/references
 * @usedBy stages/index, shared/pipeline
 * @exports runRecognizeStage
 * @ai.tags stage, recognition, typography
 * @ai.hint io
 */

import path from 'node:path';
import { RECOGNITION_SCHEMA } from '../agent/schemas.js';
import { attachImage, attachmentBlock, splitReferences } from './references.js';
import { readStageFile, writeStageFile } from './artifacts.js';

/** How many fragments one call may carry. */
const MAX_FRAGMENTS = 12;

/**
 * Run the recognition stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, references?: object[],
 *   outDir?: string, notify?: Function|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ recognition: object|null, file: string|null, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runRecognizeStage({
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
    const maxTurns = Math.max(1, Number(config?.stages?.recognize?.maxTurns) || 8);

    const segmentation = await readStageFile(outDir, 'segmentation');
    if (!segmentation) {
        return { recognition: null, file: null, warnings: ['There is no segmentation to read: run the segmentate stage first.'] };
    }
    const cropFile = await readStageFile(outDir, 'crops');
    const crops = Array.isArray(cropFile?.crops) ? cropFile.crops : [];
    const { attached } = splitReferences(references);

    const sources = Array.isArray(segmentation.sources) ? segmentation.sources : [];
    const answers = [];
    for (const entry of sources) {
        const source = String(entry?.source ?? '');
        const zones = (Array.isArray(entry?.zones) ? entry.zones : []).filter((zone) => zone?.hasText);
        if (!zones.length) continue;

        const parts = [];
        const captions = [];
        // The fragments of the text zones first: they are the readable ones.
        const fragments = crops.filter((crop) => String(crop?.source ?? '') === source).slice(0, MAX_FRAGMENTS);
        for (const fragment of fragments) {
            const file = path.resolve(outDir ?? root, fragment.crop);
            const image = await attachImage({ abs: file, config });
            if (!image) continue;
            parts.push(image.part);
            captions.push({ rel: fragment.crop, role: 'fragment' });
        }
        // The whole picture when no fragment of the text zones was cut.
        if (!parts.length) {
            const reference = attached.find((item) => item.rel === source || path.basename(item.rel) === path.basename(source));
            if (reference) {
                const image = await attachImage({ abs: path.resolve(root, reference.rel), config });
                if (image) {
                    parts.push(image.part);
                    captions.push({ rel: reference.rel, role: 'original' });
                }
            }
        }
        if (!parts.length) {
            warnings.push(`The reference ${source} could not be read: its texts were not recognized.`);
            continue;
        }

        const lines = [
            attachmentBlock(captions),
            '',
            '# Zones with text',
            zones.map((zone) => `- ${String(zone?.name ?? '')} (${String(zone?.role ?? '')})`).join('\n'),
            '',
            '# Work directory',
            `.tmp/${workId}/`,
            '',
            'Read the texts of these zones and the typography they use.',
        ];
        const answer = await runner.run('recognizer', {
            text: lines.join('\n'),
            parts,
            schema: RECOGNITION_SCHEMA,
            schemaName: 'recognition',
            maxTurns,
            effort: config?.stages?.recognize?.effort ?? null,
            signal,
        });
        if (answer.error) {
            warnings.push(`The recognizer failed on ${source}: ${answer.error}`);
            continue;
        }
        if (!answer.data) {
            warnings.push(`The recognizer did not return the texts of ${source}.`);
            continue;
        }
        answers.push({
            source,
            summary: String(answer.data.summary ?? ''),
            texts: Array.isArray(answer.data.texts) ? answer.data.texts : [],
            notes: String(answer.data.notes ?? ''),
        });
        notify?.({ type: 'recognize.texts', source, texts: answers.at(-1).texts.length });
    }

    if (!answers.length) {
        return { recognition: null, file: null, warnings };
    }

    const recognition = {
        generatedBy: 'ai-measure',
        stage: 'recognize',
        createdAt: new Date().toISOString(),
        sources: answers,
    };
    const file = outDir ? await writeStageFile(outDir, 'recognition', recognition) : null;
    return { recognition, file, warnings };
}
