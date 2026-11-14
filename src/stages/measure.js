/**
 * @file src/stages/measure.js
 * @module stages/measure
 * @purpose The measurement stage: the overview pass, the staged fragments and the second pass.
 *
 * The measurer reads the reference and answers with a measurement sheet. The harness cuts the
 * fragments the sheet names and, when a second pass is configured, hands those fragments back to
 * the measurer so it can refine the small details. The second pass returns the full sheet again,
 * not a delta: the sheet is the artefact, and a delta would leave the reader guessing.
 *
 * @depends node:path, node:fs/promises, image/sharp, openai/responses, roles/index,
 *          stages/crop, agent/schemas
 * @usedBy shared/pipeline
 * @exports runMeasureStage, shouldMeasure, attachReference, attachmentBlock, splitReferences
 * @ai.tags stage, measure, vision
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { modelBytes } from '../image/sharp.js';
import { imagePart, textPart } from '../openai/responses.js';
import { MEASUREMENT_SCHEMA } from '../agent/schemas.js';
import { stageMeasurementCrops } from './crop.js';

/**
 * Read a reference picture and turn it into an input part the model can see.
 *
 * The picture is downscaled to the configured longest edge: the model reads the layout, and a
 * 4K screenshot costs a lot of tokens for nothing.
 * @param {{ root: string, rel: string, config?: object }} options
 * @returns {Promise<{ part: object, width: number, height: number }|null>}
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
    return {
        part: imagePart(image.bytes, image.mime),
        width: image.width,
        height: image.height,
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

/**
 * Whether the measurement stage runs.
 *
 * @param {object} config
 * @param {{ hasReferences?: boolean }} [signals]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function shouldMeasure(config, { hasReferences = false } = {}) {
    const mode = config?.agent?.measure ?? 'auto';
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return hasReferences;
}

/**
 * Run the measurement stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, toolset?: object|null,
 *   references?: object[], notify?: Function|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ sheet: object|null, crops: object[], warnings: string[], conclusion: object|null, passes: number }>}
 * @exports
 * @ai.hint io
 */
