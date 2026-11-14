/**
 * @file test/stages.test.js
 * @purpose Tests of the stages: the crops, the measurement passes, the design direction, the
 *          artifacts of the resolve stage and the pipeline that ties them together.
 *
 * The pipeline runs against a local mock host: a `node:http` server on 127.0.0.1 that answers
 * the `/responses` route with a measurement sheet, so the whole path — client, role runner,
 * stages, files — is exercised without the network.
 *
 * @depends node:test, node:http, stages/*, shared/pipeline, openai/client
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import sharp from 'sharp';

import { runPipeline } from '../src/shared/pipeline.js';
import { createClient } from '../src/openai/client.js';
import { cloneDefaults } from '../src/config/defaults.js';
import { stageMeasurementCrops, measurementConclusion } from '../src/stages/crop.js';
import { runMeasureStage, shouldMeasure, splitReferences } from '../src/stages/measure.js';
import { runDesignStage, shouldRunDesign, readDesignMd, clipMiddle } from '../src/stages/design.js';
import { runResolve, buildPalette, buildTokens, buildDesignMd, buildReport } from '../src/stages/resolve.js';
import { STAGE_IDS, stageById } from '../src/stages/index.js';

/** A measurement sheet with one element, one region and one repeated measure. */
const SHEET = {
    summary: 'A small mockup.',
    source: 'picture.png',
    unit: 'px',
    units: { source: 'px', rootFontSize: 16, scale: 1, preferred: ['rem', 'px'], notes: 'root 16px' },
    confidence: 'high',
    assumptions: ['The picture is a screenshot of a 1024×768 screen.'],
    notes: 'One detail needs a fragment.',
    colors: {
        palette: [{
            name: 'Ink', hex: '#1c1c1b', oklch: 'oklch(0.23 0.002 108)', hsl: 'hsl(60 2% 11%)',
            rgb: 'rgb(28 28 27)', luminance: 0.01, share: 0.28, method: 'sampled',
            confidence: 'high', source: null, notes: '',
        }],
        background: '#f0f1f1',
        text: '#1c1c1b',
        accent: null,
        colorSpace: { working: 'sRGB', encoding: 'sRGB', assumption: 'no ICC profile' },
        notes: '',
    },
    canvas: { x: 0, y: 0, width: 100, height: 80 },
    elements: [{
        name: 'Header', kind: 'text',
        box: { x: 0, y: 0, width: 100, height: 20 },
        rotation: null, borders: '', radius: null,
        padding: { top: null, right: null, bottom: null, left: null },
        margin: { top: null, right: null, bottom: null, left: null },
        gap: null, spacing: '', placement: '', css: 'height: 1.25rem',
        typography: {
            role: 'heading', family: 'Inter', familyConfidence: 'low',
            fontSize: 20, weight: 700, lineHeight: 20, letterSpacing: 0, style: '',
        },
        confidence: 'high', colors: [], source: 'picture.png', notes: '', use: 'header', crop: null,
    }],
    regions: [{
        name: 'Logo', kind: 'logo', box: { x: 10, y: 10, width: 20, height: 20 },
        how: 'cut', use: 'logo', source: 'picture.png', crop: null,
    }],
    rules: [{ name: 'space-2', value: 8, unit: 'px', css: '--space-2: 0.5rem', from: 'card padding' }],
};

/** A design direction in the shape the designer answers in. */
const DESIGN = {
    summary: 'A quiet landing page.',
    layout: { summary: 'One column with a hero.', structure: [] },
    typography: {
        family: 'Inter', headingFamily: null, scale: '1.25', weights: ['400', '700'],
        cssFamily: 'Inter, sans-serif',
    },
    color: { palette: { name: 'Quiet', colors: [] }, gradients: [] },
    spacing: { scale: [4, 8], rules: [] },
    assets: { generated: [], external: [] },
    template: { path: '.tmp/w1/design-template.html', description: 'the skeleton' },
    designMd: { read: true, tokens: ['--brand'], conflicts: [] },
    notes: [],
};

