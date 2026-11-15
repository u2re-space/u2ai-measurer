/**
 * @file src/shared/pipeline.js
 * @module shared/pipeline
 * @purpose Pipeline orchestrator: runs the stages in order and passes the artifacts between them.
 *
 * The pipeline is small on purpose: the design stage, the measurement stage and the resolve
 * stage. The crops are cut inside the measurement stage, so there is no separate crop stage.
 *
 * @depends node:path, node:fs/promises, node:crypto, roles/index, agent/tools, agent/skills,
 *          agent/mcp, agent/context, agent/run-map, stages/index
 * @usedBy cli
 * @exports STAGES, runPipeline, runStages, newWorkId, stageReferences
 * @ai.tags pipeline, stages
 * @ai.hint keep
 * @ai.hint legacy-0.2
 * @changed 2026-11-15 The run keeps a context of its own and a map of its files.
 */

import path from 'node:path';
import { mkdir, stat, cp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRoleRunner, resolveRole } from '../roles/index.js';
import { createToolset } from '../agent/tools.js';
import { loadSkills } from '../agent/skills.js';
import { connectMcpServers } from '../agent/mcp.js';
import { openContext } from '../agent/context.js';
import { openRunMap } from '../agent/run-map.js';
import { STAGE_DEFS, STAGE_DIRS, STAGE_ROLES, shouldRunDesign } from '../stages/index.js';
import { MEASUREMENTS_FILE } from '../stages/resolve.js';
import { publishDelivery } from '../stages/publish.js';
import { isInside, toPosix } from '../agent/paths.js';
import { runStateDir, workRel } from './house.js';

/**
 * The stages of the pipeline, in order.
 * @type {Array<{ id: string, label: string, run: Function }>}
 */
export const STAGES = STAGE_DEFS.map((stage) => ({
    id: stage.id,
    label: stage.label,
    run: stage.run,
    needsReferences: stage.needsReferences === true,
}));

