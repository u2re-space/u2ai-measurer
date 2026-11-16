/**
 * @file test/roles.test.js
 * @purpose Tests of the roles: the resolution of the model and the effort, the schemas and the
 *          loop that talks to the API and runs the tools.
 * @depends node:test, roles/index, agent/schemas, agent/documentation
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ROLE_INSTRUCTIONS, createRoleRunner, resolveRole, resolveRoleInstructions, roleContext } from '../src/roles/index.js';
import {
    CROP_PLAN_SCHEMA,
    DESIGN_SCHEMA,
    MEASUREMENT_SCHEMA,
    SEGMENTATION_SCHEMA,
    schemaProblems,
    schemaProblemsText,
    strictnessProblems,
} from '../src/agent/schemas.js';
import { documentationFor, documentationNames } from '../src/agent/documentation.js';

const configFor = (overrides = {}) => ({
    model: 'vendor/default',
    reasoning: { effort: 'high' },
    roles: { default: {}, measurer: {}, cropper: {}, designer: {} },
    documentation: { roles: { measurer: ['cssUnits'], designer: [] } },
    ...overrides,
});

test('every role has its instructions', () => {
    for (const name of ['segmentator', 'cropper', 'measurer', 'recognizer', 'sampler', 'resolver', 'designer']) {
        assert.ok(ROLE_INSTRUCTIONS[name].length > 100, `${name} has no instructions`);
        assert.equal(resolveRoleInstructions(name), ROLE_INSTRUCTIONS[name]);
    }
    assert.equal(resolveRoleInstructions('nothing'), null);
});

test('the model of a role wins over the default and over the top level', () => {
    const config = configFor({ roles: { default: { model: 'vendor/default-role' }, measurer: { model: 'vendor/measurer' } } });
    assert.equal(resolveRole(config, 'measurer').model, 'vendor/measurer');
    // The default entry applies to every role that does not name a model of its own.
    assert.equal(resolveRole(config, 'cropper').model, 'vendor/default-role');
    // Without a default the top level of the config is used.
    assert.equal(resolveRole(configFor(), 'designer').model, 'vendor/default');
});

test('the model of the run wins over the config', () => {
    const config = configFor({ roles: { default: {}, measurer: { model: 'vendor/measurer' } } });
    assert.equal(resolveRole(config, 'measurer', { model: 'vendor/run' }).model, 'vendor/run');
});

test('the effort of the config is snapped to what the model accepts', () => {
    const config = configFor({ model: 'openai/gpt-6-luna', reasoning: { effort: 'xhigh' } });
    const role = resolveRole(config, 'measurer');
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(role.effort), `unexpected effort ${role.effort}`);
});

test('the role of a role limits its effort', () => {
    const config = configFor({ reasoning: { effort: 'high' }, roles: { default: {}, measurer: { maxEffort: 'low' } } });
    assert.equal(resolveRole(config, 'measurer').effort, 'low');
});

test('the ceiling of the run lowers the effort of the stage and never raises it', () => {
    const config = configFor({ model: 'google/gemini-4-hydrogen', reasoning: { effort: 'xhigh' } });
    // The stage asks for a lot, the run promises less: the promise wins.
    assert.equal(resolveRole(config, 'measurer', { effort: 'xhigh', ceiling: 'medium' }).effort, 'medium');
    // A stage that asks for less than the ceiling keeps its own effort.
    assert.equal(resolveRole(config, 'measurer', { effort: 'low', ceiling: 'xhigh' }).effort, 'low');
    // Without a ceiling the stage keeps what it asks for.
    assert.equal(resolveRole(config, 'measurer', { effort: 'high' }).effort, 'high');
});

test('the effort of the role wins over the effort of the stage', () => {
    const config = configFor({
        model: 'google/gemini-4-hydrogen',
        reasoning: { effort: 'high' },
        roles: { default: {}, measurer: { effort: 'low' } },
    });
    assert.equal(resolveRole(config, 'measurer', { effort: 'xhigh' }).effort, 'low');
});

test('the two ceilings of a role are the lower of them', () => {
    const config = configFor({
        model: 'google/gemini-4-hydrogen',
        reasoning: { effort: 'xhigh' },
        roles: { default: {}, measurer: { maxEffort: 'medium' } },
    });
    // The role caps at medium, the run at high: medium wins.
    assert.equal(resolveRole(config, 'measurer', { effort: 'xhigh', ceiling: 'high' }).effort, 'medium');
    // The run caps at low, the role at medium: low wins.
    assert.equal(resolveRole(config, 'measurer', { effort: 'xhigh', ceiling: 'low' }).effort, 'low');
});

test('the Kimi is the fast model and the ceiling of its effort is medium', () => {
    const config = configFor({ model: 'moonshotai/kimi-k3.1-pro', reasoning: { effort: 'high' } });
    // The levels above `medium` cost the same seconds: the ceiling of the model wins.
    assert.equal(resolveRole(config, 'measurer').effort, 'high');
    // The reasoning may be turned off: the request is not refused, it is only fast.
    const fast = configFor({ model: 'moonshotai/kimi-k3.1-pro', reasoning: { effort: 'none' } });
    assert.equal(resolveRole(fast, 'measurer').effort, 'none');
});

test('the documentation of a role comes from the config', () => {
    const config = configFor();
    assert.match(roleContext(config, 'measurer'), /CSS units/);
    assert.equal(roleContext(config, 'designer'), '');
});

test('the documentation names are the ones the config accepts', () => {
    assert.ok(documentationNames().includes('wcagColors'));
    assert.equal(documentationFor(['nothing']), '');
    assert.match(documentationFor(['wcagColors']), /4\.5/);
});

test('the schemas of the roles are strict', () => {
    assert.deepEqual(strictnessProblems(MEASUREMENT_SCHEMA), []);
    assert.deepEqual(strictnessProblems(DESIGN_SCHEMA), []);
    assert.deepEqual(strictnessProblems(CROP_PLAN_SCHEMA), []);
});

test('a schema that is not strict is reported', () => {
    const problems = strictnessProblems({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
    });
    assert.equal(problems.length, 2);
});

test('an answer that does not follow the schema is reported', () => {
    // The answer the model gives when the backend drops the format rule: the field that says
    // which zone is worth cutting is called something else.
    const problems = schemaProblems({
        summary: 'A page.',
        zones: [{ name: 'hero', kind: 'image', mark: 'asset' }],
    }, SEGMENTATION_SCHEMA);
    assert.ok(problems.some((item) => /crop/.test(item)), 'the missing field is not named');
    assert.ok(problems.some((item) => /mark/.test(item)), 'the extra field is not named');
    // An answer that follows the schema has no problems.
    assert.deepEqual(schemaProblems({ summary: 'ok' }, {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
    }), []);
});

test('the problems of an answer are told as one line', () => {
    assert.equal(schemaProblemsText([]), '');
    assert.match(schemaProblemsText(['a: the field is missing', 'b: the field is missing']), /a: the field is missing/);
    assert.match(schemaProblemsText(new Array(10).fill('x'), 3), /and 7 more/);
});

test('the runner reads the JSON answer of a role', async () => {
    const client = {
        responses: {
            async create(params) {
                assert.equal(params.model, 'vendor/default');
                assert.match(params.instructions, /measurer/);
                return { output_text: JSON.stringify({ summary: 'ok' }), output: [] };
            },
        },
    };
    const runner = createRoleRunner({ client, config: configFor() });
    const answer = await runner.run('measurer', { text: 'measure', schema: MEASUREMENT_SCHEMA, schemaName: 'measurement' });
    assert.equal(answer.status, 'completed');
    assert.deepEqual(answer.data, { summary: 'ok' });
    assert.equal(answer.error, null);
});

test('the runner executes the tools the model asks for and feeds the answers back', async () => {
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                if (calls.length === 1) {
                    return {
                        output: [{
                            type: 'function_call',
                            id: 'call-1',
                            name: 'view_image',
                            arguments: JSON.stringify({ path: 'picture.png' }),
                        }],
                        output_text: '',
                    };
                }
                return { output_text: JSON.stringify({ summary: 'done' }), output: [] };
            },
        },
    };
    const toolset = {
        specsFor: () => [],
        async execute(name, args) {
            assert.equal(name, 'view_image');
            assert.deepEqual(args, { path: 'picture.png' });
            return 'Image picture.png: 10×10 png';
        },
    };
    const runner = createRoleRunner({ client, config: configFor(), toolset });
    const answer = await runner.run('measurer', { text: 'measure', maxTurns: 3 });
    assert.equal(calls.length, 2);
    assert.equal(answer.data.summary, 'done');
    // The answer of the tool is in the second request.
    const second = JSON.stringify(calls[1].input);
    assert.match(second, /Image picture\.png/);
    assert.match(second, /function_call_output/);
});

test('a role with tools looks first and answers afterwards', async () => {
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                if (calls.length === 1) {
                    return {
                        output: [{
                            type: 'function_call',
                            id: 'call-1',
                            call_id: 'call-1',
                            name: 'view_image',
                            arguments: JSON.stringify({ path: 'picture.png' }),
                        }],
                        output_text: '',
                    };
                }
                if (calls.length === 2) {
                    return { output_text: 'I measured a box of 10 by 10.', output: [] };
                }
                return { output_text: JSON.stringify({ summary: 'done' }), output: [] };
            },
        },
    };
    const toolset = {
        specsFor: () => [{ type: 'function', name: 'view_image', parameters: { type: 'object' } }],
        async execute() { return 'Image picture.png: 10×10 png'; },
    };
    const runner = createRoleRunner({ client, config: configFor(), toolset });
    const answer = await runner.run('measurer', {
        text: 'measure',
        parts: [{ type: 'input_image', image_url: 'data:image/png;base64,AA' }],
        schema: MEASUREMENT_SCHEMA,
        schemaName: 'measurement',
        maxTurns: 3,
    });
    assert.equal(calls.length, 3);
    // The first phase looks and carries no schema.
    assert.equal(calls[0].schema, null);
    assert.ok(calls[0].tools.length > 0);
    // The second phase answers under the schema and calls no tool.
    assert.equal(calls[2].tools, null);
    assert.equal(calls[2].schemaChannel, 'format');
    assert.deepEqual(answer.data, { summary: 'done' });
});

test('the answer phase carries the schema in the prompt as well', async () => {
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                if (calls.length === 1) {
                    return {
                        output: [{
                            type: 'function_call',
                            id: 'call-1',
                            call_id: 'call-1',
                            name: 'view_image',
                            arguments: JSON.stringify({ path: 'picture.png' }),
                        }],
                        output_text: '',
                    };
                }
                if (calls.length === 2) return { output_text: 'I measured a box of 10 by 10.', output: [] };
                return { output_text: JSON.stringify({ summary: 'done' }), output: [] };
            },
        },
    };
    const toolset = {
        specsFor: () => [{ type: 'function', name: 'view_image', parameters: { type: 'object' } }],
        async execute() { return 'Image picture.png: 10×10 png'; },
    };
    const runner = createRoleRunner({ client, config: configFor(), toolset });
    await runner.run('measurer', {
        text: 'measure',
        schema: MEASUREMENT_SCHEMA,
        schemaName: 'measurement',
        maxTurns: 3,
    });
    // A backend that does not apply the format rule still has to tell the model the names of
    // the fields: the schema is in the prompt of the answer phase.
    assert.match(calls[2].instructions, /property names/);
    assert.ok(calls[2].instructions.includes('"rootFontSize"'), 'the schema is not in the prompt');
    // The phase that looks carries no schema.
    assert.equal(calls[0].instructions.includes('"rootFontSize"'), false);
});

test('an answer that does not follow the schema is reported to the stage', async () => {
    const client = {
        responses: {
            async create() {
                return {
                    output_text: JSON.stringify({
                        summary: 'A page.',
                        zones: [{ name: 'hero', kind: 'image', mark: 'asset' }],
                    }),
                    output: [],
                };
            },
        },
    };
    const runner = createRoleRunner({ client, config: configFor() });
    const answer = await runner.run('segmentator', {
        text: 'split',
        schema: SEGMENTATION_SCHEMA,
        schemaName: 'segmentation',
    });
    assert.ok(answer.schemaProblems.length > 0);
    assert.match(answer.schemaProblems.join(' '), /crop/);
});

test('the schema travels as a tool when the mode says so', async () => {
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                return {
                    output: [{
                        type: 'function_call',
                        id: 'call-1',
                        call_id: 'call-1',
                        name: 'measurement',
                        arguments: JSON.stringify({ summary: 'done' }),
                    }],
                    output_text: '',
                };
            },
        },
    };
    const toolset = {
        specsFor: () => [{ type: 'function', name: 'view_image', parameters: { type: 'object' } }],
        async execute() { return 'never'; },
    };
    const runner = createRoleRunner({ client, config: configFor(), toolset });
    const answer = await runner.run('measurer', {
        text: 'measure',
        schema: MEASUREMENT_SCHEMA,
        schemaName: 'measurement',
        schemaMode: 'tool',
        maxTurns: 3,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(answer.data, { summary: 'done' });
});

test('a failed call is reported as an error, not as an exception', async () => {
    const client = {
        responses: {
            async create() {
                throw new Error('the host is down');
            },
        },
    };
    const runner = createRoleRunner({ client, config: configFor() });
    const answer = await runner.run('measurer', { text: 'measure' });
    assert.equal(answer.status, 'error');
    assert.match(answer.error, /the host is down/);
});

test('an unknown role is refused', async () => {
    const client = { responses: { async create() { throw new Error('must not be called'); } } };
    const runner = createRoleRunner({ client, config: configFor() });
    const answer = await runner.run('nothing', { text: 'x' });
    assert.equal(answer.status, 'error');
    assert.match(answer.error, /Unknown role/);
});