/**
 * A working directory with a picture and, optionally, a DESIGN.md.
 * @param {{ designMd?: string|null }} options
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function workspace({ designMd = null } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-stages-'));
    await sharp({
        create: { width: 100, height: 80, channels: 4, background: { r: 240, g: 241, b: 241, alpha: 1 } },
    }).png().toFile(path.join(root, 'picture.png'));
    if (designMd !== null) await writeFile(path.join(root, 'DESIGN.md'), designMd, 'utf-8');
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * A mock host that answers the Responses route.
 * @param {object|object[]} payload the answer, or the answers of the calls in order
 * @returns {Promise<{ baseURL: string, calls: object[], close: () => Promise<void> }>}
 */
async function mockHost(payload) {
    const answers = Array.isArray(payload) ? payload : [payload];
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { body = null; }
            calls.push({ url: req.url, method: req.method, body });
            const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
            const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: `resp_${calls.length}`,
                status: 'completed',
                model: body?.model ?? 'mock/model',
                output_text: text,
                output: [],
                usage: { input_tokens: 100, output_tokens: 200 },
            }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        baseURL: `http://127.0.0.1:${port}/v1`,
        calls,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/**
 * A config that points at the mock host and keeps the design stage out of the way.
 * @param {string} baseURL
 * @returns {object}
 */
function configFor(baseURL) {
    const config = cloneDefaults();
    config.model = 'mock/model';
    config.baseURL = baseURL;
    config.apiKey = 'mock-key';
    config.backends = [{ baseURL, apiKey: 'mock-key' }];
    config.agent.measure = 'always';
    config.agent.design = 'off';
    config.agent.measurerPasses = 1;
    config.output.dir = './measurements';
    return config;
}

/**
 * A runner that answers with a fixed sheet and counts the calls.
 * @param {object} sheet
 * @returns {{ run: Function, roles: string[] }}
 */
function fakeRunner(sheet) {
    const roles = [];
    return {
        roles,
        run: async (role, params) => {
            roles.push(role);
            return { status: 'completed', data: sheet, text: '', toolCalls: [], usage: null, error: null };
        },
    };
}

test('the registry holds the three stages of the pipeline', () => {
    assert.deepEqual([...STAGE_IDS], ['design', 'measure', 'resolve']);
    assert.equal(stageById('measure').role, 'measurer');
    assert.equal(stageById('resolve').role, null);
    assert.equal(stageById('nothing'), null);
});

test('the crops are cut once per box and the duplicates share a file', async () => {
    const { root, cleanup } = await workspace();
    try {
        const sheet = structuredClone(SHEET);
        sheet.elements.push({ ...structuredClone(SHEET.elements[0]), name: 'Header copy' });
        const staged = await stageMeasurementCrops({
            root,
            workId: 'w1',
            sheet,
            references: [{ kind: 'original', rel: 'picture.png' }],
            measureSource: 'original',
        });
        assert.equal(staged.crops.length, 2);
        const files = staged.crops.map((item) => item.crop);
        assert.equal(new Set(files).size, 2);
        // The second element with the same box points at the file of the first one.
        assert.equal(sheet.elements[1].crop, sheet.elements[0].crop);
        for (const file of files) {
            assert.ok(await stat(path.join(root, file)).then((info) => info.isFile()));
        }
    } finally {
        await cleanup();
    }
});

test('a box outside the picture is clamped to its frame', async () => {
    const { root, cleanup } = await workspace();
    try {
        const sheet = structuredClone(SHEET);
        sheet.elements[0].box = { x: 90, y: 70, width: 40, height: 40 };
        const staged = await stageMeasurementCrops({
            root,
            workId: 'w1',
            sheet,
            references: [{ kind: 'original', rel: 'picture.png' }],
            measureSource: 'original',
        });
        const box = staged.crops.find((item) => item.kind === 'element').box;
        assert.equal(box.x, 90);
        assert.equal(box.y, 70);
        assert.equal(box.width, 10);
        assert.equal(box.height, 10);
    } finally {
        await cleanup();
    }
});

