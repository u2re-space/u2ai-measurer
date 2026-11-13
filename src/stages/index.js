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
import { runMeasureStage, shouldMeasure } from './measure.js';
import { measurementConclusion } from './crop.js';
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
 * The measurement stage: the sheet, the crops and the conclusion.
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
        toolset: state.toolset,
        references: state.references,
        notify,
        signal: state.signal ?? null,
    });
    state.sheet = result.sheet;
    state.crops = result.crops;
    state.conclusion = result.conclusion ?? measurementConclusion(result.sheet, result.crops);
    state.warnings.push(...result.warnings);
}

/**
 * The stages of the pipeline, in the order they run.
 *
 * The order is fixed: a stage may only read what the earlier stages wrote. The crop stage is
 * not one of them — the crops are cut inside the measurement stage, right after the overview
 * pass and once more after the fragment pass.
 *
 * @type {ReadonlyArray<{ id: string, label: string, role: string|null, run: Function, dir: string }>}
 */
export const STAGE_DEFS = Object.freeze([
    { id: 'design', label: 'Design direction', role: 'designer', run: designStage, dir: 'design-assets' },
    { id: 'measure', label: 'Measure the reference', role: 'measurer', run: measureStage, dir: 'crops' },
    { id: 'resolve', label: 'Write the artifacts', role: null, run: runResolve, dir: MEASUREMENTS_FILE },
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

export { shouldRunDesign, shouldMeasure };
