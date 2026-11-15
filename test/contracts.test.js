/**
 * @file test/contracts.test.js
 * @purpose Tests of the contracts of the six stages: the ids, the config sections, the roles and
 *          the schemas every stage answers with.
 * @depends node:test, config, roles/index, agent/schemas, agent/tool-specs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ENUMS, BUILTIN_ROLE_NAMES, defaults, cloneDefaults, defaultConfigText, validateConfig } from '../src/config.js';
import { ROLE_INSTRUCTIONS } from '../src/roles/index.js';
import { enabledToolNames } from '../src/agent/tool-specs.js';
import {
    GEOMETRY_SCHEMA,
    PALETTE_SCHEMA,
    RECOGNITION_SCHEMA,
    SEGMENTATION_SCHEMA,
    strictnessProblems,
} from '../src/agent/schemas.js';

const STAGE_IDS = ['segmentate', 'crop', 'measure', 'recognize', 'sample', 'resolve'];

test('the six stages are known and keep their order', () => {
    assert.deepEqual(ENUMS.stages.slice(0, 6), STAGE_IDS);
    assert.equal(ENUMS.stages.at(-1), 'design');
});

test('every stage has a section in the defaults', () => {
    for (const id of STAGE_IDS) {
        const section = defaults.stages[id];
        assert.ok(section, `${id} has no section`);
        assert.equal(typeof section.enabled, 'boolean');
    }
});

test('the stages that may work in two ways name their mode', () => {
    for (const id of ['crop', 'sample', 'resolve']) {
        assert.ok(ENUMS.stageModes.includes(defaults.stages[id].mode), `${id} has no mode`);
    }
    assert.equal(defaults.stages.sample.mode, 'local');
    assert.equal(defaults.stages.sample.localEffort, 'high');
    assert.equal(defaults.stages.sample.aiEffort, 'high');
});

test('the default config passes the validation', () => {
    assert.doesNotThrow(() => validateConfig(cloneDefaults()));
});

test('a stage with an unknown mode is rejected', () => {
    const config = cloneDefaults();
    config.stages.sample.mode = 'magic';
    assert.throws(() => validateConfig(config), /stages\.sample\.mode/);
});

test('a stage with an unknown field is rejected', () => {
    const config = cloneDefaults();
    config.stages.recognize.autoCrops = true;
    assert.throws(() => validateConfig(config), /stages\.recognize\.autoCrops/);
});

test('an unknown stage is rejected', () => {
    const config = cloneDefaults();
    config.stages.nowhere = { enabled: true };
    assert.throws(() => validateConfig(config), /stages\.nowhere/);
});

test('the starter file names every stage', () => {
    const starter = JSON.parse(defaultConfigText());
    for (const id of STAGE_IDS) {
        assert.ok(starter.stages[id], `the starter file has no ${id}`);
    }
});

test('every builtin role has instructions and a tool', () => {
    for (const name of BUILTIN_ROLE_NAMES) {
        if (name === 'default') continue;
        assert.ok(ROLE_INSTRUCTIONS[name]?.length > 100, `${name} has no instructions`);
        assert.ok(enabledToolNames({}, { role: name }).length > 0, `${name} has no tools`);
    }
});

test('the schemas of the new stages are strict', () => {
    assert.deepEqual(strictnessProblems(SEGMENTATION_SCHEMA), []);
    assert.deepEqual(strictnessProblems(GEOMETRY_SCHEMA), []);
    assert.deepEqual(strictnessProblems(RECOGNITION_SCHEMA), []);
    assert.deepEqual(strictnessProblems(PALETTE_SCHEMA), []);
});

test('the schemas of the new stages ask for different things', () => {
    assert.ok(SEGMENTATION_SCHEMA.properties.zones);
    assert.ok(GEOMETRY_SCHEMA.properties.elements);
    assert.ok(RECOGNITION_SCHEMA.properties.texts);
    assert.ok(PALETTE_SCHEMA.properties.colors);
});