/**
 * The id of a work directory: the time and a few random bytes, in a name a person can read.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function newWorkId() {
    return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * The references of the run.
 *
 * A picture inside the working directory is used where it is. A picture from outside is copied
 * into the work directory first: every tool of the agent is bound to the working directory, and a
 * reference that no tool may open is a reference the measurer cannot crop.
 *
 * @param {{ root: string, workId: string, config?: object, images?: string[] }} options
 * @returns {Promise<{ references: Array<{ kind: string, rel: string, abs: string }>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function stageReferences({ root, workId, config = {}, images = [] }) {
    const references = [];
    const warnings = [];
    let outside = 0;
    // One picture is one reference.
    //
    // The arguments of a run may name the same file twice — a model that calls the CLI with
    // `--image landing.png landing.png` is not wrong, it is redundant — and every stage would
    // then look at the same picture twice: two segmentations, two sets of fragments, twice the
    // money and twice the noise in the files of the run. The second name of a picture is dropped.
    const seen = new Set();
    for (const image of images) {
        const abs = path.resolve(root, String(image ?? ''));
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        if (seen.has(key)) {
            warnings.push(`The reference ${image} was given twice: the picture is measured once.`);
            continue;
        }
        seen.add(key);
        const info = await stat(abs).catch(() => null);
        if (!info?.isFile()) {
            warnings.push(`The reference ${image} does not exist.`);
            continue;
        }
        if (isInside(root, abs)) {
            references.push({ kind: 'original', rel: toPosix(path.relative(root, abs)), abs });
            continue;
        }
        outside += 1;
            const dir = path.join(runStateDir(root, workId, config), 'references');
        await mkdir(dir, { recursive: true });
        const target = path.join(dir, path.basename(abs));
        try {
            await cp(abs, target, { force: true });
        } catch (error) {
            warnings.push(`The reference ${image} could not be copied into the work directory (${error?.message ?? error}).`);
            continue;
        }
        references.push({ kind: 'original', rel: toPosix(path.relative(root, target)), abs: target });
    }
    if (outside) {
        warnings.push(`${outside} reference(s) from outside the working directory were copied into ${workRel(config)}/${workId}/references/.`);
    }
    return { references, warnings };
}

/**
 * Execute the pipeline stages in order.
 *
 * @param {{ root: string, images?: string[], outDir?: string|null, stages?: string[]|null,
 *   config: object, client: object, model?: string|null, effort?: string|null, task?: string,
 *   workId?: string|null, stopAfter?: string|null, dryRun?: boolean, signal?: AbortSignal|null,
 *   notify?: (event: object) => void }} opts
 * @returns {Promise<{ output: object|null, warnings: string[], failed: boolean, workId: string, artifacts: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runPipeline({
    root,
    images = [],
    outDir = null,
    stages: requestedStages = null,
    config,
    client,
    model = null,
    effort = null,
    task = '',
    workId = null,
    stopAfter = null,
    dryRun = false,
    signal = null,
    notify = () => {},
}) {
    const id = workId ?? newWorkId();
    const workDir = runStateDir(root, id, config);
    // The output directory is absolute: the stages write their files into it, and a relative
    // path would be relative to the process, not to the working directory of the run.
    const outputDir = path.resolve(root, outDir ?? config?.output?.dir ?? './measurements');

    const { references, warnings: referenceWarnings } = await stageReferences({ root, workId: id, config, images });
    const warnings = [...referenceWarnings];
    // The references are what the run reads: the reader sees them before the model does.
    notify({
        type: 'references',
        items: references.map((item) => ({ path: item.rel, kind: item.kind })),
    });

    // The skill packs of the roles that run here.
    //
    // The fragment pass is the measurer working on a piece of the picture: it inherits the
    // packs of the measurer and may add its own.
    const skillDir = config?.skills?.dir ?? null;
    const packText = (packs) => (packs.length
        ? packs.map((pack) => `## Skill pack: ${pack.name}\n${pack.content.trim()}`).join('\n\n')
        : '');
    const measurerPacks = await loadSkills({ dir: skillDir, role: 'measurer' });
    const skills = {
        measurer: packText(measurerPacks),
    };
    // The other roles get their own packs; a role without a pack simply has none.
    for (const name of ['segmentator', 'cropper', 'recognizer', 'sampler', 'resolver', 'designer']) {
        skills[name] = packText(await loadSkills({ dir: skillDir, role: name }));
    }

    const mcp = dryRun ? [] : await connectMcpServers(config?.mcp?.servers ?? []);
    for (const connection of mcp) {
        if (connection?.error) {
            warnings.push(`The MCP server ${connection.name} is not connected: ${connection.error}`);
        }
    }

    // The stages that run in this configuration.
    //
    // A stage the user named on the command line runs: the gate of `agent.design` decides
    // whether the design stage runs on its own, not whether an explicit request is honoured.
    // The switch of the config (`stages.<id>.enabled: false`) is a hard switch and always wins.
    const explicit = Array.isArray(requestedStages) && requestedStages.length > 0;
    const selected = explicit ? requestedStages : STAGES.map((stage) => stage.id);
    const hasDesignMd = await exists(path.join(root, 'DESIGN.md'));
    const enabled = STAGES.filter((stage) => (
        selected.includes(stage.id)
        && config?.stages?.[stage.id]?.enabled !== false
    ));
    const toRun = enabled.filter((stage) => {
        if (stage.id === 'design') {
            if (explicit) return true;
            return shouldRunDesign(config, { hasReferences: references.length > 0, hasDesignMd, task });
        }
        // The stages that look at a picture need one.
        if (stage.needsReferences) return references.length > 0;
        return true;
    });
    if (stopAfter) {
        const stopIdx = toRun.findIndex((stage) => stage.id === stopAfter);
        if (stopIdx >= 0) toRun.length = stopIdx + 1;
    }

    if (dryRun) {
        notify({
            type: 'plan',
            references: references.map((item) => item.rel),
            stages: toRun.map((stage) => {
                const role = stage.role ? resolveRole(config, stage.role) : null;
                return { id: stage.id, label: stage.label, model: role?.model ?? null };
            }),
            outputs: [
                toPosix(path.join(outputDir, MEASUREMENTS_FILE)),
                toPosix(path.join(outputDir, 'stages')),
                toPosix(path.join(outputDir, 'crops')),
            ],
        });
        return { output: null, warnings, failed: false, workId: id, artifacts: [] };
    }

    await mkdir(workDir, { recursive: true });

    // The context of the run: what it did, what it decided and the answers it already has.
    //
    // The context is the primary knowledge of the run. The permanent memory of the project is a
    // different thing: a new run starts with a clean head, and an old run never gets in the way.
    const context = await openContext({
        root,
        workId: id,
        config,
        enabled: config?.context?.enabled !== false,
        cache: config?.context?.cache !== false,
        maxBriefChars: config?.context?.maxBriefChars,
    });
    await context.references(references.map((item) => ({ rel: item.rel, kind: item.kind })));

    // The map of the run: the files of the working directory, with their lines and their symbols.
    // The searches and the reads of the files the map knows do not touch the disk.
    const map = await openRunMap({
        root,
        workId: id,
        config,
        build: config?.map?.enabled !== false,
        depth: config?.map?.depth,
        maxFiles: config?.map?.maxFiles,
        maxFileBytes: config?.map?.maxFileBytes,
        maxLines: config?.map?.maxLines,
    });

    // One toolset for the whole run: the stages open the directories a role may write into, and
    // the role runner executes the calls with the very same executor.
    const toolset = createToolset({ root, config, mcp, context, map, notify });

    const roles = createRoleRunner({
        client,
        config,
        model,
        // The effort of the run is a ceiling, not a setting: a stage asks for the effort it
        // needs, and the promise of the user about the money lowers it.
        effort: null,
        ceiling: effort,
        toolset,
        skills,
        context,
        onEvent: (event) => notify({ type: 'api', ...event }),
    });

    const state = {
        root,
        workId: id,
        workDir,
        outDir: outputDir,
        config,
        client,
        roles,
        model,
        /** The effort of the run: a ceiling, never a setting. */
        effort,
        ceiling: effort,
        task,
        signal,
        toolset,
        context,
        map,
        references,
        design: null,
        segmentation: null,
        geometry: null,
        recognition: null,
        sheet: null,
        crops: [],
        palette: null,
        tokens: [],
        artifacts: [],
        warnings,
    };

    const failed = await runStages(toRun, state, notify);

    // The contract of the project: what this run made and where it lies. The other systems
    // of the house read it to find the work of this one.
    try {
        await publishDelivery(root, config, state);
    } catch (cause) {
        state.warnings.push(`The contract of the project was not written: ${cause?.message ?? cause}`);
    }

    // The digest of the run: what a person reads after it. The context of the run is the
    // witness of what happened, and it dies with the run.
    await context.digest().catch(() => {});
    await context.close().catch(() => {});

    for (const connection of mcp) await connection.close().catch(() => {});

    return {
        output: state.sheet,
        warnings: state.warnings,
        failed,
        workId: id,
        artifacts: state.artifacts,
    };
}

/**
 * Run the stages one after another.
 *
 * A stage that throws does not stop the pipeline: the run goes on, the failure is remembered as a
 * warning, and the caller is told that something did not work. Only an abort leaves the run.
 *
 * @param {Array<{ id: string, label: string, run: Function }>} stages the stages to run, in order
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<boolean>} true when a stage failed
 * @ai.hint io
 */
export async function runStages(stages, state, notify = () => {}) {
    let failed = false;
    for (const stage of stages) {
        notify({ type: 'stage.start', stage: stage.id, label: stage.label });
        const before = state.warnings.length;
        try {
            await stage.run(state, notify);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            state.warnings.push(`${stage.id}: ${error.message}`);
            failed = true;
            notify({ type: 'stage.error', stage: stage.id, error: error.message });
        }
        // Every warning a stage collected is shown to the reader, not only kept in the state.
        for (const message of state.warnings.slice(before)) {
            notify({ type: 'warning', message });
        }
        notify({ type: 'stage.done', stage: stage.id });
    }
    return failed;
}

/**
 * Whether a file exists.
 * @param {string} file
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function exists(file) {
    return await stat(file).then((info) => info.isFile()).catch(() => false);
}

export { STAGE_DIRS, STAGE_ROLES };
