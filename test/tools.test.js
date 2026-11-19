/**
 * @file test/tools.test.js
 * @purpose Tests of the agent tools: the catalogue, the executor and the sandbox of the writes.
 * @depends node:test, agent/tools, agent/tool-specs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';

import { createToolset, externalCliCandidates, mcpToolEntries, resolveExternalCli } from '../src/agent/tools.js';
import { CONFIG_KEYS, TOOL_NAMES, TOOL_SPECS, enabledToolNames, toolEnabled, toolSpecs } from '../src/agent/tool-specs.js';

/**
 * A working directory with a picture and a text file.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function workspace() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-tools-'));
    // Half black, half white: two colours, so the contrast has something to compare.
    const width = 80;
    const height = 60;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            const value = x < width / 2 ? 0 : 255;
            data[at] = value;
            data[at + 1] = value;
            data[at + 2] = value;
            data[at + 3] = 255;
        }
    }
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path.join(root, 'picture.png'));
    await writeFile(path.join(root, 'notes.md'), 'the quick brown fox\njumps over the lazy dog\n', 'utf-8');
    await mkdir(path.join(root, 'out'), { recursive: true });
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('the catalogue holds every tool of the measurer', () => {
    for (const name of ['view_image', 'crop_image', 'split_image', 'sample_colors', 'list_files', 'read_file', 'read_skill', 'write_file', 'search_files', 'call_ai_image', 'call_ai_decompose']) {
        assert.ok(TOOL_NAMES.includes(name), `${name} is missing`);
        assert.ok(TOOL_SPECS[name].description.length > 10);
        assert.equal(toolSpecKey(name), TOOL_SPECS[name].configKey);
    }
});

/**
 * The config switch of a tool.
 * @param {string} name
 * @returns {string}
 */
function toolSpecKey(name) {
    return TOOL_SPECS[name].configKey;
}

test('a tool that is not mentioned in the config is on', () => {
    assert.equal(toolEnabled({}, 'view_image'), true);
    assert.equal(toolEnabled({ image_view: false }, 'view_image'), false);
});

test('a switched-off tool is not in the list of the tools', () => {
    const names = enabledToolNames({ image_crop: false });
    assert.ok(!names.includes('crop_image'));
    assert.ok(names.includes('view_image'));
    assert.equal(toolSpecs({ image_crop: false }).length, TOOL_NAMES.length - 1);
});

test('the tools are cut down by the role', () => {
    const measurer = enabledToolNames({}, { role: 'measurer' });
    const designer = enabledToolNames({}, { role: 'designer' });
    assert.ok(!measurer.includes('write_file'));
    assert.ok(designer.includes('write_file'));
    assert.ok(designer.includes('read_skill'));
    assert.ok(designer.includes('call_ai_image'));
});

test('every tool has its own config switch', () => {
    assert.equal(new Set(CONFIG_KEYS).size, TOOL_NAMES.length);
});

test('the view_image tool reads the size of a picture', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        const answer = await toolset.execute('view_image', { path: 'picture.png' });
        assert.match(answer, /picture\.png/);
        assert.match(answer, /80×60/);
    } finally {
        await cleanup();
    }
});

test('the sample_colors tool answers with hex, OKLCH and the contrast', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        const answer = await toolset.execute('sample_colors', { path: 'picture.png', k: 2 });
        assert.match(answer, /#[0-9a-f]{6}/i);
        assert.match(answer, /oklch\(/);
        assert.match(answer, /contrast/);
    } finally {
        await cleanup();
    }
});

test('the list_files tool lists the files of the directory', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        const answer = await toolset.execute('list_files', { path: '.' });
        assert.match(answer, /notes\.md/);
        assert.match(answer, /picture\.png/);
    } finally {
        await cleanup();
    }
});

test('the read_file tool reads a text file', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        const answer = await toolset.execute('read_file', { path: 'notes.md' });
        assert.match(answer, /quick brown fox/);
    } finally {
        await cleanup();
    }
});

test('the read_skill tool reads a global Agent Skill', async () => {
    const { root, cleanup } = await workspace();
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-home-'));
    try {
        const skillDir = path.join(home, '.agents', 'skills', 'oil-ui');
        await mkdir(skillDir, { recursive: true });
        await writeFile(
            path.join(skillDir, 'SKILL.md'),
            '---\nname: oil-ui\ndescription: UI design workflow.\n---\nChoose one clear visual direction.',
            'utf-8',
        );
        const toolset = createToolset({ root, config: { tools: {} }, env: { HOME: home } });
        const answer = await toolset.execute('read_skill', { name: 'oil-ui' });
        assert.match(answer, /visual direction/);
    } finally {
        await cleanup();
        await rm(home, { recursive: true, force: true });
    }
});

test('the search_files tool finds the files by their content', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        const answer = await toolset.execute('search_files', { query: 'lazy dog', inContent: 1 });
        assert.match(answer, /notes\.md/);
    } finally {
        await cleanup();
    }
});

