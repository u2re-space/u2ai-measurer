/**
 * @file src/stages/design.js
 * @module stages/design
 * @purpose The design stage: a visual design direction, the assets it needs and an HTML skeleton.
 *
 * The designer reads the task, the reference pictures and the `DESIGN.md` of the project, then
 * answers with a design direction: the layout, the typography, the colour palette, the spacing
 * scale and the paths of the files it wrote. The harness owns the directories: the designer may
 * only write under `.tmp/<id>/`.
 *
 * The stage is optional: `agent.design` decides whether it runs at all — `off` never, `always`
 * always, `auto` when there are reference pictures, a `DESIGN.md`, or design words in the task.
 *
 * @depends node:path, node:fs/promises, openai/responses, roles/index, agent/schemas,
 *          stages/measure
 * @usedBy shared/pipeline
 * @exports runDesignStage, shouldRunDesign, readDesignMd, clipMiddle, designContext
 * @ai.tags stage, design, templates
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { DESIGN_SCHEMA } from '../agent/schemas.js';
import { attachReference, attachmentBlock } from './references.js';

/** How much of the `DESIGN.md` is put into the prompt. */
export const DESIGN_MD_MAX_BYTES = 16 * 1024;

/** The words that make the design stage worth running in the `auto` mode. */
const DESIGN_KEYWORDS = /design|layout|mockup|template|style[_ -]?guide|colou?r|typography|palette|макет|дизайн/i;

/**
 * Clip a text to a byte budget, keeping its head and its tail.
 *
 * The middle of a long `DESIGN.md` is the part that repeats the tokens; the head holds the rules
 * and the tail holds the last notes.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function clipMiddle(text, maxBytes = DESIGN_MD_MAX_BYTES) {
    const body = String(text ?? '');
    const bytes = Buffer.byteLength(body, 'utf-8');
    if (bytes <= maxBytes) return body;
    const marker = '\n\n[... clipped, the middle of the document is omitted ...]\n\n';
    const budget = Math.max(1024, Math.floor((maxBytes - Buffer.byteLength(marker, 'utf-8')) / 2));
    const head = body.slice(0, budget);
    const tail = body.slice(body.length - budget);
    return `${head}${marker}${tail}`;
}

/**
 * Read the `DESIGN.md` of the project root.
 * @param {string} root
 * @returns {Promise<string>} the text, or an empty string when there is no file
 * @exports
 * @ai.hint io
 */
export async function readDesignMd(root) {
    return await readFile(path.join(root, 'DESIGN.md'), 'utf-8').catch(() => '');
}

