/**
 * @file test/context.test.js
 * @purpose Tests of the context of a run and of the map of a run: the journal, the state, the
 *          cache, the brief, the index of the files and the tools that read through them.
 *
 * The context lives in `.tmp/<id>/context/` and the map in `.tmp/<id>/map.json`: both belong to
 * the run and die with it. A new run starts with a clean head.
 *
 * @depends node:test, agent/context, agent/run-map, agent/tools
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { openContext, contextDirectory, contextRel, cacheKeyFor } from '../src/agent/context.js';
import {
    buildRunMap,
    loadRunMap,
    mapFiles,
    openRunMap,
    runMapFile,
    runMapRel,
    searchRunMap,
} from '../src/agent/run-map.js';
import { createToolset } from '../src/agent/tools.js';

/**
 * A working directory with a few files.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function workspace() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-context-'));
    await writeFile(path.join(root, 'notes.md'), 'the quick brown fox\njumps over the lazy dog\n', 'utf-8');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.js'), 'export function greet() {\n    return "hello";\n}\n', 'utf-8');
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// --- the context of a run ---------------------------------------------------

test('the context of a run keeps its journal, its state and its notes', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-1' });
        await context.references([{ rel: 'landing.png', kind: 'original' }]);
        await context.decision('The picture is a 1024×768 screen.');
        await context.stage('segmentate', 'done', '2 zones found.');
        await context.file('measurements/stages/geometry.json');

        const journal = await context.journal();
        assert.equal(journal.length, 2);
        assert.equal(journal[0].kind, 'decision');
        assert.equal(journal[1].kind, 'stage');

        const state = JSON.parse(await readFile(path.join(contextDirectory(root, 'run-1'), 'state.json'), 'utf-8'));
        assert.equal(state.references[0].rel, 'landing.png');
        assert.equal(state.stages.segmentate.status, 'done');
        assert.ok(state.files.includes('measurements/stages/geometry.json'));

        const notes = await context.digest();
        assert.ok(notes.endsWith('notes.md'));
        const text = await readFile(notes, 'utf-8');
        assert.match(text, /landing\.png/);
        assert.match(text, /2 zones found/);
    } finally {
        await cleanup();
    }
});

test('the brief of the context names the exact paths of the pictures', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-2' });
        await context.references([{ rel: 'landing.png', kind: 'original' }]);
        await context.stage('crop', 'done', '3 fragments cut.');
        const brief = context.brief();
        assert.match(brief, /landing\.png/);
        assert.match(brief, /these paths are exact/i);
        assert.match(brief, /crop/);
    } finally {
        await cleanup();
    }
});

test('the cache of the context answers a question that was already asked', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-3' });
        assert.equal(await context.cached('a-question'), null);
        await context.put('a-question', { answer: '42' });
        const hit = await context.cached('a-question');
        assert.equal(hit.answer, '42');
        assert.equal(cacheKeyFor('a-question'), cacheKeyFor('a-question'));
    } finally {
        await cleanup();
    }
});

test('a switched-off context does nothing and does not fail', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-4', enabled: false });
        assert.equal(context.enabled, false);
        await context.decision('nothing');
        await context.references([{ rel: 'landing.png' }]);
        assert.equal(context.brief(), '');
        assert.deepEqual(await context.journal(), []);
        assert.equal(await context.digest(), null);
    } finally {
        await cleanup();
    }
});

test('the context of a run dies with it and does not leak into the next one', async () => {
    const { root, cleanup } = await workspace();
    try {
        const first = await openContext({ root, workId: 'run-old' });
        await first.decision('the old decision');
        await first.close();

        const second = await openContext({ root, workId: 'run-new' });
        assert.doesNotMatch(second.brief(), /the old decision/);
        assert.deepEqual(await second.journal(), []);
        assert.equal(contextRel('run-new'), '.tmp/run-new/context');
    } finally {
        await cleanup();
    }
});

// --- the map of a run -------------------------------------------------------

test('the map of a run indexes the files with their lines and their symbols', async () => {
    const { root, cleanup } = await workspace();
    try {
        const map = await buildRunMap({ root, workId: 'run-5' });
        assert.ok(map.files['notes.md']);
        assert.equal(map.files['notes.md'].lineCount, 3);
        assert.equal(map.files['src/app.js'].kind, 'code');
        const symbol = map.files['src/app.js'].symbols.find((item) => item.name === 'greet');
        assert.equal(symbol.kind, 'export');
        assert.equal(symbol.line, 1);

        const saved = await loadRunMap({ root, workId: 'run-5' });
        assert.ok(saved.files['notes.md']);
        assert.equal(runMapRel('run-5'), '.tmp/run-5/map.json');
        assert.equal(runMapFile(root, 'run-5'), path.join(root, '.tmp', 'run-5', 'map.json'));
    } finally {
        await cleanup();
    }
});

test('the map searches by path, by content and by symbol', async () => {
    const { root, cleanup } = await workspace();
    try {
        const map = await buildRunMap({ root, workId: 'run-6' });
        const byPath = searchRunMap(map, { query: 'notes', scope: 'path' });
        assert.match(byPath.text, /notes\.md/);
        const byContent = searchRunMap(map, { query: 'lazy dog', scope: 'content' });
        assert.match(byContent.text, /notes\.md:2/);
        const bySymbol = searchRunMap(map, { query: 'greet', scope: 'symbol' });
        assert.match(bySymbol.text, /greet/);
    } finally {
        await cleanup();
    }
});

test('a file too long for the map is marked partial and falls back to the disk', async () => {
    const { root, cleanup } = await workspace();
    try {
        const long = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
        await writeFile(path.join(root, 'long.txt'), long, 'utf-8');
        const map = await buildRunMap({ root, workId: 'run-7', maxLines: 10 });
        assert.equal(map.files['long.txt'].partial, true);
        const found = searchRunMap(map, { query: 'line 49', scope: 'content' });
        assert.equal(found.count, 0);
        assert.ok(found.partial.includes('long.txt'));
    } finally {
        await cleanup();
    }
});

test('the map of a run lists the files of a directory', async () => {
    const { root, cleanup } = await workspace();
    try {
        const map = await buildRunMap({ root, workId: 'run-8' });
        assert.deepEqual(mapFiles(map, { dir: '.', depth: 1 }), ['notes.md']);
        assert.deepEqual(mapFiles(map, { dir: '.', depth: 2 }), ['notes.md', 'src/app.js']);
    } finally {
        await cleanup();
    }
});

test('the map of a run is written to the disk and read back', async () => {
    const { root, cleanup } = await workspace();
    try {
        const handle = await openRunMap({ root, workId: 'run-9' });
        assert.equal(handle.enabled, true);
        assert.ok(handle.files().includes('notes.md'));
        assert.match(handle.summary(), /notes\.md/);
        await handle.save();
        const back = await loadRunMap({ root, workId: 'run-9' });
        assert.ok(back.files['notes.md']);
    } finally {
        await cleanup();
    }
});

// --- the tools read through the map and the context -------------------------

test('the tools list, read and search through the map of the run', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-10' });
        const map = await openRunMap({ root, workId: 'run-10' });
        const toolset = createToolset({ root, config: { tools: {} }, context, map });

        const listed = await toolset.execute('list_files', { path: '.', depth: 2 });
        assert.match(listed, /notes\.md/);
        assert.match(listed, /src\/app\.js/);

        const read = await toolset.execute('read_file', { path: 'notes.md' });
        assert.match(read, /quick brown fox/);

        const found = await toolset.execute('search_files', { query: 'lazy dog', scope: 'content' });
        assert.match(found, /notes\.md:2/);

        const bySymbol = await toolset.execute('search_files', { query: 'greet', scope: 'symbol' });
        assert.match(bySymbol, /greet/);
    } finally {
        await cleanup();
    }
});

test('a file the run wrote lands in the map right away', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-11' });
        const map = await openRunMap({ root, workId: 'run-11' });
        const toolset = createToolset({ root, config: { tools: {} }, context, map, writeDirs: [root] });
        await toolset.execute('write_file', { path: 'fresh.md', content: 'brand new\n' });
        assert.ok(map.files().includes('fresh.md'));
        const read = await toolset.execute('read_file', { path: 'fresh.md' });
        assert.match(read, /brand new/);
    } finally {
        await cleanup();
    }
});

test('a missing picture is answered with the paths the run really has', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-12' });
        await context.references([{ rel: 'landing.png', kind: 'original' }]);
        const map = await openRunMap({ root, workId: 'run-12' });
        const toolset = createToolset({ root, config: { tools: {} }, context, map });

        const answer = await toolset.execute('view_image', { path: '.tmp/run-12/landing.png' });
        assert.match(answer, /no file/i);
        assert.match(answer, /landing\.png/);
        assert.doesNotMatch(answer, /Tool error/);
    } finally {
        await cleanup();
    }
});

test('the answer of the picture tools is remembered in the context', async () => {
    const { root, cleanup } = await workspace();
    try {
        const context = await openContext({ root, workId: 'run-13' });
        const map = await openRunMap({ root, workId: 'run-13' });
        const toolset = createToolset({ root, config: { tools: {} }, context, map });
        await toolset.execute('parse_color', { color: '#f1463f' });
        const entries = await context.journal({ kind: 'action' });
        assert.equal(entries.length, 1);
        assert.match(entries[0].text, /parse_color/);
    } finally {
        await cleanup();
    }
});

test('a file too long for the map is searched on the disk', async () => {
    const { root, cleanup } = await workspace();
    try {
        const long = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
        await writeFile(path.join(root, 'long.txt'), long, 'utf-8');
        const context = await openContext({ root, workId: 'run-14' });
        const map = await openRunMap({ root, workId: 'run-14', maxLines: 10 });
        const toolset = createToolset({ root, config: { tools: {} }, context, map });
        const found = await toolset.execute('search_files', { query: 'line 59', scope: 'content' });
        assert.match(found, /long\.txt/);
    } finally {
        await cleanup();
    }
});
