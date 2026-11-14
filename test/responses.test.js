/**
 * @file test/responses.test.js
 * @purpose Tests of the Responses layer: where the schema travels and how the answer is read.
 * @depends node:test, openai/responses
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResponsesBody, extractToolCalls, parseResponse, textPart } from '../src/openai/responses.js';

const SCHEMA = {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
};

const TOOL = {
    type: 'function',
    name: 'view_image',
    description: 'Look at an image.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

test('a schema without tools travels as a format rule', () => {
    const body = buildResponsesBody({ model: 'm', schema: SCHEMA, schemaName: 'measurement' });
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'measurement');
    assert.equal(body.tools, undefined);
});

test('a schema with tools travels as a tool, and the format rule is left out', () => {
    const body = buildResponsesBody({ model: 'm', schema: SCHEMA, schemaName: 'measurement', tools: [TOOL] });
    assert.equal(body.text, undefined);
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools[1].name, 'measurement');
    assert.deepEqual(body.tools[1].parameters, SCHEMA);
});

test('the channel of the schema can be forced', () => {
    const forced = buildResponsesBody({ model: 'm', schema: SCHEMA, schemaName: 'measurement', tools: [TOOL], schemaChannel: 'format' });
    assert.equal(forced.text.format.type, 'json_schema');
    assert.equal(forced.tools.length, 1);

    const asTool = buildResponsesBody({ model: 'm', schema: SCHEMA, schemaName: 'measurement', schemaChannel: 'tool' });
    assert.equal(asTool.text, undefined);
    assert.equal(asTool.tools.length, 1);
});

test('the input is packed into one user message', () => {
    const body = buildResponsesBody({ model: 'm', input: 'hello', parts: [{ type: 'input_image', image_url: 'data:' }] });
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.equal(body.input[0].content[1].type, 'input_image');
});

test('a ready item list is passed through', () => {
    const items = [{ role: 'user', content: [textPart('a')] }];
    const body = buildResponsesBody({ model: 'm', input: items });
    assert.deepEqual(body.input, items);
});

test('the answer is read from the call of the schema tool', () => {
    const raw = {
        status: 'completed',
        output: [{
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'measurement',
            arguments: JSON.stringify({ summary: 'ok' }),
        }],
        output_text: '',
    };
    const parsed = parseResponse(raw, { schemaName: 'measurement' });
    assert.equal(parsed.schemaAnswer, true);
    assert.deepEqual(parsed.data, { summary: 'ok' });
    assert.equal(parsed.text, JSON.stringify({ summary: 'ok' }));
});

test('the answer of a message is read when there is no schema tool', () => {
    const raw = { status: 'completed', output: [], output_text: '{"summary":"ok"}' };
    const parsed = parseResponse(raw, { schemaName: 'measurement' });
    assert.equal(parsed.schemaAnswer, false);
    assert.deepEqual(parsed.data, { summary: 'ok' });
});

test('a broken answer is not a sheet', () => {
    const raw = {
        output: [{ type: 'function_call', name: 'measurement', arguments: 'not json' }],
        output_text: '',
    };
    const parsed = parseResponse(raw, { schemaName: 'measurement' });
    assert.equal(parsed.schemaAnswer, true);
    assert.equal(parsed.data, null);
});

test('the tool calls keep their arguments', () => {
    const raw = {
        output: [{
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'view_image',
            arguments: '{"path":"a.png"}',
        }],
    };
    const calls = extractToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'view_image');
    assert.equal(calls[0].callId, 'call_1');
    assert.deepEqual(calls[0].arguments, { path: 'a.png' });
    assert.equal(calls[0].raw, '{"path":"a.png"}');
});