export async function runMeasureStage({
    root,
    workId,
    config,
    runner,
    toolset = null,
    references = [],
    notify = null,
    signal = null,
}) {
    const warnings = [];
    const measureSource = config?.agent?.measureSource ?? 'auto';
    const passes = Math.max(1, Math.min(2, Number(config?.agent?.measurerPasses) || 1));
    const maxTurns = Math.max(1, Number(config?.agent?.measurerMaxTurns) || 8);
    const maxCrops = Number.isSafeInteger(config?.agent?.maxCrops) ? config.agent.maxCrops : 192;
    const overviewTurns = passes > 1 ? Math.max(1, Math.ceil(maxTurns / 2)) : maxTurns;
    const fragmentTurns = passes > 1 ? Math.max(1, maxTurns - overviewTurns) : maxTurns;

    const { attached, context } = splitReferences(references);
    if (!attached.length) {
        return { sheet: null, crops: [], warnings: ['There is no reference to measure.'], conclusion: null, passes: 0 };
    }

    // The pictures the model sees.
    const parts = [];
    const captions = [];
    for (const item of attached) {
        const image = await attachReference({ root, rel: item.rel, config });
        if (!image) {
            warnings.push(`The reference ${item.rel} could not be read.`);
            continue;
        }
        parts.push(image.part);
        captions.push({ rel: item.rel, role: item.kind === 'subref' ? 'sub-reference' : 'original' });
    }
    if (!parts.length) {
        return { sheet: null, crops: [], warnings: [...warnings, 'None of the references could be read.'], conclusion: null, passes: 0 };
    }

    const contextLines = [];
    if (context.length) {
        contextLines.push('The originals exist only as paths; view_image can open one when a sub-reference misses a panel:');
        contextLines.push(...context.map((item) => `- ${item.rel}`));
        contextLines.push('');
    }
    contextLines.push('# Work directory');
    contextLines.push(`.tmp/${workId}/`);
    contextLines.push('');

    const runPass = async (roleName, extraText, turnBudget) => {
        const text = [
            attachmentBlock(captions),
            '',
            ...contextLines,
            extraText,
        ].join('\n');
        const answer = await runner.run(roleName, {
            text,
            parts,
            schema: MEASUREMENT_SCHEMA,
            schemaName: 'measurement',
            maxTurns: turnBudget,
            signal,
        });
        if (answer.error) warnings.push(`The measurer failed: ${answer.error}`);
        return answer;
    };

    // --- the overview pass -----------------------------------------------------
    notify?.({ type: 'measure.pass', pass: 1, of: passes });
    const overview = await runPass('measurer', 'Measure this reference and return the measurement sheet.', overviewTurns);
    let sheet = overview.data;
    if (!sheet) {
        // The model answered without JSON: try once more without the schema.
        const retry = await runner.run('measurer', {
            text: 'Return the measurement sheet as JSON only.',
            parts,
            schema: null,
            maxTurns: 1,
            signal,
        });
        sheet = retry.data;
        if (sheet) warnings.push('The measurement sheet was accepted without the strict schema.');
    }
    if (!sheet) {
        return { sheet: null, crops: [], warnings: [...warnings, 'The measurer did not return a sheet.'], conclusion: null, passes: 0 };
    }

    // --- the fragments ---------------------------------------------------------
    let crops = [];
    if (config?.stages?.crop?.autoCrops !== false) {
        const staged = await stageMeasurementCrops({
            root,
            workId,
            sheet,
            references,
            measureSource,
            maxCrops,
        });
        crops = staged.crops;
        warnings.push(...staged.warnings);
    }

    let usedPasses = 1;
    if (passes > 1 && crops.length) {
        notify?.({ type: 'measure.pass', pass: 2, of: passes, crops: crops.length });
        const cropList = crops
            .map((item) => `- ${item.crop} — ${item.kind} "${item.name}"`)
            .join('\n');
        const second = await runPass(
            'measurerFragment',
            [
                'The harness cut the fragments below from the boxes of your sheet.',
                'Look at the fragments that are too small to read in the overview and refine the sheet.',
                'Return the full sheet again, not a delta.',
                '',
                cropList,
            ].join('\n'),
            fragmentTurns,
        );
        usedPasses = 2;
        if (second.data) {
            sheet = second.data;
        } else if (second.error) {
            warnings.push(`The fragment pass failed: ${second.error}`);
        }
    }

    // --- the sheet --------------------------------------------------------------
    // The sheet is what the model found: the reader sees its shape and its colours.
    {
        const elements = Array.isArray(sheet.elements) ? sheet.elements : [];
        const regions = Array.isArray(sheet.regions) ? sheet.regions : [];
        const rules = Array.isArray(sheet.rules) ? sheet.rules : [];
        const palette = Array.isArray(sheet?.colors?.palette) ? sheet.colors.palette : [];
        notify?.({
            type: 'measure.sheet',
            source: String(sheet.source ?? ''),
            canvas: sheet.canvas ?? null,
            elements: elements.length,
            regions: regions.length,
            rules: rules.length,
            colors: palette.map((color) => ({
                name: String(color?.name ?? ''),
                hex: String(color?.hex ?? ''),
                oklch: String(color?.oklch ?? ''),
                share: Number.isFinite(color?.share) ? color.share : null,
                method: String(color?.method ?? ''),
                confidence: String(color?.confidence ?? ''),
            })),
        });
    }

    // --- the final crops ------------------------------------------------------
    if (config?.stages?.crop?.autoCrops !== false) {
        const staged = await stageMeasurementCrops({
            root,
            workId,
            sheet,
            references,
            measureSource,
            maxCrops,
            reuse: crops.map((item) => ({ crop: item.crop, box: item.box })),
        });
        crops = staged.crops;
        warnings.push(...staged.warnings);
    }

    // The crops are files the run cut: the reader sees what is on the disk.
    if (crops.length) {
        notify?.({
            type: 'measure.crops',
            crops: crops.map((item) => ({
                crop: String(item?.crop ?? ''),
                kind: String(item?.kind ?? ''),
                name: String(item?.name ?? ''),
            })),
        });
    }

    return {
        sheet,
        crops,
        warnings,
        conclusion: null,
        passes: usedPasses,
        references: { attached, context },
    };
}
