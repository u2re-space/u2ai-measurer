/**
 * @file src/roles/index.js
 * @module roles
 * @purpose Role registry: instructions, model/effort resolution, and the run loop that talks
 *          to the API.
 *
 * The runner knows how to ask a role a question and how to read the answer: JSON when the role
 * has a schema, plain text otherwise. A tool loop is optional: when a toolset is given, the calls
 * the model asks for are executed and the answers are fed back.
 *
 * Three rules keep the loop honest. The user message stays in every turn: a model that has called
 * a tool has to see the picture it was asked about again, or the second turn measures a blank
 * wall. The schema is the answer channel: the model returns the sheet as the arguments of the
 * schema tool, not as prose. And the answer may come in a second phase: a model that is fond of
 * tools explores the picture and answers afterwards, under a schema the API holds it to.
 *
 * @depends openai/responses, openai/fallback, model/profiles, model/trust, agent/documentation
 * @usedBy shared/pipeline, stages
 * @exports ROLE_INSTRUCTIONS, resolveRoleInstructions, resolveRole, readOnlyRequest,
 *          createRoleRunner, roleContext
 * @ai.tags roles
 * @ai.hint keep
 * @ai.hint legacy-0.2
 * @changed 2026-11-15 The roles read the brief of the context and their answers go into it.
 */
import { instructions as measurerInstructions } from './measurer.js';
import { instructions as cropperInstructions } from './cropper.js';
import { instructions as segmentatorInstructions } from './segmentator.js';
import { instructions as recognizerInstructions } from './recognizer.js';
import { instructions as samplerInstructions } from './sampler.js';
import { instructions as resolverInstructions } from './resolver.js';
import { instructions as designerInstructions } from './designer.js';
import { parseResponse, textPart, imagePart } from '../openai/responses.js';
import { withModelFallback } from '../openai/fallback.js';
import { getModelProfile, maxOutputFor, snapEffort, capEffort } from '../model/profiles.js';
import { SAFE_MODEL, SAFE_EFFORT, isTrusted } from '../model/trust.js';
import { documentationFor } from '../agent/documentation.js';
import { schemaProblems } from '../agent/schemas.js';
import { resolveInside } from '../agent/paths.js';
import { readFile } from 'node:fs/promises';

/**
 * The pictures that the answer of a tool names.
 *
 * A tool that makes a picture — `view_image` opens one, `crop_image` cuts one — answers with
 * the path of the file. The path in the text is not a picture: the model asked to see it and
 * has to see it, so the file goes back into the conversation as an image.
 *
 * Without this the model asks the tool to look at a picture, gets its size in words, and
 * concludes that the picture cannot be rendered — and leaves the zones of the segmentation
 * empty because it refuses to invent the boxes of a picture it cannot see.
 * @param {string} root the project directory
 * @param {string} text the answer of the tool
 * @returns {Promise<object[]>} the parts of the request
 * @exports
 * @ai.hint io
 */
