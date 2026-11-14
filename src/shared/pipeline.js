/**
 * @file src/shared/pipeline.js
 * @module shared/pipeline
 * @purpose Pipeline orchestrator: runs the stages in order and passes the artifacts between them.
 *
 * The pipeline is small on purpose: the design stage, the measurement stage and the resolve
 * stage. The crops are cut inside the measurement stage, so there is no separate crop stage.
 *
 * @depends node:path, node:fs/promises, node:crypto, roles/index, agent/tools, agent/skills,
 *          agent/mcp, stages/index
 * @usedBy cli
 * @exports STAGES, runPipeline, runStages, newWorkId, stageReferences
 * @ai.tags pipeline, stages
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { mkdir, stat, cp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRoleRunner } from '../roles/index.js';
import { createToolset } from '../agent/tools.js';
import { loadSkills } from '../agent/skills.js';
import { connectMcpServers } from '../agent/mcp.js';
import { STAGE_DEFS, STAGE_DIRS, STAGE_ROLES, shouldRunDesign, shouldMeasure } from '../stages/index.js';
import { MEASUREMENTS_FILE } from '../stages/resolve.js';
import { isInside, toPosix } from '../agent/paths.js';

/**
 * The stages of the pipeline, in order.
 * @type {Array<{ id: string, label: string, run: Function }>}
 */
export const STAGES = STAGE_DEFS.map((stage) => ({
    id: stage.id,
    label: stage.label,
    run: stage.run,
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
 * @param {{ root: string, workId: string, images?: string[] }} options
 * @returns {Promise<{ references: Array<{ kind: string, rel: string, abs: string }>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function stageReferences({ root, workId, images = [] }) {
    const references = [];
    const warnings = [];
    let outside = 0;
    for (const image of images) {
        const abs = path.resolve(root, String(image ?? ''));
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
        const dir = path.join(root, '.tmp', workId, 'references');
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
        warnings.push(`${outside} reference(s) from outside the working directory were copied into .tmp/${workId}/references/.`);
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
    const workDir = path.join(root, '.tmp', id);
    const outputDir = outDir ?? config?.output?.dir ?? './measurements';

    const { references, warnings: referenceWarnings } = await stageReferences({ root, workId: id, images });
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
    const fragmentPacks = await loadSkills({ dir: skillDir, role: 'measurerFragment' });
    const skills = {
        measurer: packText(measurerPacks),
        measurerFragment: packText([...measurerPacks, ...fragmentPacks]),
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

    // One toolset for the whole run: the stages open the directories a role may write into, and
    // the role runner executes the calls with the very same executor.
    const toolset = createToolset({ root, config, mcp });

    const roles = createRoleRunner({
        client,
        config,
        model,
        effort,
        toolset,
        skills,
        onEvent: (event) => notify({ type: 'api', ...event }),
    });

    // The stages that run in this configuration.
    const selected = requestedStages ?? STAGES.map((stage) => stage.id);
    const hasDesignMd = await exists(path.join(root, 'DESIGN.md'));
    const enabled = STAGES.filter((stage) => (
        selected.includes(stage.id)
        && config?.stages?.[stage.id]?.enabled !== false
    ));
    const toRun = enabled.filter((stage) => {
        if (stage.id === 'design') {
            return shouldRunDesign(config, { hasReferences: references.length > 0, hasDesignMd, task });
        }
        if (stage.id === 'measure') {
            return shouldMeasure(config, { hasReferences: references.length > 0 });
        }
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
                const role = stage.role ? roles.resolve(stage.role) : null;
                return { id: stage.id, label: stage.label, model: role?.model ?? null };
            }),
            outputs: [
                toPosix(path.join(outputDir, MEASUREMENTS_FILE)),
                toPosix(path.join('.tmp', id, 'crops')),
            ],
        });
        return { output: null, warnings, failed: false, workId: id, artifacts: [] };
    }

    if (!dryRun) await mkdir(workDir, { recursive: true });

    const state = {
        root,
        workId: id,
        workDir,
        outDir: outputDir,
        config,
        client,
        roles,
        model,
        effort,
        task,
        signal,
        toolset,
        references,
        design: null,
        sheet: null,
        crops: [],
        conclusion: null,
        palette: null,
        tokens: [],
        artifacts: [],
        warnings,
    };

    const failed = await runStages(toRun, state, notify);

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