test('the number of crops is capped and the cap is reported', async () => {
    const { root, cleanup } = await workspace();
    try {
        const sheet = structuredClone(SHEET);
        sheet.elements = [
            { ...structuredClone(SHEET.elements[0]), name: 'A', box: { x: 0, y: 0, width: 10, height: 10 } },
            { ...structuredClone(SHEET.elements[0]), name: 'B', box: { x: 20, y: 0, width: 10, height: 10 } },
            { ...structuredClone(SHEET.elements[0]), name: 'C', box: { x: 40, y: 0, width: 10, height: 10 } },
        ];
        const staged = await stageMeasurementCrops({
            root,
            workId: 'w1',
            sheet,
            references: [{ kind: 'original', rel: 'picture.png' }],
            measureSource: 'original',
            maxCrops: 2,
        });
        assert.equal(staged.crops.length, 2);
        assert.ok(staged.warnings.some((item) => /limited to 2/.test(item)));
    } finally {
        await cleanup();
    }
});

test('the conclusion counts the elements, the regions and the crops', () => {
    const conclusion = measurementConclusion(SHEET, [{ kind: 'element', name: 'Header', crop: '.tmp/w1/crops/01.png', bytes: 10 }]);
    assert.equal(conclusion.counts.elements, 1);
    assert.equal(conclusion.counts.regions, 1);
    assert.equal(conclusion.counts.rules, 1);
    assert.equal(conclusion.counts.crops, 1);
    assert.equal(conclusion.source, 'picture.png');
});

test('the measurement stage runs one pass when one is configured', async () => {
    const { root, cleanup } = await workspace();
    try {
        const runner = fakeRunner(SHEET);
        const result = await runMeasureStage({
            root,
            workId: 'w1',
            config: { agent: { measurerPasses: 1, measurerMaxTurns: 4 }, stages: { crop: { autoCrops: true } } },
            runner,
            references: [{ kind: 'original', rel: 'picture.png' }],
        });
        assert.equal(result.passes, 1);
        assert.deepEqual(runner.roles, ['measurer']);
        assert.ok(result.sheet);
        assert.equal(result.crops.length, 2);
    } finally {
        await cleanup();
    }
});

test('the measurement stage runs the fragment pass over the crops', async () => {
    const { root, cleanup } = await workspace();
    try {
        const runner = fakeRunner(SHEET);
        const result = await runMeasureStage({
            root,
            workId: 'w1',
            config: { agent: { measurerPasses: 2, measurerMaxTurns: 8 }, stages: { crop: { autoCrops: true } } },
            runner,
            references: [{ kind: 'original', rel: 'picture.png' }],
        });
        assert.equal(result.passes, 2);
        assert.deepEqual(runner.roles, ['measurer', 'measurerFragment']);
        assert.ok(result.crops.length > 0);
    } finally {
        await cleanup();
    }
});

test('the measurement stage without a reference says so', async () => {
    const { root, cleanup } = await workspace();
    try {
        const runner = fakeRunner(SHEET);
        const result = await runMeasureStage({ root, workId: 'w1', config: {}, runner, references: [] });
        assert.equal(result.sheet, null);
        assert.equal(result.passes, 0);
        assert.match(result.warnings[0], /no reference/i);
    } finally {
        await cleanup();
    }
});

test('the measurement mode decides whether the stage runs', () => {
    assert.equal(shouldMeasure({ agent: { measure: 'off' } }, { hasReferences: true }), false);
    assert.equal(shouldMeasure({ agent: { measure: 'always' } }, { hasReferences: false }), true);
    assert.equal(shouldMeasure({ agent: { measure: 'auto' } }, { hasReferences: true }), true);
    assert.equal(shouldMeasure({ agent: { measure: 'auto' } }, { hasReferences: false }), false);
});

test('the sub-references come first and the originals they cover stay out of the context', () => {
    const { attached, context } = splitReferences([
        { kind: 'original', rel: 'shot.png' },
        { kind: 'subref', rel: 'shot-1.png', source: 'shot.png' },
    ]);
    assert.equal(attached.length, 1);
    assert.equal(attached[0].rel, 'shot-1.png');
    assert.equal(context.length, 1);
});

