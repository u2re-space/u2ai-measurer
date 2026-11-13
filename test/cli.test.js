/**
 * @file test/cli.test.js
 * @purpose Tests of the CLI: the parsing of the arguments, the local commands and the exit codes.
 * @depends node:test, cli, help
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';

import { EXIT, apiKeyAvailable, main, parseArgv } from '../src/cli.js';
import { COMMAND_NAMES, HELP } from '../src/help.js';

/**
 * Run the CLI and collect what it printed.
 * @param {string[]} argv
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function run(argv) {
    const out = [];
    const err = [];
    const log = console.log;
    const warn = console.warn;
    const error = console.error;
    console.log = (...args) => out.push(args.join(' '));
    console.warn = (...args) => err.push(args.join(' '));
    console.error = (...args) => err.push(args.join(' '));
    try {
        const code = await main(argv);
        return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
        console.log = log;
        console.warn = warn;
        console.error = error;
    }
}

/**
 * A working directory with a picture.
 * @returns {Promise<{ dir: string, file: string, cleanup: () => Promise<void> }>}
 */
async function workspace() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-cli-'));
    const file = path.join(dir, 'picture.png');
    await sharp({
        create: { width: 40, height: 30, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } },
    }).png().toFile(file);
    return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the help lists every command', () => {
    for (const command of COMMAND_NAMES) {
        assert.match(HELP, new RegExp(`\\b${command}\\b`), `${command} is not in the help`);
    }
    assert.match(HELP, /ai-measure/);
});

test('the first positional is the command when it names one', () => {
    assert.equal(parseArgv(['palette', 'a.png']).command, 'palette');
    assert.equal(parseArgv(['measure', 'a.png']).command, 'measure');
    assert.deepEqual(parseArgv(['palette', 'a.png']).images, ['a.png']);
});

test('a positional that is not a command is an input of the measure command', () => {
    const parsed = parseArgv(['a.png', 'b.png']);
    assert.equal(parsed.command, 'measure');
    assert.deepEqual(parsed.images, ['a.png', 'b.png']);
});

test('the options are read', () => {
    const parsed = parseArgv([
        'measure', '-i', 'a.png', '-i', 'b.png', '--out', './out', '--stages', 'measure,resolve',
        '-m', 'vendor/x', '--effort', 'high', '--task', 'a page', '--dry-run', '--verbose',
    ]);
    assert.deepEqual(parsed.images, ['a.png', 'b.png']);
    assert.equal(parsed.out, './out');
    assert.deepEqual(parsed.stages, ['measure', 'resolve']);
    assert.equal(parsed.model, 'vendor/x');
    assert.equal(parsed.effort, 'high');
    assert.equal(parsed.task, 'a page');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.verbose, true);
});

test('the crop options are read', () => {
    const parsed = parseArgv(['crop', 'a.png', '--x', '1', '--y', '2', '--width', '3', '--height', '4', '--output', 'out.png']);
    assert.equal(parsed.x, '1');
    assert.equal(parsed.y, '2');
    assert.equal(parsed.width, '3');
    assert.equal(parsed.height, '4');
    assert.equal(parsed.output, 'out.png');
});

test('the help is printed and the exit code is 0', async () => {
    const { code, out } = await run(['--help']);
    assert.equal(code, EXIT.ok);
    assert.match(out, /Usage:/);
});

test('the version is printed and the exit code is 0', async () => {
    const { code, out } = await run(['--version']);
    assert.equal(code, EXIT.ok);
    assert.match(out, /\d+\.\d+\.\d+/);
});

test('the docs command prints the standards', async () => {
    const { code, out } = await run(['docs', 'cssUnits']);
    assert.equal(code, EXIT.ok);
    assert.match(out, /CSS units/);
});

test('an unknown documentation is a usage error', async () => {
    const { code, err } = await run(['docs', 'nothing']);
    assert.equal(code, EXIT.usage);
    assert.match(err, /Unknown documentation/);
});

test('the palette command samples the colours of a picture', async () => {
    const pic = await workspace();
    try {
        const { code, out } = await run(['palette', pic.file, '--colors', '2']);
        assert.equal(code, EXIT.ok);
        assert.match(out, /#[0-9a-f]{6}/i);
        assert.match(out, /oklch\(/);
    } finally {
        await pic.cleanup();
    }
});

test('the crop command cuts a rectangle', async () => {
    const pic = await workspace();
    try {
        const output = path.join(pic.dir, 'cut.png');
        const { code, out } = await run(['crop', pic.file, '--x', '0', '--y', '0', '--width', '10', '--height', '8', '--output', output]);
        assert.equal(code, EXIT.ok);
        assert.match(out, /Cropped/);
        const info = await sharp(output).metadata();
        assert.equal(info.width, 10);
        assert.equal(info.height, 8);
    } finally {
        await pic.cleanup();
    }
});

test('the crop command without a size is a usage error', async () => {
    const pic = await workspace();
    try {
        const { code } = await run(['crop', pic.file]);
        assert.equal(code, EXIT.usage);
    } finally {
        await pic.cleanup();
    }
});

test('the split command cuts a grid', async () => {
    const pic = await workspace();
    try {
        const outDir = path.join(pic.dir, 'tiles');
        const { code, out } = await run(['split', pic.file, '--rows', '2', '--cols', '2', '--out-dir', outDir]);
        assert.equal(code, EXIT.ok);
        assert.match(out, /Split into 4 tiles/);
    } finally {
        await pic.cleanup();
    }
});

test('the measure command without a picture is a usage error', async () => {
    const { code, err } = await run(['measure']);
    assert.equal(code, EXIT.usage);
    assert.match(err, /needs at least one picture/);
});

test('the config command prints the resolved configuration', async () => {
    const { code, out } = await run(['config']);
    assert.equal(code, EXIT.ok);
    const parsed = JSON.parse(out);
    assert.ok(parsed.model);
});

test('the skills command lists the packs of the home directory', async () => {
    const { code, out } = await run(['skills']);
    assert.equal(code, EXIT.ok);
    assert.ok(out.length >= 0);
});

test('the key of a local backend is enough', () => {
    const config = {
        backends: [{ baseURL: 'http://127.0.0.1:1234/v1', env: 'LOCAL_KEY' }],
    };
    assert.equal(apiKeyAvailable(config, { LOCAL_KEY: 'secret' }), true);
    assert.equal(apiKeyAvailable(config, {}), true);
    assert.equal(apiKeyAvailable({ backends: [{ baseURL: 'https://example.com/v1' }] }, {}), false);
});
