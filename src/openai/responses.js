/**
 * @file src/openai/responses.js
 * @module openai/responses
 * @purpose Build Responses API request bodies and parse their answers.
 * @depends openai/stream
 * @usedBy openai/client, roles/index
 * @exports buildResponsesBody, parseResponse, extractToolCalls, imagePart, textPart, functionTool,
 *          parseJsonText
 * @ai.tags responses
 * @ai.hint pure
 */
import { normalizeUsage, outputText, refusalText } from './stream.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * A text input part.
 * @param {string} text
 * @returns {object}
 * @ai.hint pure
 */
export function textPart(text) {
    return { type: 'input_text', text: String(text ?? '') };
}

/**
 * An image input part from raw bytes: the API takes a data URL, not a file.
 * @param {Buffer|Uint8Array} bytes
 * @param {string} mime image mime type
 * @returns {object}
 * @ai.hint pure
 */
export function imagePart(bytes, mime = 'image/png') {
    const data = Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
    return { type: 'input_image', image_url: `data:${mime};base64,${data}` };
}

/**
 * A function tool definition in the Responses shape.
 * @param {string} name
 * @param {string} description
 * @param {object} parameters JSON schema of the arguments
 * @returns {object}
 * @ai.hint pure
 */
export function functionTool(name, description, parameters) {
    return {
        type: 'function',
        name,
        description,
        parameters: isRecord(parameters) ? parameters : { type: 'object', properties: {} },
    };
}

/**
 * Build the body of a Responses API request.
 *
 * The builder is the only place that knows the wire names, so the stages speak in
 * domain terms (instructions, a text prompt, attached images, a JSON schema) and the
 * transport stays replaceable.
 * @param {object} params
 * @param {string} params.model model id
 * @param {string|null} [params.instructions] system instructions of the role
 * @param {string|object[]|null} [params.input] user text or ready input items
 * @param {object[]} [params.parts] extra input parts (images) for the user message
 * @param {object[]} [params.tools] function tools
 * @param {object|null} [params.schema] JSON schema the answer must follow
 * @param {string} [params.schemaName] name of the schema tool
 * @param {'auto'|'tool'|'format'} [params.schemaChannel] where the schema is put:
 *   `tool` makes it a function the model calls, `format` makes it a `text.format`
 *   rule, `auto` picks `tool` when the role has other tools and `format` otherwise.
 * @param {string|null} [params.effort] reasoning effort
 * @param {string|null} [params.summary] reasoning summary mode
 * @param {string|null} [params.mode] gateway reasoning mode
 * @param {number|null} [params.maxOutputTokens]
 * @param {number|null} [params.temperature]
 * @param {boolean} [params.store] send `store: true`
 * @param {string|null} [params.truncation]
 * @param {boolean} [params.stream]
 * @param {string|null} [params.previousResponseId]
 * @returns {object} the request body
 */
export function buildResponsesBody({
    model,
    instructions = null,
    input = null,
    parts = null,
    tools = null,
    schema = null,
    schemaName = 'response',
    schemaChannel = 'auto',
    strict = true,
    effort = null,
    summary = null,
    mode = null,
    maxOutputTokens = null,
    temperature = null,
    store = false,
    truncation = null,
    verbosity = null,
    stream = false,
    previousResponseId = null,
    toolChoice = null,
    parallelToolCalls = null,
} = {}) {
    const body = { model };
    if (textOf(instructions).trim()) body.instructions = textOf(instructions);
    if (previousResponseId) body.previous_response_id = previousResponseId;

    // Input: a ready item list is passed through, text and parts are packed into one user message.
    if (Array.isArray(input)) {
        body.input = input;
    } else {
        const content = [];
        const text = textOf(input);
        if (text.trim()) content.push(textPart(text));
        for (const part of Array.isArray(parts) ? parts : []) {
            if (!part) continue;
            content.push(part);
        }
        body.input = content.length
            ? [{ role: 'user', content }]
            : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }];
    }

    const toolList = Array.isArray(tools) ? tools.filter((tool) => isRecord(tool)) : [];
    const hasSchema = isRecord(schema);

    // Where the schema travels. A role that has tools needs the schema to be a tool as well:
    // with a `text.format` rule in place the model answers straight away with the skeleton of
    // the schema instead of looking at the picture, and the tools are never called.
    const channel = !hasSchema
        ? 'none'
        : (schemaChannel === 'auto' ? (toolList.length ? 'tool' : 'format') : schemaChannel);

    if (hasSchema && channel === 'tool') {
        toolList.push({
            type: 'function',
            name: schemaName,
            description: `Submit the final ${schemaName}. Call this tool exactly once, with the complete answer; do not answer in prose.`,
            parameters: schema,
            strict,
        });
    }
    if (toolList.length) body.tools = toolList;
    if (toolChoice) body.tool_choice = toolChoice;
    if (parallelToolCalls === true) body.parallel_tool_calls = true;

    if (hasSchema && channel === 'format') {
        body.text = { format: { type: 'json_schema', name: schemaName, schema, strict } };
    }

    const reasoning = {};
    if (effort) reasoning.effort = effort;
    if (summary) reasoning.summary = summary;
    if (mode && mode !== 'off') reasoning.mode = mode;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;

    if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_output_tokens = maxOutputTokens;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (typeof verbosity === 'string') body.text = { ...(body.text ?? {}), verbosity };
    if (store) body.store = true;
    if (textOf(truncation)) body.truncation = truncation;
    if (stream) body.stream = true;
    return body;
}

