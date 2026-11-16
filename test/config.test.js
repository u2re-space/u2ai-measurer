/**
 * @file test/config.test.js
 * @purpose Tests of the configuration: the precedence of the sources, the validation and the
 *          Russian messages of the failures.
 * @depends node:test, config
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';

import { loadConfig, ensureConfigFile, redactConfig } from '../src/config.js';
import { validateConfig } from '../src/config/validate.js';
import { cloneDefaults, defaultConfigText } from '../src/config/defaults.js';
import { fromEnv } from '../src/config/env.js';
import { defaultHome, homeConfigFile } from '../src/config/paths.js';

/**
 * A temporary home directory for one test.
 * @returns {Promise<{ home: string, env: object, cleanup: () => Promise<void> }>}
 */
async function tempHome() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-config-'));
    const home = path.join(root, '.ai-measure');
    await mkdir(home, { recursive: true });
    return {
        home,
        root,
        env: { AI_MEASURE_HOME: home },
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
}

test('the defaults load when there is no config file', async () => {
    const { env, cleanup } = await tempHome();
    try {
        const config = await loadConfig({ env, cwd: process.cwd(), ensureHome: false });
        //assert.equal(config.model, 'openai/gpt-6-luna');
        assert.equal(config.model, 'google/gemini-4-hydrogen');
        assert.equal(config.agent.design, 'off');
        assert.equal(config.stages.measure.enabled, true);
        assert.equal(config.output.dir, './measurements');
        assert.equal(config.home, env.AI_MEASURE_HOME);
    } finally {
        await cleanup();
    }
});

test('the home config file overrides the defaults', async () => {
    const { home, env, cleanup } = await tempHome();
    try {
        await writeFile(homeConfigFile(home), JSON.stringify({ model: 'vendor/from-file', agent: { design: 'always' } }), 'utf-8');
        const config = await loadConfig({ env, cwd: process.cwd(), ensureHome: false });
        assert.equal(config.model, 'vendor/from-file');
        assert.equal(config.agent.design, 'always');
        // The values the file does not mention stay on the defaults.
        assert.equal(config.stages.measure.enabled, true);
    } finally {
        await cleanup();
    }
});

test('the environment overrides the file, and the file argument overrides the home file', async () => {
    const { home, env, cleanup } = await tempHome();
    try {
        await writeFile(homeConfigFile(home), JSON.stringify({ model: 'vendor/from-home' }), 'utf-8');
        const explicit = path.join(home, 'explicit.json');
        await writeFile(explicit, JSON.stringify({ model: 'vendor/from-explicit' }), 'utf-8');

        const withEnv = await loadConfig({ env: { ...env, AI_MEASURE_MODEL: 'vendor/from-env' }, cwd: home, ensureHome: false });
        assert.equal(withEnv.model, 'vendor/from-env');

        const withFile = await loadConfig({ env, configPath: explicit, cwd: home, ensureHome: false });
        assert.equal(withFile.model, 'vendor/from-explicit');
    } finally {
        await cleanup();
    }
});

test('the environment names the stages that are switched off', () => {
    const parsed = fromEnv({ AI_MEASURE_STAGE_MEASURE: '0', AI_MEASURE_DESIGN: 'always' });
    assert.equal(parsed.stages.measure.enabled, false);
    assert.equal(parsed.agent.design, 'always');
});

test('an unknown stage is refused, and the message is in Russian', () => {
    const config = cloneDefaults();
    config.stages.nowhere = { enabled: true };
    assert.throws(() => validateConfig(config), /Конфигурация: stages\.nowhere: неизвестная стадия/);
});

test('an unknown documentation source is refused', () => {
    const config = cloneDefaults();
    config.documentation.roles.measurer = ['cssUnits', 'nonsense'];
    assert.throws(() => validateConfig(config), /неизвестный источник "nonsense"/);
});

test('an invalid design mode is refused', () => {
    const config = cloneDefaults();
    config.agent.design = 'sometimes';
    assert.throws(() => validateConfig(config), /agent\.design: off \| auto \| always/);
});

test('an unknown field of the agent section is refused', () => {
    const config = cloneDefaults();
    config.agent.nonsense = 1;
    assert.throws(() => validateConfig(config), /agent\.nonsense: неизвестное поле/);
});

test('an unknown tool switch is refused', () => {
    const config = cloneDefaults();
    config.tools.nonsense = true;
    assert.throws(() => validateConfig(config), /tools\.nonsense: true \| false/);
});

test('the starter config file is valid and mentions the knobs a user edits', async () => {
    const { env, cleanup } = await tempHome();
    try {
        const created = await ensureConfigFile(env);
        assert.equal(created.created, true);
        const text = await readFile(created.file, 'utf-8');
        const parsed = JSON.parse(text);
        assert.equal(parsed.agent.design, 'off');
        assert.ok(parsed.stages.measure.enabled);
        // The starter file has to pass the validation of the merged config.
        const merged = cloneDefaults();
        merged.model = parsed.model;
        merged.agent = { ...merged.agent, ...parsed.agent };
        validateConfig(merged);
    } finally {
        await cleanup();
    }
});

test('the secrets are shortened before the config is printed', () => {
    const config = cloneDefaults();
    config.apiKey = 'sk-0123456789abcdef';
    config.backends[0].apiKey = 'sk-fedcba9876543210';
    const redacted = redactConfig(config);
    assert.notEqual(redacted.apiKey, config.apiKey);
    assert.ok(redacted.apiKey.includes('…'));
    assert.notEqual(redacted.backends[0].apiKey, config.backends[0].apiKey);
});

test('the default home is ~/.ai-measure and can be overridden', () => {
    assert.equal(defaultHome({ AI_MEASURE_HOME: 'C:\\tmp\\measure-home' }), path.resolve('C:\\tmp\\measure-home'));
    assert.equal(path.basename(defaultHome({})), '.ai-measure');
});

test('the starter config text is JSON', () => {
    const parsed = JSON.parse(defaultConfigText());
    assert.ok(parsed.backends.length);
});
