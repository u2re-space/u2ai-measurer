/**
 * @file test/fallback.test.js
 * @purpose Tests of the model fallback: the chain, the worthy errors and the repeat.
 * @depends node:test, openai/fallback
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fallbackChain, fallbackModels, fallbackWorthy, modelRefusal, withModelFallback } from '../src/openai/fallback.js';
import { defaults } from '../src/config/defaults.js';

const config = (models) => ({ fallback: { enabled: true, models } });

test('the chain of the house starts with the Kimi', () => {
    // The Gemini is the model of the run, the Kimi answers when it refuses.
    assert.deepEqual(
        fallbackChain(defaults, 'google/gemini-4-hydrogen'),
        [
            'google/gemini-4-hydrogen',
            'moonshotai/kimi-k3.1-pro',
            'openai/gpt-6.1-terra',
            'anthropic/claude-sonnet-5.5',
        ],
    );
    // Every other model falls back to the Kimi too.
    assert.deepEqual(
        fallbackChain(defaults, 'vendor/other'),
        ['vendor/other', 'moonshotai/kimi-k3.1-pro', 'openai/gpt-6.1-terra'],
    );
});

test('the chain of a model is its own list and then the shared one', () => {
    const cfg = config({
        'vendor/a': ['vendor/b', 'vendor/c'],
        '*': ['vendor/c', 'vendor/d'],
    });
    assert.deepEqual(fallbackModels(cfg, 'vendor/a'), ['vendor/b', 'vendor/c', 'vendor/d']);
    assert.deepEqual(fallbackChain(cfg, 'vendor/a'), ['vendor/a', 'vendor/b', 'vendor/c', 'vendor/d']);
});

test('the chain is empty when the fallback is off', () => {
    const cfg = { fallback: { enabled: false, models: { '*': ['vendor/b'] } } };
    assert.deepEqual(fallbackChain(cfg, 'vendor/a'), ['vendor/a']);
});

test('the next model answers when the first one fails', async () => {
    const tried = [];
    const outcome = await withModelFallback({
        config: config({ 'vendor/a': ['vendor/b'] }),
        model: 'vendor/a',
        call: async (model) => {
            tried.push(model);
            if (model === 'vendor/a') throw Object.assign(new Error('gone'), { status: 404 });
            return 'ok';
        },
    });
    assert.deepEqual(tried, ['vendor/a', 'vendor/b']);
    assert.equal(outcome.result, 'ok');
    assert.equal(outcome.model, 'vendor/b');
    assert.equal(outcome.attempts.length, 1);
    assert.match(outcome.attempts[0].error, /gone/);
});

test('a request that is refused is not retried on another model', async () => {
    const tried = [];
    await assert.rejects(async () => await withModelFallback({
        config: config({ 'vendor/a': ['vendor/b'] }),
        model: 'vendor/a',
        call: async (model) => {
            tried.push(model);
            throw Object.assign(new Error('unprocessable'), { status: 422 });
        },
    }), /unprocessable/);
    assert.deepEqual(tried, ['vendor/a']);
});

test('an abort is never retried', async () => {
    const tried = [];
    await assert.rejects(async () => await withModelFallback({
        config: config({ 'vendor/a': ['vendor/b'] }),
        model: 'vendor/a',
        call: async (model) => {
            tried.push(model);
            throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        },
    }), /aborted/);
    assert.deepEqual(tried, ['vendor/a']);
});

test('the errors that are worth another model are told apart', () => {
    assert.equal(fallbackWorthy({ status: 404 }), true);
    assert.equal(fallbackWorthy({ status: 429 }), true);
    assert.equal(fallbackWorthy({ status: 500 }), true);
    assert.equal(fallbackWorthy({ status: 422 }), false);
    assert.equal(fallbackWorthy({ status: 401 }), false);
    assert.equal(fallbackWorthy({ code: 'ABORTED' }), false);
    assert.equal(fallbackWorthy(null), false);
});

test('a refusal of the model alone is worth another model', () => {
    const refused = Object.assign(new Error("Model 'vendor/x' is not allowed for this API key."), { status: 403 });
    assert.equal(modelRefusal(refused), true);
    assert.equal(fallbackWorthy(refused), true);

    const missing = Object.assign(new Error('Model not found'), { status: 404, apiCode: 'model_not_found' });
    assert.equal(fallbackWorthy(missing), true);

    const badKey = Object.assign(new Error('Invalid API key'), { status: 401 });
    assert.equal(modelRefusal(badKey), false);
    assert.equal(fallbackWorthy(badKey), false);
});

test('the model of the outcome is the one that answered', async () => {
    const outcome = await withModelFallback({
        config: config({}),
        model: 'vendor/a',
        call: async () => 'answer',
    });
    assert.equal(outcome.model, 'vendor/a');
    assert.equal(outcome.attempts.length, 0);
});
