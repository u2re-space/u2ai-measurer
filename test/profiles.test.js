/**
 * @file test/profiles.test.js
 * @module test/profiles
 * @purpose Tests of the model profiles: the window, the output cap, the ceiling of the effort
 *          and the ladder of the levels the model really takes.
 * @depends node:test, model/profiles
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_PROFILES, getModelProfile, snapEffort } from '../src/model/profiles.js';

test('the profile of a model of the house is tuned by the cards of the gateway', () => {
    const gemini = MODEL_PROFILES['google/gemini-4-hydrogen'];
    assert.equal(gemini.window, 4_194_304, '1M tokens of context');
    assert.equal(gemini.maxOutput, 65536, 'the continuation decodes up to 1M tokens');
    assert.equal(gemini.ceiling, 'xhigh');
    assert.deepEqual(gemini.efforts, ['low', 'medium', 'high', 'xhigh']);

    const minimax = MODEL_PROFILES['minimax/minimax-m3.1-flash'];
    assert.equal(minimax.window, 4_194_304, '1M tokens of context');
    assert.equal(minimax.maxOutput, 524_288);

    const kimi = MODEL_PROFILES['moonshotai/kimi-k3.1-pro'];
    assert.equal(kimi.window, 4_194_304, '1M tokens of context');
    assert.equal(kimi.maxOutput, 944_000);
    assert.equal(kimi.ceiling, 'high', 'the levels above it cost the same seconds');
});

test('the effort is pulled down to the ladder of the model', () => {
    const gemini = getModelProfile('google/gemini-4-hydrogen');
    assert.equal(snapEffort('xhigh', gemini), 'xhigh');
    assert.equal(snapEffort('none', gemini), 'low', 'the card of the vendor has no none');
    assert.equal(snapEffort('max', gemini), 'xhigh', 'the ceiling of the model wins');

    const kimi = getModelProfile('moonshotai/kimi-k3.1-pro');
    assert.equal(snapEffort('high', kimi), 'high');
    assert.equal(snapEffort('none', kimi), 'none', 'the reasoning may be turned off');

    const minimax = getModelProfile('minimax/minimax-m3.1-flash');
    assert.equal(snapEffort('none', minimax), 'low', 'the endpoint refuses to work without reasoning');
});
