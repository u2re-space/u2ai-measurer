/**
 * @file test/roles.test.js
 * @purpose Tests of the roles: the resolution of the model and the effort, the schemas and the
 *          loop that talks to the API and runs the tools.
 * @depends node:test, roles/index, agent/schemas, agent/documentation
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ROLE_INSTRUCTIONS, createRoleRunner, resolveRole, resolveRoleInstructions, roleContext } from '../src/roles/index.js';
import { CROP_PLAN_SCHEMA, DESIGN_SCHEMA, MEASUREMENT_SCHEMA, strictnessProblems } from '../src/agent/schemas.js';
import { documentationFor, documentationNames } from '../src/agent/documentation.js';

const configFor = (overrides = {}) => ({
    model: 'vendor/default',
    reasoning: { effort: 'high' },
    roles: { default: {}, measurer: {}, cropper: {}, designer: {} },
    documentation: { roles: { measurer: ['cssUnits'], designer: [] } },
    ...overrides,
});

test('every role has its instructions', () => {
    for (const name of ['measurer', 'measurerFragment', 'cropper', 'designer']) {
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
    assert.ok(['low', 'medium'].includes(role.effort), `unexpected effort ${role.effort}`);
});

test('the role of a role limits its effort', () => {
    const config = configFor({ reasoning: { effort: 'high' }, roles: { default: {}, measurer: { maxEffort: 'low' } } });
    assert.equal(resolveRole(config, 'measurer').effort, 'low');
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