test('the design stage reads the DESIGN.md and saves the direction', async () => {
    const { root, cleanup } = await workspace({ designMd: '# Tokens\n\n--brand: #ff0000\n' });
    try {
        const runner = fakeRunner(DESIGN);
        const result = await runDesignStage({
            root,
            workId: 'w1',
            config: { agent: { designerMaxTurns: 16 }, stages: { design: { maxTurns: 16 } } },
            runner,
            references: [],
            task: 'a landing page',
        });
        assert.ok(result.design);
        assert.equal(result.saved, '.tmp/w1/design.json');
        const saved = JSON.parse(await readFile(path.join(root, '.tmp', 'w1', 'design.json'), 'utf-8'));
        assert.equal(saved.summary, DESIGN.summary);
        assert.equal(saved.designMd.read, true);
    } finally {
        await cleanup();
    }
});

test('the design stage notes that there is no DESIGN.md', async () => {
    const { root, cleanup } = await workspace();
    try {
        assert.equal(await readDesignMd(root), '');
        const runner = fakeRunner(DESIGN);
        const result = await runDesignStage({
            root,
            workId: 'w1',
            config: { agent: { designerMaxTurns: 16 } },
            runner,
            references: [],
        });
        assert.ok(result.design);
        assert.equal(result.warnings.length, 0);
    } finally {
        await cleanup();
    }
});

test('the design mode decides when the stage runs', () => {
    assert.equal(shouldRunDesign({ agent: { design: 'off' } }, { task: 'design a page' }), false);
    assert.equal(shouldRunDesign({ agent: { design: 'always' } }, {}), true);
    assert.equal(shouldRunDesign({ agent: { design: 'auto' } }, { hasDesignMd: true }), true);
    assert.equal(shouldRunDesign({ agent: { design: 'auto' } }, { hasReferences: true }), true);
    assert.equal(shouldRunDesign({ agent: { design: 'auto' } }, { task: 'make a mockup' }), true);
    assert.equal(shouldRunDesign({ agent: { design: 'auto' } }, { task: 'count the files' }), false);
});

test('a long DESIGN.md keeps its head and its tail', () => {
    const clipped = clipMiddle('a'.repeat(5000) + 'TAIL', 2000);
    assert.ok(clipped.length < 5000);
    assert.ok(clipped.includes('TAIL'));
    assert.match(clipped, /clipped/);
});