test('the search_files tool finds the files by their names and by a glob', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        // The names: the paths of the files themselves.
        const names = await toolset.execute('search_files', { query: 'notes', inContent: 0 });
        assert.match(names, /notes\.md/);
        assert.doesNotMatch(names, /picture\.png/);
        // The glob cuts the files before they are read.
        const md = await toolset.execute('search_files', { query: 'quick', inContent: 1, glob: '*.md' });
        assert.match(md, /notes\.md/);
        // The regular expression finds the content.
        const regex = await toolset.execute('search_files', { query: 'quick.*fox', regex: 1 });
        assert.match(regex, /notes\.md/);
    } finally {
        await cleanup();
    }
});

test('the write_file tool writes into the directory that was opened', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} }, writeDirs: [path.join(root, 'out')] });
        const answer = await toolset.execute('write_file', { path: 'out/note.txt', content: 'hello' });
        assert.match(answer, /Written/);
        assert.equal(await readFile(path.join(root, 'out', 'note.txt'), 'utf-8'), 'hello');
    } finally {
        await cleanup();
    }
});

test('the write_file tool refuses a path outside the opened directory', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} }, writeDirs: [path.join(root, 'out')] });
        await assert.rejects(
            () => toolset.execute('write_file', { path: 'escaped.txt', content: 'no' }),
            /forbidden/,
        );
        assert.equal(await stat(path.join(root, 'escaped.txt')).then(() => true).catch(() => false), false);
    } finally {
        await cleanup();
    }
});

test('a file name without a folder lands in the scratch of the run', async () => {
    const { root, cleanup } = await workspace();
    try {
        const scratch = path.join(root, '.ai', 'tmp', 'w1', 'scratch');
        const toolset = createToolset({
            root,
            config: { tools: {} },
            writeDirs: [path.join(root, 'out')],
            scratch,
        });
        const answer = await toolset.execute('write_file', { path: 'note.txt', content: 'hello' });
        assert.match(answer, /scratch/);
        assert.equal(await readFile(path.join(scratch, 'note.txt'), 'utf-8'), 'hello');
        // The root of the project is not the model's.
        assert.equal(await stat(path.join(root, 'note.txt')).then(() => true).catch(() => false), false);
    } finally {
        await cleanup();
    }
});

test('the crop_image tool without an output writes into the scratch of the run', async () => {
    const { root, cleanup } = await workspace();
    try {
        const scratch = path.join(root, '.ai', 'tmp', 'w1', 'scratch');
        const toolset = createToolset({
            root,
            config: { tools: {} },
            writeDirs: [path.join(root, 'out')],
            scratch,
        });
        const answer = await toolset.execute('crop_image', { path: 'picture.png', x: 0, y: 0, width: 20, height: 10 });
        assert.match(answer, /scratch/);
        assert.ok(await stat(path.join(scratch, 'picture-crop.png')).then((info) => info.isFile()));
        assert.equal(await stat(path.join(root, 'picture-crop.png')).then(() => true).catch(() => false), false);
    } finally {
        await cleanup();
    }
});

test('the crop_image tool cuts a rectangle out of a picture', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} }, writeDirs: [path.join(root, 'out')] });
        const answer = await toolset.execute('crop_image', {
            path: 'picture.png', x: 0, y: 0, width: 20, height: 10, output: 'out/cut.png',
        });
        assert.match(answer, /20×10/);
        const info = await sharp(path.join(root, 'out', 'cut.png')).metadata();
        assert.equal(info.width, 20);
        assert.equal(info.height, 10);
    } finally {
        await cleanup();
    }
});

test('the tools refuse to leave the working directory', async () => {
    const { root, cleanup } = await workspace();
    try {
        const toolset = createToolset({ root, config: { tools: {} } });
        await assert.rejects(() => toolset.execute('read_file', { path: '../secret.txt' }), /outside|forbidden|not allowed/i);
    } finally {
        await cleanup();
    }
});

test('the external CLIs are looked up in a fixed order', () => {
    const candidates = externalCliCandidates('ai-image', { root: 'C:\\pkg', env: { AI_IMAGE_BIN: 'C:\\bin\\ai-image.js' } });
    assert.equal(candidates[0], path.resolve('C:\\bin\\ai-image.js'));
    assert.ok(candidates.some((item) => item.includes(path.join('@u2ai', 'images'))));
});

test('the external CLI is not found when it is not installed', async () => {
    const found = await resolveExternalCli('ai-image', { root: 'C:\\nowhere', env: { PATH: '' } });
    assert.equal(found, null);
});

test('the tools of an MCP server are named so that two servers cannot collide', () => {
    const entries = mcpToolEntries([
        { name: 'first server', tools: [{ name: 'search', description: 'x' }] },
        { name: 'first server', tools: [{ name: 'index', description: 'y' }] },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'mcp_first_server_search');
    assert.equal(entries[1].name, 'mcp_first_server_index');
});