/**
 * Whether the design stage runs.
 *
 * @param {object} config
 * @param {{ hasReferences?: boolean, hasDesignMd?: boolean, task?: string }} [signals]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function shouldRunDesign(config, { hasReferences = false, hasDesignMd = false, task = '' } = {}) {
    const mode = config?.agent?.design ?? 'off';
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    if (hasReferences || hasDesignMd) return true;
    return DESIGN_KEYWORDS.test(String(task ?? ''));
}

/**
 * The prompt of the designer: the task, the references, the `DESIGN.md` and the output dirs.
 *
 * @param {{ workId: string, task?: string, references?: object[], designMd?: string, designMdRead?: boolean }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function designContext({ workId, task = '', references = [], designMd = '', designMdRead = false }) {
    const dir = `.tmp/${workId}`;
    const sourceLines = references
        .map((item) => `- ${item.rel}${item.role ? ` (${item.role})` : ''}`)
        .join('\n');
    const brief = [
        `Write only inside ${dir}/: the HTML template as ${dir}/design-template.html, generated images under ${dir}/design-assets/.`,
        designMdRead
            ? 'A project DESIGN.md exists (its text is below). Extract its design tokens into the designMd field, follow its conventions, and report every conflict with your direction in designMd.conflicts. Set designMd.read=true.'
            : 'No DESIGN.md was found in the project root: set designMd.read=false and leave tokens and conflicts empty.',
        'For call_ai_image pick a frame that fits the purpose: 3072x2048 or 1920x1080 for desktop heroes, 1536x1024 for standard previews, 640x1280 for mobile screens.',
    ].join(' ');

    return [
        attachmentBlock(references.map((item) => ({ rel: item.rel, role: item.role ?? 'original' }))),
        '',
        '# Design sources',
        sourceLines || '(no attached reference images)',
        '',
        '# Output directories',
        `${dir}/ (template), ${dir}/design-assets/ (images)`,
        '',
        brief,
        designMdRead ? `\n\n# DESIGN.md\n${clipMiddle(designMd, DESIGN_MD_MAX_BYTES)}` : '',
        '',
        '# Task',
        String(task ?? '').trim() || 'Produce the visual design direction for this project: layout, typography, colour, spacing, assets, and the HTML template skeleton.',
    ].join('\n');
}

/**
 * Run the design stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, toolset?: object|null,
 *   references?: object[], task?: string, notify?: Function|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ design: object|null, warnings: string[], saved: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function runDesignStage({
    root,
    workId,
    config,
    runner,
    toolset = null,
    references = [],
    task = '',
    notify = null,
    signal = null,
}) {
    const warnings = [];
    const dir = `.tmp/${workId}`;
    const assetsDir = `${dir}/design-assets`;
    const templatePath = `${dir}/design-template.html`;

    // The directories the designer owns.
    try {
        await mkdir(path.join(root, assetsDir), { recursive: true });
    } catch (error) {
        warnings.push(`The directory ${assetsDir} could not be created: ${error?.message ?? error}`);
    }
    toolset?.setWriteDirs?.([path.join(root, dir)]);

    // The references the designer sees.
    const parts = [];
    const captions = [];
    for (const item of references) {
        const image = await attachReference({ root, rel: item.rel, config });
        if (!image) {
            warnings.push(`The reference ${item.rel} could not be read.`);
            continue;
        }
        parts.push(image.part);
        captions.push({ rel: item.rel, role: item.kind === 'subref' ? 'sub-reference' : 'original' });
    }

    const designMd = await readDesignMd(root);
    const designMdRead = Boolean(designMd.trim());

    const maxTurns = Math.max(1, Number(config?.stages?.design?.maxTurns ?? config?.agent?.designerMaxTurns) || 16);
    notify?.({ type: 'design.start', references: captions.length, designMd: designMdRead });

    const answer = await runner.run('designer', {
        text: designContext({ workId, task, references: captions, designMd, designMdRead }),
        parts,
        schema: DESIGN_SCHEMA,
        schemaName: 'design',
        maxTurns,
        signal,
    });

    if (answer.error) {
        warnings.push(`The designer failed: ${answer.error}`);
    }
    if (!answer.data) {
        return { design: null, warnings: [...warnings, 'The designer did not return a direction.'], saved: null };
    }

    // The template is optional. When the direction names one, it has to be the file that is there.
    const design = answer.data;
    const named = String(design?.template?.path ?? '').trim();
    if (named && named !== templatePath) {
        const exists = await stat(path.resolve(root, named)).then((info) => info.isFile()).catch(() => false);
        if (exists) {
            warnings.push(`The template was written to ${named} instead of ${templatePath}.`);
        } else {
            warnings.push(`The designer named the template ${named}, but there is no such file: the template is expected at ${templatePath}.`);
            design.template.path = templatePath;
        }
    }

    const saved = path.join(root, dir, 'design.json');
    try {
        await mkdir(path.dirname(saved), { recursive: true });
        await writeFile(saved, `${JSON.stringify(design, null, 2)}\n`, 'utf-8');
    } catch (error) {
        warnings.push(`The design direction was not saved: ${error?.message ?? error}`);
        return { design, warnings, saved: null };
    }

    notify?.({ type: 'design.done', template: design?.template?.path ?? '' });
    return { design, warnings, saved: `.tmp/${workId}/design.json` };
}

/**
 * Read back a design direction that a previous run saved.
 * @param {string} root
 * @param {string} workId
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function readSavedDesign(root, workId) {
    const file = path.join(root, '.tmp', workId, 'design.json');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    return await readFile(file, 'utf-8').then((text) => JSON.parse(text)).catch(() => null);
}
