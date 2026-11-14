/**
 * @file src/stages/index.js
 * @module stages
 * @purpose The registry of the pipeline stages: their order, their labels, the role each of them
 *          asks and the directory their artifacts land in.
 * @depends stages/design, stages/measure, stages/crop, stages/resolve
 * @usedBy shared/pipeline
 * @exports STAGE_DEFS, STAGE_IDS, STAGE_ROLES, STAGE_DIRS, stageById
 * @ai.tags pipeline, stages
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import { runDesignStage, shouldRunDesign } from './design.js';
import { runMeasureStage } from './measure.js';
import { runSegmentStage } from './segmentate.js';
import { runCropStage } from './cropper.js';
import { runRecognizeStage } from './recognize.js';
import { runSampleStage } from './sample.js';
import { runResolve, MEASUREMENTS_FILE } from './resolve.js';

/**
 * The design stage: the visual direction of the project.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function designStage(state, notify) {
    const result = await runDesignStage({
        root: state.root,
        workId: state.workId,
        config: state.config,
        runner: state.roles,
        toolset: state.toolset,
        references: state.references,
        task: state.task,
        notify,
        signal: state.signal ?? null,
    });
    state.design = result.design;
    state.warnings.push(...result.warnings);
}

/**
 * The measurement stage: the geometry of the zones.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function measureStage(state, notify) {
    const result = await runMeasureStage({
        root: state.root,
        workId: state.workId,
        config: state.config,
        runner: state.roles,
        references: state.references,
        outDir: state.outDir,
        notify,
        signal: state.signal ?? null,
    });
    state.geometry = result.geometry;
    state.warnings.push(...result.warnings);
}

/**
 * The recognition stage: the texts and the typography of the zones.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function recognizeStage(state, notify) {
    const result = await runRecognizeStage({
        root: state.root,
        workId: state.workId,
        config: state.config,
        runner: state.roles,
        references: state.references,
        outDir: state.outDir,
        notify,
        signal: state.signal ?? null,
    });
    state.recognition = result.recognition;
    state.warnings.push(...result.warnings);
}

/**
 * The segmentation stage: the zones of the references and the box of each one.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function segmentateStage(state, notify) {
    const result = await runSegmentStage({
        root: state.root,
        workId: state.workId,
        config: state.config,
        runner: state.roles,
        references: state.references,
        outDir: state.outDir,
        notify,
        signal: state.signal ?? null,
    });
    state.segmentation = result.segmentation;
    state.warnings.push(...result.warnings);
}

/**
 * The crop stage: the fragments of the references, cut into files.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function cropStage(state, notify) {
    const result = await runCropStage({
        root: state.root,
        workId: state.workId,
        config: state.config,
        runner: state.roles,
        references: state.references,
        outDir: state.outDir,
        notify,
        signal: state.signal ?? null,
    });
    state.crops = result.crops;
    state.warnings.push(...result.warnings);
}

/**
 * The sample stage: the colours of the reference, named.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function sampleStage(state, notify) {
    const result = await runSampleStage({
        root: state.root,
        workId: state.workId,
        config: state.config,
        runner: state.roles,
        references: state.references,
        outDir: state.outDir,
        effort: state.effort ?? null,
        notify,
        signal: state.signal ?? null,
    });
    state.palette = result.palette;
    state.warnings.push(...result.warnings);
}

/**
 * The resolve stage: the parts of the stages into the files of the delivery.
 * @param {object} state the pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function resolveStage(state, notify) {
    await runResolve(state, notify);
}

/**
 * The stages of the pipeline, in the order they run.
 *
 * The order is fixed: a stage may only read what the earlier stages wrote. Every stage leaves
 * its file in the output directory, so a stage may also run alone, on the files of the previous
 * run.
 *
 * @type {ReadonlyArray<{ id: string, label: string, role: string|null, run: Function, dir: string }>}
 */
export const STAGE_DEFS = Object.freeze([
    { id: 'design', label: 'Design direction', role: 'designer', run: designStage, dir: 'design-assets', needsReferences: false },
    { id: 'segmentate', label: 'Segment the reference', role: 'segmentator', run: segmentateStage, dir: 'stages', needsReferences: true },
    { id: 'crop', label: 'Cut the fragments', role: 'cropper', run: cropStage, dir: 'crops', needsReferences: false },
    { id: 'measure', label: 'Measure the zones', role: 'measurer', run: measureStage, dir: 'stages', needsReferences: true },
    { id: 'recognize', label: 'Read the texts', role: 'recognizer', run: recognizeStage, dir: 'stages', needsReferences: true },
    { id: 'sample', label: 'Read the colours', role: 'sampler', run: sampleStage, dir: 'stages', needsReferences: true },
    { id: 'resolve', label: 'Write the artifacts', role: null, run: resolveStage, dir: MEASUREMENTS_FILE, needsReferences: false },
]);

/** The ids of the stages, in order. */
export const STAGE_IDS = Object.freeze(STAGE_DEFS.map((stage) => stage.id));

/** The role each stage asks for its sheet or its direction. */
export const STAGE_ROLES = Object.freeze(Object.fromEntries(STAGE_DEFS.map((stage) => [stage.id, stage.role])));

/** The directory each stage writes its artifacts into, relative to the work directory. */
export const STAGE_DIRS = Object.freeze(Object.fromEntries(STAGE_DEFS.map((stage) => [stage.id, stage.dir])));

/**
 * The stage with this id.
 * @param {string} id
 * @returns {object|null}
 * @ai.hint pure
 */
export function stageById(id) {
    return STAGE_DEFS.find((stage) => stage.id === id) ?? null;
}

export { shouldRunDesign };