export async function pictureParts(root, text) {
    const body = String(text ?? '');
    if (!body.trim()) return [];
    const found = new Set();
    for (const match of body.matchAll(/[^\s"'`()]+\.(?:png|jpe?g|webp|gif)/gi)) {
        const name = match[0].replace(/[.,;]+$/, '');
        if (name) found.add(name);
    }
    const parts = [];
    for (const name of [...found].slice(0, 4)) {
        try {
            const { abs } = await resolveInside(root, name, { allowRoot: false });
            const bytes = await readFile(abs);
            const mime = /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
            parts.push(imagePart(bytes, mime));
        } catch {
            // The path is not a picture of the project: nothing to show.
        }
    }
    return parts;
}

/**
 * Role instructions registry.
 * @type {Record<string, string>}
 */
export const ROLE_INSTRUCTIONS = Object.freeze({
    segmentator: segmentatorInstructions,
    cropper: cropperInstructions,
    measurer: measurerInstructions,
    recognizer: recognizerInstructions,
    sampler: samplerInstructions,
    resolver: resolverInstructions,
    designer: designerInstructions,
});

/**
 * Resolve a role name to its instruction text.
 * @param {string} name
 * @returns {string|null}
 */
export function resolveRoleInstructions(name) {
    return ROLE_INSTRUCTIONS[name] ?? null;
}

const textOf = (value) => (typeof value === 'string' ? value : '');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The user message of a run, as an input item.
 *
 * The message is built once and sent in every turn: the model has to keep seeing the picture it
 * was asked about, or the second turn is a guess.
 * @param {string} text
 * @param {object[]} [parts] image parts
 * @returns {object[]}
 * @ai.hint pure
 */
function userMessage(text, parts) {
    const content = [];
    if (textOf(text).trim()) content.push(textPart(text));
    for (const part of Array.isArray(parts) ? parts : []) {
        if (part) content.push(part);
    }
    return [{
        role: 'user',
        content: content.length ? content : [{ type: 'input_text', text: '' }],
    }];
}

/**
 * The standards a role is given, according to `documentation.roles` in the config.
 * @param {object} config
 * @param {string} name the role name
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function roleContext(config, name) {
    const wanted = config?.documentation?.roles?.[name];
    return documentationFor(Array.isArray(wanted) ? wanted : []);
}

/** Tools that inspect data without writing files, cropping images, or invoking another CLI. */
const READ_ONLY_TOOLS = new Set([
    'view_image', 'sample_colors', 'parse_color', 'list_files', 'read_file', 'search_files',
]);
const WRITE_READY_TOOL = Object.freeze({
    type: 'function',
    name: 'write_ready',
    description: 'Signal that inspection is complete and you are ready to create or change files, images, or external artifacts. Call this alone before any such tool; the next turn gets the full output budget and the remaining tools.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
});

/**
 * Whether a request has no structured/prose report to produce and can only inspect data.
 *
 * The separate schema phase intentionally reports its measurements in prose, so it keeps the
 * full output budget even though that individual request does not carry the schema.
 * Unknown and external tools are conservative: they do not qualify as read-only.
 * @param {{ schema?: object|null, mode?: string, tools?: object[]|null, outputMode?: string }} request
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function readOnlyRequest({ schema = null, mode = 'plain', tools = null, outputMode = 'report' } = {}) {
    if (schema || mode !== 'plain' || outputMode !== 'read') return false;
    if (tools == null) return true;
    if (!Array.isArray(tools)) return false;
    return tools.every((tool) => READ_ONLY_TOOLS.has(String(tool?.name ?? '')));
}

/**
 * Resolve a role into the settings of one call.
 *
 * The chain is role → `roles.default` → the top level of the config. The effort is clamped to
 * what the model accepts and to the ceiling of the role.
 *
 * A model that is not trusted with the role does not answer it: the role moves to the safe
 * model of the house (`model/trust`). The pin of the role in the config is never moved.
 * @param {object} config
 * @param {string} name
 * @param {{ model?: string|null, effort?: string|null, ceiling?: string|null }} [overrides]
 *   settings of this run: `effort` is what the stage asks for, `ceiling` is the promise the
 *   user made about the money of the run.
 * @returns {{ name: string, model: string|null, effort: string|null, instructions: string|null,
 *   tools: string[]|null, context: string|null, maxOutputTokens: number|null }}
 * @exports
 */
export function resolveRole(config, name, { model = null, effort = null, ceiling = null } = {}) {
    const roles = isRecord(config?.roles) ? config.roles : {};
    const role = isRecord(roles[name]) ? roles[name] : {};
    const fallback = isRecord(roles.default) ? roles.default : {};

    const pick = (field) => {
        for (const source of [role, fallback]) {
            const value = source?.[field];
            if (value !== undefined && value !== null && value !== '') return value;
        }
        return null;
    };

    // The model of the role: the pin of the run wins, then the pin of the role, then the pin of
    // the default role, then the model of the configuration.
    const runModel = model ? String(model) : null;
    const roleModel = role?.model ? String(role.model) : null;
    const wantedModel = runModel
        ?? roleModel
        ?? (fallback?.model ? String(fallback.model) : null)
        ?? textOf(config?.model)
        ?? null;
    // The trust rule: a model that is not trusted with the role does not answer it — the role
    // goes to the safe model of the house. The pin of the role itself is never moved: the user
    // named that model for that role on purpose.
    const moved = !(roleModel && !runModel) && !isTrusted(name, wantedModel);
    const resolvedModel = moved ? SAFE_MODEL : wantedModel;
    const profile = getModelProfile(resolvedModel, config);

    // The effort of the role in the config wins over the one of the stage: the role is the
    // narrower name of the same worker.
    const wantedEffort = pick('effort') ?? effort ?? textOf(config?.reasoning?.effort) ?? null;
    // A role that moved to the safe model works on `medium`: the levels above it cost the same
    // seconds anyway, and the stage asked for them of a model that was not trusted.
    const movedEffort = moved && !role?.effort ? SAFE_EFFORT : wantedEffort;
    let resolvedEffort = snapEffort(movedEffort, profile);
    // Two ceilings: the one of the role and the one of the run. The lower of them wins.
    for (const cap of [pick('maxEffort'), ceiling]) {
        if (!cap || !resolvedEffort) continue;
        const snapped = snapEffort(cap, profile);
        if (snapped) resolvedEffort = capEffort(resolvedEffort, snapped);
    }

    return {
        name,
        model: resolvedModel,
        effort: resolvedEffort,
        instructions: pick('instructions') ?? resolveRoleInstructions(name),
        tools: Array.isArray(role?.tools) ? role.tools : null,
        context: pick('context'),
        maxOutputTokens: pick('maxOutputTokens') ?? config?.maxOutputTokens ?? null,
    };
}

/**
 * Create a role runner bound to a client.
 *
 * The context of the run is handed to every role: the brief of the context goes into the
 * instructions, so a role knows what the run already knows — the exact paths of the pictures,
 * the stages that are done, the decisions that were made — and the answers of the role go back
 * into the context, so the next role does not ask again.
 * @param {{ client: object, config?: object, model?: string|null, effort?: string|null,
 *   ceiling?: string|null, toolset?: object|null, skills?: object|null, context?: object|null,
 *   onEvent?: Function|null }} opts
 *   `skills` maps a role name to the text of its skill pack.
 *   `effort` is the effort a role gets when it does not ask for one; `ceiling` is the promise
 *   the user made about the money of the run — it lowers the effort, never raises it.
 * @returns {{ run: Function, resolve: Function }}
 */
export function createRoleRunner({ client, config = {}, model = null, effort = null, ceiling = null, toolset = null, skills = null, context = null, onEvent = null, root = process.cwd() } = {}) {
    /**
     * Run one role.
     * @param {string} name role name
     * @param {{ text: string, parts?: object[], instructions?: string|null, schema?: object|null,
     *   schemaName?: string|null, schemaMode?: 'auto'|'tool'|'separate', maxTurns?: number,
     *   model?: string|null, effort?: string|null, ceiling?: string|null,
     *   signal?: AbortSignal|null, extraTools?: object[], withDocumentation?: boolean,
     *   stage?: string|null, outputMode?: 'read'|'report' }} [params]
     * @returns {Promise<{ status: string, data: object|null, text: string, toolCalls: object[], usage: object|null, error: string|null, model: string|null, trace: object[] }>}
     */
    async function run(name, {
        text = '', parts = [], instructions = null, schema = null, schemaName = null,
        schemaMode = 'auto', maxTurns = 1, model: runModel = null, effort: runEffort = null,
        ceiling: runCeiling = null, signal = null, extraTools = null, withDocumentation = true,
        stage = null, outputMode = 'report',
    } = {}) {
        const role = resolveRole(config, name, {
            model: runModel ?? model,
            effort: runEffort ?? effort,
            ceiling: runCeiling ?? ceiling,
        });
        const skillText = typeof skills?.[name] === 'string' ? skills[name].trim() : '';
        const docs = withDocumentation ? roleContext(config, name) : '';

        const tools = extraTools ?? (
            toolset?.specsFor
                ? toolset.specsFor(name, role.tools ?? null)
                : (toolset?.specs ?? null)
        );
        const allTools = Array.isArray(tools) ? tools : [];
        const readTools = allTools.filter((tool) => READ_ONLY_TOOLS.has(String(tool?.name ?? '')));
        const hasActionTools = outputMode === 'read' && readTools.length < allTools.length;
        const preWriteTools = [...readTools, ...(hasActionTools ? [WRITE_READY_TOOL] : [])];
        const schemaTool = schema ? (schemaName ?? 'response') : null;

        // Where the schema travels.
        //
        // `tool` puts the schema among the tools: the model answers by calling it. `separate`
        // splits the work in two: the model explores with the tools first, and answers in a
        // second call where the API holds it to the schema. The second way is the safer one for
        // a tool-happy model: a schema among the tools is one more reason to keep looking, and
        // the model may spend the whole budget on it without ever answering.
        const mode = !schema
            ? 'plain'
            : (schemaMode === 'auto' ? (tools?.length ? 'separate' : 'tool') : schemaMode);
        // The brief of the context: what this run already knows. The role does not have to
        // rediscover the paths of the pictures or the decisions of the earlier stages.
        const brief = typeof context?.brief === 'function' ? context.brief() : '';

        const baseInstructions = [
            instructions ?? role.instructions,
            docs,
            skillText,
            brief,
            hasActionTools
                ? 'Before creating or changing files, images, or external artifacts, call `write_ready` alone. Until then, only inspection tools are available. After `write_ready`, continue with the requested action; the next turn has the full output budget.'
                : '',
        ].filter(Boolean).join('\n\n');
        if (!baseInstructions) {
            return {
                status: 'error', data: null, text: '', toolCalls: [], usage: null,
                error: `Unknown role: ${name}`, model: role.model, trace: [],
            };
        }

        // What the model is told about the answer, per mode.
        const answerNote = mode === 'tool'
            ? `Answer by calling the ${schemaTool} tool exactly once, with the complete answer; do not answer in prose.`
            : mode === 'separate'
                ? 'Measure with the tools. When you have what you need, stop calling tools and report in prose what you '
                    + 'measured: every box with its numbers, every colour you sampled, the type and the spacing steps. '
                    + 'The harness writes the sheet from your report, so report only the numbers you actually read.'
                : '';
        const roleInstructions = answerNote ? `${baseInstructions}\n\n${answerNote}` : baseInstructions;

        const trace = [];
        const userInput = userMessage(text, parts);
        let last = null;

        // Does the answer follow the schema it was asked for?
        //
        // A backend that does not apply the format rule lets the model answer in its own
        // words: the field the harness reads is called something else, and the sheet comes out
        // empty without a word of complaint. The stage that waits for the answer has to know
        // that the answer is not the one it asked for.
        const checkAnswer = () => (schema && last?.data ? schemaProblems(last.data, schema) : []);

        // One attempt of the whole loop with one model. A model that fails takes the loop with
        // it: the next candidate starts from the first turn, with the picture again.
        const runOnce = async (usedModel) => {
            const items = [];
            let answer = null;
            let prose = '';
            let writeReady = false;
            const turns = Math.max(1, Number.isSafeInteger(maxTurns) ? maxTurns : 1);
            for (let turn = 0; turn < turns; turn++) {
                // The model has to know how much budget is left: a model that does not know it
                // keeps looking until the harness cuts it off, and the answer never arrives.
                const note = turn === 0 ? '' : [
                    '',
                    `Turn ${turn + 1} of ${turns}.`,
                    mode === 'tool'
                        ? `Call the ${schemaTool} tool with the complete answer as soon as you have what you need.`
                        : 'Answer as soon as you have what you need.',
                    'A measured part and a null are worth more than another look.',
                ].join(' ');
                const activeTools = !writeReady && hasActionTools ? preWriteTools : allTools;
                const schemaThisTurn = mode === 'tool' && schema && (!hasActionTools || writeReady);
                const reduced = !writeReady && hasActionTools
                    || readOnlyRequest({
                        schema: schemaThisTurn ? schema : null,
                        mode: schemaThisTurn ? 'tool' : (mode === 'separate' ? 'separate' : 'plain'),
                        tools: activeTools.filter((tool) => tool.name !== WRITE_READY_TOOL.name),
                        outputMode,
                    });
                answer = await client.responses.create({
                    model: usedModel,
                    instructions: note ? `${roleInstructions}${note}` : roleInstructions,
                    input: turn === 0 ? userInput : [...userInput, ...items],
                    tools: activeTools,
                    schema: schemaThisTurn ? schema : null,
                    schemaName: schemaTool ?? 'response',
                    maxOutputTokens: maxOutputFor(usedModel, config, role.maxOutputTokens, { readOnly: reduced }),
                    verbosity: config?.verbosity ?? (reduced ? 'low' : null),
                    effort: role.effort,
                    signal,
                    onEvent,
                });
                const parsed = parseResponse(answer, { schemaName: schemaThisTurn ? schemaTool : null });
                last = parsed;
                for (const call of parsed.toolCalls) {
                    if (call.name !== WRITE_READY_TOOL.name) trace.push({ tool: call.name, args: call.arguments });
                }

                // The schema call is the answer: the sheet is in its arguments.
                if (parsed.schemaAnswer) return parsed;
                const prematureSchema = !schemaThisTurn
                    && parsed.toolCalls.some((call) => call.name === schemaTool);
                if (prematureSchema) break;

                prose = parsed.text ?? '';
                const workCalls = parsed.toolCalls.filter((call) => call.name !== schemaTool);
                if (!workCalls.length || !toolset) break;

                // Run the calls and feed the results back to the model.
                const readyAtTurnStart = writeReady;
                for (const [index, call] of workCalls.entries()) {
                    const callId = call.callId ?? call.id ?? `call_${turn}_${index}`;
                    let output = '';
                    // The reader sees the calls: a model that measures for minutes is doing
                    // something, and the terminal must not look empty while it works.
                    if (call.name !== WRITE_READY_TOOL.name) {
                        onEvent?.({ type: 'tool.call', name: call.name, arguments: call.arguments });
                    }
                    try {
                        if (call.name === WRITE_READY_TOOL.name && !readyAtTurnStart && workCalls.length === 1 && parsed.toolCalls.length === 1 && !call.parseError) {
                            writeReady = true;
                            output = 'Write-ready. The next turn has the full output budget and the remaining tools.';
                            onEvent?.({ type: 'role.write_ready', role: name, stage });
                        } else if (call.parseError) {
                            output = `Tool error: the arguments of the call are not a JSON object (${call.parseError}). Call it again with valid JSON.`;
                        } else if (!readyAtTurnStart && !READ_ONLY_TOOLS.has(call.name)) {
                            output = 'The tool was not run: call write_ready first. The next turn will have the full output budget.';
                        } else if (call.name === WRITE_READY_TOOL.name) {
                            output = 'write_ready must be called alone, before any action-capable tool.';
                        } else {
                            output = await toolset.execute(call.name, call.arguments);
                        }
                    } catch (error) {
                        output = `Tool error: ${error?.message ?? error}`;
                    }
                    // The answer of the tool says what was read or written: the picture, the
                    // colours, the file. The reader has to see it, not only the model.
                    if (call.name !== WRITE_READY_TOOL.name) {
                        onEvent?.({
                            type: 'tool.result',
                            name: call.name,
                            output: textOf(output).slice(0, 4000),
                            error: output.startsWith('Tool error:'),
                        });
                    }
                    items.push({ type: 'function_call', call_id: callId, name: call.name, arguments: call.raw });
                    items.push({
                        type: 'function_call_output',
                        call_id: callId,
                        output: textOf(output).slice(0, 20_000),
                    });
                    // A picture that the tool has made goes back into the conversation as a
                    // picture: the model has to see what it has just looked at or cut, and a
                    // path in the text is not a picture.
                    const pictures = await pictureParts(root, textOf(output));
                    if (pictures.length) {
                        items.push({
                            role: 'user',
                            content: [
                                textPart('The picture the tool has made. Look at it before you continue.'),
                                ...pictures,
                            ],
                        });
                    }
                }
            }

            if (!schema) {
                if (outputMode === 'read' || !hasActionTools || writeReady) return last;
            } else if (mode !== 'separate' && !(mode === 'tool' && hasActionTools && !writeReady)) {
                return last;
            }

            if (!schema && hasActionTools && !writeReady && outputMode !== 'read') {
                answer = await client.responses.create({
                    model: usedModel,
                    instructions: `${baseInstructions}\n\nInspection is complete. Give the requested concise final answer now.`,
                    input: [...userInput, ...items],
                    tools: null,
                    maxOutputTokens: maxOutputFor(usedModel, config, role.maxOutputTokens),
                    verbosity: config?.verbosity ?? null,
                    effort: role.effort,
                    signal,
                    onEvent,
                });
                last = parseResponse(answer, { schemaName: null });
                return last;
            }

            if (!schema) return last;

            // --- the second phase: the answer, under the schema ----------------------
            const ask = [
                'You have finished looking at the reference.',
                'Write the measurement sheet now, from the measurements you collected with the tools.',
                'Do not call any tool. Leave a value null when you did not measure it.',
            ].join(' ');
            // The schema travels in the prompt as well as in the format rule of the API.
            //
            // A gateway that does not apply `text.format` lets the model answer in its own
            // words: the field the harness reads is called something else, and the sheet comes
            // out empty without a word of complaint. The names of the fields are therefore in
            // the prompt too, where every backend passes them on untouched.
            const schemaNote = schema ? [
                '',
                'Answer with one JSON object that follows this schema exactly — the same property names, no others:',
                JSON.stringify(schema),
            ].join('\n') : '';
            const found = textOf(prose).trim()
                ? `\n\nHere is what you have found so far:\n${textOf(prose).trim().slice(0, 8000)}`
                : '';
            answer = await client.responses.create({
                model: usedModel,
                instructions: `${baseInstructions}\n\n${ask}${schemaNote}`,
                input: [
                    ...userInput,
                    ...items,
                    { role: 'user', content: [textPart(`${ask}${found}`)] },
                ],
                tools: null,
                schema,
                schemaName: schemaTool ?? 'response',
                schemaChannel: 'format',
                maxOutputTokens: maxOutputFor(usedModel, config, role.maxOutputTokens),
                verbosity: config?.verbosity ?? null,
                effort: role.effort,
                signal,
                onEvent,
            });
            const parsed = parseResponse(answer, { schemaName: null });
            last = parsed;
            return parsed;
        };

        let usedModel = role.model;
        try {
            const outcome = await withModelFallback({
                config,
                model: role.model,
                call: async (candidate) => {
                    const result = await runOnce(candidate);
                    if (result && result.status && result.status !== 'completed') {
                        throw new Error(`The model answered with the status ${result.status}.`);
                    }
                    return result;
                },
                onTry: ({ model: candidate, attempt }) => {
                    onEvent?.({ type: 'role.model', role: name, model: candidate, attempt });
                },
            });
            last = outcome.result ?? last;
            usedModel = outcome.model ?? role.model;
        } catch (error) {
            return {
                status: 'error', data: null, text: last?.text ?? '', toolCalls: last?.toolCalls ?? [],
                usage: last?.usage ?? null, error: error?.message ?? String(error),
                model: usedModel, trace, schemaProblems: checkAnswer(),
            };
        }

        // The answer of the role goes into the context: the next role builds on it instead of
        // asking the model the same thing again.
        const answerText = textOf(last?.text).trim()
            || (last?.data ? JSON.stringify(last.data).slice(0, 2000) : '');
        if (answerText) await context?.answer?.(answerText, { role: name, stage });
        if (last?.error?.message) await context?.note?.(last.error.message, { role: name, stage });

        return {
            status: last?.status ?? 'completed',
            data: last?.data ?? null,
            text: last?.text ?? '',
            toolCalls: last?.toolCalls ?? [],
            usage: last?.usage ?? null,
            error: last?.error?.message ?? null,
            model: last?.model ?? usedModel,
            trace,
            schemaProblems: checkAnswer(),
        };
    }

    return {
        run,
        resolve: (name, overrides = {}) => resolveRole(config, name, overrides),
    };
}
