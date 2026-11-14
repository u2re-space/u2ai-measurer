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
 * @depends openai/responses, openai/fallback, model/profiles, agent/documentation
 * @usedBy shared/pipeline, stages
 * @exports ROLE_INSTRUCTIONS, resolveRoleInstructions, resolveRole, createRoleRunner, roleContext
 * @ai.tags roles
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */
import { instructions as measurerInstructions, fragmentInstructions } from './measurer.js';
import { instructions as cropperInstructions } from './cropper.js';
import { instructions as designerInstructions } from './designer.js';
import { parseResponse, textPart } from '../openai/responses.js';
import { withModelFallback } from '../openai/fallback.js';
import { getModelProfile, snapEffort } from '../model/profiles.js';
import { documentationFor } from '../agent/documentation.js';

/**
 * Role instructions registry.
 * @type {Record<string, string>}
 */
export const ROLE_INSTRUCTIONS = Object.freeze({
    measurer: measurerInstructions,
    measurerFragment: fragmentInstructions,
    cropper: cropperInstructions,
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

/**
 * Resolve a role into the settings of one call.
 *
 * The chain is role → `roles.default` → the top level of the config. The effort is clamped to
 * what the model accepts and to the ceiling of the role.
 * @param {object} config
 * @param {string} name
 * @param {{ model?: string|null, effort?: string|null }} [overrides] settings of this run
 * @returns {{ name: string, model: string|null, effort: string|null, instructions: string|null, tools: string[]|null, context: string|null }}
 * @exports
 */
export function resolveRole(config, name, { model = null, effort = null } = {}) {
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

    const resolvedModel = model ?? pick('model') ?? textOf(config?.model) ?? null;
    const profile = getModelProfile(resolvedModel, config);

    const wantedEffort = effort ?? pick('effort') ?? textOf(config?.reasoning?.effort) ?? null;
    let resolvedEffort = snapEffort(wantedEffort, profile);
    const maxEffort = pick('maxEffort');
    if (maxEffort) {
        const capped = snapEffort(maxEffort, profile);
        if (capped && resolvedEffort) {
            const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
            if (order.indexOf(resolvedEffort) > order.indexOf(capped)) resolvedEffort = capped;
        }
    }

    return {
        name,
        model: resolvedModel,
        effort: resolvedEffort,
        instructions: pick('instructions') ?? resolveRoleInstructions(name),
        tools: Array.isArray(role?.tools) ? role.tools : null,
        context: pick('context'),
    };
}

/**
 * Create a role runner bound to a client.
 * @param {{ client: object, config?: object, model?: string|null, effort?: string|null,
 *   toolset?: object|null, skills?: object|null, onEvent?: Function|null }} opts
 *   `skills` maps a role name to the text of its skill pack.
 * @returns {{ run: Function, resolve: Function }}
 */
export function createRoleRunner({ client, config = {}, model = null, effort = null, toolset = null, skills = null, onEvent = null } = {}) {
    /**
     * Run one role.
     * @param {string} name role name
     * @param {{ text: string, parts?: object[], instructions?: string|null, schema?: object|null,
     *   schemaName?: string|null, schemaMode?: 'auto'|'tool'|'separate', maxTurns?: number,
     *   model?: string|null, effort?: string|null,
     *   signal?: AbortSignal|null, extraTools?: object[], withDocumentation?: boolean }} [params]
     * @returns {Promise<{ status: string, data: object|null, text: string, toolCalls: object[], usage: object|null, error: string|null, model: string|null, trace: object[] }>}
     */
    async function run(name, {
        text = '', parts = [], instructions = null, schema = null, schemaName = null,
        schemaMode = 'auto', maxTurns = 1, model: runModel = null, effort: runEffort = null,
        signal = null, extraTools = null, withDocumentation = true,
    } = {}) {
        const role = resolveRole(config, name, { model: runModel ?? model, effort: runEffort ?? effort });
        const skillText = typeof skills?.[name] === 'string' ? skills[name].trim() : '';
        const docs = withDocumentation ? roleContext(config, name) : '';

        const tools = extraTools ?? (
            toolset?.specsFor
                ? toolset.specsFor(name, role.tools ?? null)
                : (toolset?.specs ?? null)
        );
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

        const baseInstructions = [
            instructions ?? role.instructions,
            docs,
            skillText,
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

        // One attempt of the whole loop with one model. A model that fails takes the loop with
        // it: the next candidate starts from the first turn, with the picture again.
        const runOnce = async (usedModel) => {
            const items = [];
            let answer = null;
            let prose = '';
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
                answer = await client.responses.create({
                    model: usedModel,
                    instructions: note ? `${roleInstructions}${note}` : roleInstructions,
                    input: turn === 0 ? userInput : [...userInput, ...items],
                    tools,
                    schema: mode === 'tool' ? schema : null,
                    schemaName: schemaTool ?? 'response',
                    effort: role.effort,
                    signal,
                    onEvent,
                });
                const parsed = parseResponse(answer, { schemaName: mode === 'tool' ? schemaTool : null });
                last = parsed;
                for (const call of parsed.toolCalls) trace.push({ tool: call.name, args: call.arguments });

                // The schema call is the answer: the sheet is in its arguments.
                if (parsed.schemaAnswer) return parsed;

                prose = parsed.text ?? '';
                if (!parsed.toolCalls.length || !toolset) break;

                // Run the calls and feed the results back to the model.
                for (const [index, call] of parsed.toolCalls.entries()) {
                    const callId = call.callId ?? call.id ?? `call_${turn}_${index}`;
                    let output = '';
                    try {
                        output = await toolset.execute(call.name, call.arguments);
                    } catch (error) {
                        output = `Tool error: ${error?.message ?? error}`;
                    }
                    items.push({ type: 'function_call', call_id: callId, name: call.name, arguments: call.raw });
                    items.push({
                        type: 'function_call_output',
                        call_id: callId,
                        output: textOf(output).slice(0, 20_000),
                    });
                }
            }

            if (mode !== 'separate' || !schema) return last;

            // --- the second phase: the answer, under the schema ----------------------
            const ask = [
                'You have finished looking at the reference.',
                'Write the measurement sheet now, from the measurements you collected with the tools.',
                'Do not call any tool. Leave a value null when you did not measure it.',
            ].join(' ');
            const found = textOf(prose).trim()
                ? `\n\nHere is what you have found so far:\n${textOf(prose).trim().slice(0, 8000)}`
                : '';
            answer = await client.responses.create({
                model: usedModel,
                instructions: `${baseInstructions}\n\n${ask}`,
                input: [
                    ...userInput,
                    ...items,
                    { role: 'user', content: [textPart(`${ask}${found}`)] },
                ],
                tools: null,
                schema,
                schemaName: schemaTool ?? 'response',
                schemaChannel: 'format',
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
                model: usedModel, trace,
            };
        }

        return {
            status: last?.status ?? 'completed',
            data: last?.data ?? null,
            text: last?.text ?? '',
            toolCalls: last?.toolCalls ?? [],
            usage: last?.usage ?? null,
            error: last?.error?.message ?? null,
            model: last?.model ?? usedModel,
            trace,
        };
    }

    return {
        run,
        resolve: (name, overrides = {}) => resolveRole(config, name, overrides),
    };
}
