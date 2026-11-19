/**
 * @file test/trust.test.js
 * @module test/trust
 * @purpose Tests of the trust rule: the stages that cut a picture apart do not answer on the
 *          Gemini 4 Hydrogen and go to the Kimi instead.
 * @depends node:test, roles/index, model/trust
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRole } from '../src/roles/index.js';
import { SAFE_EFFORT, SAFE_MODEL, UNTRUSTED, isTrusted, safeEffort, safeModel } from '../src/model/trust.js';

const GEMINI = 'google/gemini-4-hydrogen';

const configFor = (overrides = {}) => ({
    model: GEMINI,
    reasoning: { effort: 'high' },
    roles: { default: {}, segmentator: {}, cropper: {}, measurer: {}, recognizer: {}, designer: {} },
    ...overrides,
});

test('the house does not trust the Gemini with the two stages that cut a picture apart', () => {
    assert.deepEqual(UNTRUSTED[GEMINI], ['segmentator', 'cropper', 'recognizer']);
    assert.equal(isTrusted('segmentator', GEMINI), false);
    assert.equal(isTrusted('cropper', GEMINI), false);
    // Every other role may answer on it.
    assert.equal(isTrusted('measurer', GEMINI), true);
    assert.equal(isTrusted('designer', GEMINI), true);
    // A model that is not in the table is trusted with every role.
    assert.equal(isTrusted('segmentator', 'minimax/minimax-m3.1-flash'), true);
});

test('the segmentation and the crop plan go to the Kimi with the reasoning at medium', () => {
    const config = configFor();
    // The stage asks for a lot: the segmentate stage asks for `max`, the crop stage for `high`.
    const segmentator = resolveRole(config, 'segmentator', { effort: 'max' });
    assert.equal(segmentator.model, SAFE_MODEL);
    assert.equal(segmentator.effort, SAFE_EFFORT);
    const cropper = resolveRole(config, 'cropper', { effort: 'high' });
    assert.equal(cropper.model, SAFE_MODEL);
    assert.equal(cropper.effort, SAFE_EFFORT);
});

test('the other roles keep the model of the run', () => {
    const config = configFor();
    const measurer = resolveRole(config, 'measurer', { effort: 'high' });
    assert.equal(measurer.model, GEMINI);
    assert.equal(measurer.effort, 'high');
});

test('another model of the house is trusted with every role', () => {
    const config = configFor({ model: 'minimax/minimax-m3.1-flash' });
    const segmentator = resolveRole(config, 'segmentator', { effort: 'max' });
    assert.equal(segmentator.model, 'minimax/minimax-m3.1-flash');
    // The effort of the model still applies: the ladder of MiniMax has no `max`.
    assert.equal(segmentator.effort, 'xhigh');
});

test('the model of the run on the command line is not a promise of trust', () => {
    const config = configFor();
    // `--model google/gemini-4-hydrogen` names the model of the run, but the two stages still
    // do not trust it.
    const segmentator = resolveRole(config, 'segmentator', { model: GEMINI, effort: 'max' });
    assert.equal(segmentator.model, SAFE_MODEL);
    assert.equal(segmentator.effort, SAFE_EFFORT);
});

test('the pin of the role in the configuration is never moved', () => {
    const config = configFor({ roles: { default: {}, segmentator: { model: GEMINI }, cropper: {} } });
    // The user named that model for that role on purpose.
    const segmentator = resolveRole(config, 'segmentator', { effort: 'max' });
    assert.equal(segmentator.model, GEMINI);
    // The cropper has no pin of its own: it moves.
    const cropper = resolveRole(config, 'cropper', { effort: 'high' });
    assert.equal(cropper.model, SAFE_MODEL);
});

test('the effort of the role in the configuration is kept', () => {
    const config = configFor({ roles: { default: {}, segmentator: { effort: 'low' }, cropper: {} } });
    const segmentator = resolveRole(config, 'segmentator', { effort: 'max' });
    assert.equal(segmentator.model, SAFE_MODEL);
    assert.equal(segmentator.effort, 'low');
});

test('the ceiling of the run still lowers the moved stage', () => {
    const config = configFor();
    const segmentator = resolveRole(config, 'segmentator', { effort: 'max', ceiling: 'low' });
    assert.equal(segmentator.model, SAFE_MODEL);
    assert.equal(segmentator.effort, 'low');
});

test('the config decides the safe model and the effort of it', () => {
    const config = configFor({
        house: {
            models: {},
            safe: { model: 'openai/gpt-6.1-terra', effort: 'low' },
            untrusted: { [GEMINI]: ['segmentator'] },
        },
    });
    assert.equal(safeModel(config), 'openai/gpt-6.1-terra');
    assert.equal(safeEffort(config), 'low');
    const segmentator = resolveRole(config, 'segmentator', { effort: 'max' });
    assert.equal(segmentator.model, 'openai/gpt-6.1-terra');
    assert.equal(segmentator.effort, 'low');
});

test('the config decides the table of the untrusted models', () => {
    const config = configFor({
        house: { models: {}, safe: { model: SAFE_MODEL, effort: SAFE_EFFORT }, untrusted: { 'minimax/minimax-m3.1-flash': ['cropper'] } },
    });
    assert.equal(isTrusted('cropper', 'minimax/minimax-m3.1-flash', config), false);
    assert.equal(isTrusted('segmentator', 'minimax/minimax-m3.1-flash', config), true);
    // The built-in table is gone: the Gemini is trusted with the stages now.
    assert.equal(isTrusted('cropper', GEMINI, config), true);
    const cropper = resolveRole(config, 'cropper', { model: 'minimax/minimax-m3.1-flash', effort: 'high' });
    assert.equal(cropper.model, SAFE_MODEL);
});

test('the house may name a model of its own for a role', () => {
    const config = configFor({
        house: { models: { measurer: 'openai/gpt-6.1-terra' }, safe: { model: SAFE_MODEL, effort: SAFE_EFFORT }, untrusted: {} },
    });
    const measurer = resolveRole(config, 'measurer', { effort: 'high' });
    assert.equal(measurer.model, 'openai/gpt-6.1-terra');
    // The other roles keep the model of the run.
    const designer = resolveRole(config, 'designer', { effort: 'high' });
    assert.equal(designer.model, GEMINI);
});