test('the resolve stage writes the five artifacts', async () => {
    const { root, cleanup } = await workspace();
    try {
        const state = {
            root,
            config: { output: { dir: './measurements' } },
            sheet: SHEET,
            crops: [{ kind: 'element', name: 'Header', crop: '.tmp/w1/crops/01-element-header.png', box: { x: 0, y: 0, width: 100, height: 20 } }],
            conclusion: measurementConclusion(SHEET, []),
            warnings: [],
        };
        await runResolve(state, () => {});
        const dir = path.join(root, 'measurements');
        for (const name of ['measurements.json', 'palette.json', 'tokens.css', 'DESIGN.md', 'report.md']) {
            assert.ok(await stat(path.join(dir, name)).then((info) => info.isFile()), `${name} is missing`);
        }
        const measurements = JSON.parse(await readFile(path.join(dir, 'measurements.json'), 'utf-8'));
        assert.equal(measurements.generatedBy, 'ai-measure');
        assert.equal(measurements.crops.length, 1);
        const css = await readFile(path.join(dir, 'tokens.css'), 'utf-8');
        assert.match(css, /--color-ink: #1c1c1b;/);
        assert.match(css, /--space-2: 0\.5rem;/);
        const report = await readFile(path.join(dir, 'report.md'), 'utf-8');
        assert.match(report, /# Measurement report/);
    } finally {
        await cleanup();
    }
});

test('the palette holds the colours of the sheet with their tokens', () => {
    const palette = buildPalette(SHEET);
    assert.equal(palette.colors.length, 1);
    assert.equal(palette.colors[0].token, '--color-ink');
    assert.equal(palette.background, '#f0f1f1');
});

test('the tokens of a sheet with no colours are empty but valid', () => {
    const { css, tokens } = buildTokens({ colors: { palette: [] }, rules: [] });
    assert.deepEqual(tokens, []);
    assert.match(css, /:root \{/);
});

test('the design document and the report name the source', () => {
    assert.match(buildDesignMd(SHEET), /Measured from `picture\.png`/);
    assert.match(buildReport(SHEET, { crops: [] }), /\*\*Source:\*\* picture\.png/);
});

test('the pipeline writes the artifacts and the crops of a real run', async () => {
    const host = await mockHost(SHEET);
    const { root, cleanup } = await workspace();
    try {
        const config = configFor(host.baseURL);
        const client = await createClient({ config, env: {} });
        const events = [];
        const result = await runPipeline({
            root,
            images: ['picture.png'],
            config,
            client,
            task: 'measure this',
            notify: (event) => events.push(event),
        });
        client.close();

        assert.equal(result.failed, false);
        assert.deepEqual(result.warnings, []);
        assert.equal(result.artifacts.length, 5);
        for (const file of result.artifacts) {
            assert.ok(await stat(path.join(root, file)).then((info) => info.isFile()), `${file} is missing`);
        }
        // The crops are cut into the work directory.
        const crops = await stat(path.join(root, '.tmp', result.workId, 'crops')).then((info) => info.isDirectory());
        assert.ok(crops);
        // The host was asked twice over the Responses route: the model explores with the
        // tools, and answers in the second call under the schema.
        assert.equal(host.calls.length, 2);
        assert.match(host.calls[0].url, /\/v1\/responses$/);
        assert.ok(host.calls[0].body.input_text === undefined);
        assert.ok(host.calls[0].body.text === undefined, 'the first call carries no schema');
        assert.equal(host.calls[1].body.text?.format?.type, 'json_schema');
        assert.ok(events.some((event) => event.type === 'resolve.done'));
    } finally {
        await cleanup();
        await host.close();
    }
});

test('the pipeline answers with the plan when it is a dry run', async () => {
    const host = await mockHost(SHEET);
    const { root, cleanup } = await workspace();
    try {
        const config = configFor(host.baseURL);
        const client = await createClient({ config, env: {} });
        const events = [];
        const result = await runPipeline({
            root,
            images: ['picture.png'],
            config,
            client,
            dryRun: true,
            notify: (event) => events.push(event),
        });
        client.close();

        assert.equal(result.failed, false);
        assert.equal(result.artifacts.length, 0);
        assert.equal(host.calls.length, 0);
        const plan = events.find((event) => event.type === 'plan');
        assert.ok(plan);
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['measure', 'resolve']);
        assert.match(plan.outputs[0], /measurements\.json$/);
    } finally {
        await cleanup();
        await host.close();
    }
});

test('the pipeline reports the stages that are switched off', async () => {
    const host = await mockHost(SHEET);
    const { root, cleanup } = await workspace();
    try {
        const config = configFor(host.baseURL);
        config.stages.measure.enabled = false;
        const client = await createClient({ config, env: {} });
        const events = [];
        await runPipeline({
            root,
            images: ['picture.png'],
            config,
            client,
            dryRun: true,
            notify: (event) => events.push(event),
        });
        client.close();
        const plan = events.find((event) => event.type === 'plan');
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['resolve']);
    } finally {
        await cleanup();
        await host.close();
    }
});

test('a stage that throws does not stop the pipeline', async () => {
    const { root, cleanup } = await workspace();
    try {
        const state = {
            root,
            workId: 'w1',
            warnings: [],
            artifacts: [],
        };
        const stages = [
            { id: 'broken', label: 'Broken', run: () => { throw new Error('the stage is broken'); } },
            { id: 'next', label: 'Next', run: (current) => { current.artifacts.push('next.txt'); } },
        ];
        const { runStages } = await import('../src/shared/pipeline.js');
        const failed = await runStages(stages, state, () => {});
        assert.equal(failed, true);
        assert.deepEqual(state.artifacts, ['next.txt']);
        assert.match(state.warnings[0], /the stage is broken/);
    } finally {
        await cleanup();
    }
});