/**
 * Tool calls of a response, in the shape the stage code reads.
 * @param {object} raw a Responses API answer
 * @returns {Array<{ id: string|null, name: string, arguments: object, raw: string }>}
 */
export function extractToolCalls(raw) {
    const out = [];
    for (const item of Array.isArray(raw?.output) ? raw.output : []) {
        if (item?.type !== 'function_call') continue;
        const rawArgs = textOf(item.arguments) || '{}';
        let args = {};
        try { args = JSON.parse(rawArgs); } catch { args = {}; }
        out.push({ id: item.id ?? null, callId: item.call_id ?? null, name: textOf(item.name), arguments: args, raw: rawArgs });
    }
    return out;
}

/**
 * Parse a JSON answer that may be dressed up.
 *
 * A gateway may wrap the answer in a code fence, and a model may add a line of prose before
 * it. The sheet is still in there: the first `{` and the last `}` frame it.
 * @param {string} text
 * @returns {object|null}
 * @exports
 * @ai.hint pure
 */
export function parseJsonText(text) {
    const source = textOf(text).trim();
    if (!source) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
    const body = fenced ? fenced[1].trim() : source;
    try {
        const parsed = JSON.parse(body);
        return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
    } catch {
        // Not the whole text: look for the object inside it.
    }
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Parse a Responses API answer into a stable shape.
 *
 * `text` is the whole answer, `data` is the answer parsed as JSON (null when it is not JSON),
 * `toolCalls` are the function calls the model asked for.
 *
 * When the schema travels as a tool, the answer is the call of that tool: the model returns the
 * object as the arguments of the call, and there is no text to read. `schemaName` names that
 * tool; without it the text of the message is the only source.
 * @param {object} raw
 * @param {{ schemaName?: string|null }} [options]
 * @returns {{ id: string|null, status: string, model: string|null, text: string, data: object|null, toolCalls: object[], usage: object|null, refusal: string, error: object|null, schemaAnswer: boolean, raw: object }}
 */
export function parseResponse(raw, { schemaName = null } = {}) {
    const toolCalls = extractToolCalls(raw);
    const schemaCall = schemaName
        ? toolCalls.find((call) => call.name === schemaName) ?? null
        : null;
    const messageText = textOf(raw?.output_text) || outputText(raw);

    let text = messageText;
    let data = null;
    if (schemaCall) {
        text = schemaCall.raw;
        data = schemaCall.arguments;
        if (!isRecord(data) || !Object.keys(data).length) {
            // The arguments did not parse: the answer is not there.
            try { data = JSON.parse(schemaCall.raw); } catch { data = null; }
        }
    } else {
        data = parseJsonText(messageText);
    }

    return {
        id: raw?.id ?? null,
        status: raw?.status ?? 'completed',
        model: raw?.model ?? null,
        text,
        data,
        toolCalls,
        usage: normalizeUsage(raw?.usage),
        refusal: refusalText(raw),
        error: raw?.error ?? null,
        schemaAnswer: Boolean(schemaCall),
        raw,
    };
}
