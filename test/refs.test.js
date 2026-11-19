/**
 * @file test/refs.test.js
 * @module test/refs
 * @purpose Tests of the references to models: the families (the cheapest member answers) and
 *          the groups (the member that fits the work answers).
 * @depends node:test, model/refs, roles/index, openai/fallback
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    familyLadder, familyModels, familyName, groupLadder, groupMembers, groupName, resolveModelRef,
} from '../src/model/refs.js';
import { fallbackChain } from '../src/openai/fallback.js';
import { resolveRole } from '../src/roles/index.js';
import { defaults } from '../src/config/defaults.js';

const configFor = (overrides = {}) => ({
    ...structuredClone(defaults),
    ...overrides,
});

test('a reference names a family only with the prefix', () => {
    assert.equal(familyName('family:gpt'), 'gpt');
    assert.equal(familyName('family: gpt '), 'gpt');
    assert.equal(familyName('openai/gpt-6.1-terra'), null);
    assert.equal(familyName('gpt'), null);
    assert.equal(familyName('family:'), null);
});

test('the family of the house is a list of models from the cheapest to the most expensive', () => {
    const config = configFor();
    assert.deepEqual(familyModels(config, 'claude'), ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5']);
    assert.deepEqual(familyModels(config, 'nothing'), []);
});

test('a family answers with the cheapest member that takes the effort', () => {
    const config = configFor();
    assert.equal(resolveModelRef('family:gpt', config), 'openai/gpt-6.1-terra');
    // The Kimi has no levels above `high`: a family that starts with it needs a model that
    // takes `xhigh` for that effort.
    const ladder = {
        ...config,
        modelFamilies: { mixed: ['moonshotai/kimi-k3.1-pro', 'openai/gpt-6.2-sol'] },
    };
    assert.equal(resolveModelRef('family:mixed', ladder, { effort: 'high' }), 'moonshotai/kimi-k3.1-pro');
    assert.equal(resolveModelRef('family:mixed', ladder, { effort: 'xhigh' }), 'openai/gpt-6.2-sol');
});

test('a reference that names a model is that model', () => {
    const config = configFor();
    assert.equal(resolveModelRef('openai/gpt-6.1-terra', config), 'openai/gpt-6.1-terra');
    assert.equal(resolveModelRef('', config), null);
    assert.equal(resolveModelRef(null, config), null);
});

test('a family that does not exist names no model', () => {
    const config = configFor();
    assert.equal(resolveModelRef('family:nothing', config), null);
});

test('the ladder of the budget stands above the model in the family', () => {
    const config = configFor();
    assert.deepEqual(familyLadder(config, 'openai/gpt-6.1-terra'), ['openai/gpt-6.2-sol']);
    assert.deepEqual(familyLadder(config, 'openai/gpt-6.2-sol'), []);
    assert.deepEqual(familyLadder(config, 'minimax/minimax-m3.1-flash'), []);
});

test('the ladder of the family joins the chain of the fallback', () => {
    const config = configFor();
    assert.deepEqual(
        fallbackChain(config, 'openai/gpt-6.1-terra'),
        ['openai/gpt-6.1-terra', 'openai/gpt-6.2-sol', 'moonshotai/kimi-k3.1-pro'],
    );
});

test('a role may be pinned to a family of models', () => {
    const config = configFor({ model: 'google/gemini-4-hydrogen' });
    config.roles.measurer.model = 'family:gpt';
    assert.equal(resolveRole(config, 'measurer', { effort: 'high' }).model, 'openai/gpt-6.1-terra');
});

test('a family of models may be untrusted with a role', () => {
    const config = configFor({ model: 'family:gemini' });
    config.house.untrusted = { 'family:gemini': ['cropper'] };
    const cropper = resolveRole(config, 'cropper', { effort: 'high' });
    assert.equal(cropper.model, 'moonshotai/kimi-k3.1-pro');
});

test('a group of models answers with the member that fits the work', () => {
    const config = configFor({
        modelGroups: {
            small: [
                { model: 'openai/gpt-6-luna' },
                { model: 'anthropic/claude-haiku-5.5', maxContext: 100_000 },
            ],
        },
    });
    assert.equal(groupName('group:small'), 'small');
    assert.equal(groupName('small'), null);
    assert.deepEqual(groupMembers(config, 'small').map((item) => item.model), [
        'openai/gpt-6-luna',
        'anthropic/claude-haiku-5.5',
    ]);
    assert.equal(resolveModelRef('group:small', config, { effort: 'high' }), 'openai/gpt-6-luna');
    assert.deepEqual(groupLadder(config, 'openai/gpt-6-luna'), ['anthropic/claude-haiku-5.5']);
    assert.ok(fallbackChain(config, 'openai/gpt-6-luna').includes('anthropic/claude-haiku-5.5'));
});

test('a role may be pinned to a group of models', () => {
    const config = configFor({
        model: 'google/gemini-4-hydrogen',
        modelGroups: { small: ['openai/gpt-6-luna'] },
    });
    config.roles.measurer.model = 'group:small';
    assert.equal(resolveRole(config, 'measurer', { effort: 'high' }).model, 'openai/gpt-6-luna');
});
