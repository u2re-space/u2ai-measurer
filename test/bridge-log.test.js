/**
 * @file test/bridge-log.test.js
 * @purpose Tests of the live log of an external CLI: the lines of a sibling CLI while it works.
 * @depends node:test, node:assert/strict, node:path, node:os, node:fs, node:fs/promises,
 *           agent/tools, cli/renderer, shared/child-log
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createToolset, runExternalCli } from '../src/agent/tools.js';
import { createPlainRenderer, createRenderer } from '../src/cli/renderer.js';
import { createLineReader, formatBridgeLine, splitLines } from '../src/shared/child-log.js';

/**
 * A child that says it is alive and waits for the gate.
 *
 * The gate is the proof that the log is live: the child only finishes when the file
 * appears, and the file appears when the line of the child has been read.
 * @param {string} root the directory of the child
 * @returns {Promise<{ script: string, gate: string }>} the script and the gate
 */
async function liveChild(root) {
    const script = path.join(root, 'fake-ai-image.js');
    const gate = path.join(root, 'gate');
    await writeFile(script, [
        "import { existsSync } from 'node:fs';",
        'const gate = process.env.FAKE_BRIDGE_GATE;',
        "process.stdout.write('the child is alive\\n');",
        'const until = Date.now() + 5000;',
        'while (gate && !existsSync(gate) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));',
        "process.stdout.write('the child is done\\n');",
        "process.stderr.write('the child warns\\n');",
    ].join('\n'));
    return { script, gate };
}

test('the reader of the lines keeps the tail of a chunk that has no line break', () => {
    const seen = [];
    const reader = createLineReader((line) => seen.push(line));
    reader.push('the first line\nthe sec');
    assert.deepEqual(seen, ['the first line']);
    reader.push('ond line\n');
    assert.deepEqual(seen, ['the first line', 'the second line']);
});

test('the lines of a text are the lines without the empty ones', () => {
    assert.deepEqual(splitLines('one\r\ntwo\n\nthree'), ['one', 'two', 'three']);
});

test('the line of a child carries the name of the child', () => {
    assert.equal(formatBridgeLine('ai-image', 'the model is called'), '[ai-image] the model is called');
    assert.equal(formatBridgeLine('ai-image', '   '), '');
});

test('the log of an external CLI comes live, before it is over', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-bridge-log-'));
    try {
        const { script, gate } = await liveChild(root);
        const seen = [];
        let finished = false;
        const result = await runExternalCli('ai-image', [], {
            root: path.join(root, 'nowhere'),
            env: { ...process.env, AI_IMAGE_BIN: script, FAKE_BRIDGE_GATE: gate },
            cwd: root,
            timeoutMs: 20_000,
            onLine: (event) => {
                seen.push({ ...event, after: finished });
                if (event.line.includes('alive')) writeFileSync(gate, 'go');
            },
        });
        finished = true;

        assert.equal(result.code, 0);
        assert.deepEqual(seen.map((item) => item.line), [
            'the child is alive',
            'the child is done',
            'the child warns',
        ]);
        assert.deepEqual(seen.map((item) => item.stream), ['stdout', 'stdout', 'stderr']);
        // The line came while the child was working, and not with the answer of the child.
        assert.equal(seen.some((item) => item.after), false);
        // The whole output is still in the answer of the child.
        assert.match(result.stdout, /the child is done/);
        assert.match(result.stderr, /the child warns/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the tool of an external CLI tells the run what the child writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-bridge-tool-'));
    try {
        const { script, gate } = await liveChild(root);
        const events = [];
        const tools = createToolset({
            root,
            config: {},
            env: { ...process.env, AI_IMAGE_BIN: script, FAKE_BRIDGE_GATE: gate },
            packageRoot: path.join(root, 'nowhere'),
            notify: (event) => {
                events.push(event);
                if (event.line?.includes('alive')) writeFileSync(gate, 'go');
            },
        });

        const answer = await tools.execute('call_ai_image', { args: JSON.stringify(['generate', 'a cat']) });

        const logs = events.filter((event) => event.type === 'bridge.log');
        assert.ok(logs.length > 0);
        assert.equal(logs[0].name, 'ai-image');
        assert.match(logs[0].line, /the child is alive/);
        // The answer of the tool still carries the whole output of the child.
        assert.match(answer, /the child is done/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the renderer shows the line of a child', () => {
    const lines = [];
    const log = console.log;
    const error = console.error;
    const warn = console.warn;
    console.log = (text) => lines.push(text);
    console.error = (text) => lines.push(text);
    console.warn = (text) => lines.push(text);
    try {
        createPlainRenderer().event({ type: 'bridge.log', name: 'ai-image', stream: 'stdout', line: 'the model is called' });
        createRenderer().event({ type: 'bridge.log', name: 'ai-image', stream: 'stderr', line: 'the model failed' });
    } finally {
        console.log = log;
        console.error = error;
        console.warn = warn;
    }
    const text = lines.join('\n');
    assert.match(text, /ai-image/);
    assert.match(text, /the model is called/);
    assert.match(text, /the model failed/);
});
