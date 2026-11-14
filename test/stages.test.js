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
import { runMeasureStage } from '../src/stages/measure.js';
import { runSegmentStage } from '../src/stages/segmentate.js';
import { runCropStage } from '../src/stages/cropper.js';
import { runRecognizeStage } from '../src/stages/recognize.js';
import { writeStageFile } from '../src/stages/artifacts.js';
import { splitReferences } from '../src/stages/references.js';
import { runDesignStage, shouldRunDesign, readDesignMd, clipMiddle } from '../src/stages/design.js';
import { runResolve, buildSheet, buildPalette, buildTokens, buildDesignMd, buildReport } from '../src/stages/resolve.js';
import { runSampleStage, mergeSampled, colorLines } from '../src/stages/sample.js';
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

/** A segmentation with three zones: an asset, a detail and a zone that is not cut. */
const SEGMENTATION = {
    summary: 'A small mockup.',
    source: 'picture.png',
    canvas: { x: 0, y: 0, width: 100, height: 80 },
    zones: [
        {
            name: 'badge', kind: 'image', box: { x: 10, y: 10, width: 20, height: 20 },
            role: 'card', use: 'artwork', crop: 'asset', hasText: false, notes: '',
        },
        {
            name: 'caption', kind: 'text', box: { x: 40, y: 10, width: 30, height: 10 },
            role: 'label', use: 'text block', crop: 'detail', hasText: true, notes: '',
        },
        {
            name: 'page', kind: 'background', box: { x: 0, y: 0, width: 100, height: 80 },
            role: 'page', use: '', crop: 'none', hasText: false, notes: '',
        },
    ],
    notes: '',
};

/** The geometry of one zone, in the shape the measurer answers in. */
const GEOMETRY = {
    summary: 'The geometry of the zones.',
    source: 'picture.png',
    unit: 'px',
    units: { source: 'px', rootFontSize: 16, scale: 1, preferred: ['rem', 'px'], notes: 'root 16px' },
    confidence: 'high',
    assumptions: [],
    elements: [{
        zone: 'badge',
        display: 'block',
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        gap: null,
        borders: 'a hairline border on every side, 1px',
        radius: 4,
        rotation: null,
        placement: 'grid column 2',
        css: 'padding: 0.5rem; border-radius: 0.25rem;',
        confidence: 'high',
        notes: '',
    }],
    rules: [{ name: 'space-2', value: 8, unit: 'px', css: '--space-2: 0.5rem', from: 'card padding' }],
    notes: '',
};

/** The texts of one zone, in the shape the recognizer answers in. */
const RECOGNITION = {
    summary: 'One caption.',
    texts: [{
        zone: 'caption',
        text: 'Award of the year',
        role: 'caption',
        family: 'Inter',
        familyConfidence: 'medium',
        fontSize: 14,
        weight: 400,
        lineHeight: 20,
        letterSpacing: 0,
        style: '',
        confidence: 'high',
        notes: '',
    }],
    notes: '',
};

/** The palette of the reference, in the shape the sampler answers in. */
const PALETTE = {
    summary: 'The colours of the picture.',
    colors: [{
        name: 'Paper',
        hex: '#f0f1f1',
        oklch: 'oklch(0.96 0.003 200)',
        hsl: 'hsl(180 2% 95%)',
        rgb: 'rgb(240 241 241)',
        luminance: 0.88,
        share: 1,
        method: 'sampled',
        zone: '',
        role: 'background',
        contrast: null,
        confidence: 'high',
        notes: '',
    }],
    background: '#f0f1f1',
    text: null,
    accent: null,
    colorSpace: { working: 'sRGB', encoding: 'sRGB', assumption: 'no ICC profile' },
    notes: '',
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
 *
 * The payload may be one answer, the answers of the calls in order, or a record of the role:
 * the key is a piece of the instructions of the role, the value is the answer of that role.
 * @param {object|object[]|Record<string, object>} payload the answer, or the answers of the calls in order
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
            const instructions = String(body?.instructions ?? '');
            let answer = answers[Math.min(calls.length - 1, answers.length - 1)];
            if (!Array.isArray(payload) && payload && typeof payload === 'object') {
                for (const [key, value] of Object.entries(payload)) {
                    if (instructions.includes(key)) {
                        answer = value;
                        break;
                    }
                }
            }
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
    config.agent.design = 'off';
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

test('the registry holds the stages of the pipeline', () => {
    assert.deepEqual([...STAGE_IDS], ['design', 'segmentate', 'crop', 'measure', 'recognize', 'sample', 'resolve']);
    assert.equal(stageById('measure').role, 'measurer');
    assert.equal(stageById('segmentate').role, 'segmentator');
    assert.equal(stageById('recognize').role, 'recognizer');
    assert.equal(stageById('sample').role, 'sampler');
    assert.equal(stageById('resolve').role, null);
    assert.equal(stageById('nothing'), null);
});

test('the geometry stage measures the zones of the segmentation', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeStageFile(outDir, 'segmentation', {
            generatedBy: 'ai-measure',
            stage: 'segmentate',
            sources: [{
                source: 'picture.png',
                canvas: { x: 0, y: 0, width: 100, height: 80 },
                scale: 1,
                zones: SEGMENTATION.zones,
            }],
        });
        const runner = fakeRunner(GEOMETRY);
        const result = await runMeasureStage({
            root,
            workId: 'w1',
            config: cloneDefaults(),
            runner,
            references: [{ kind: 'original', rel: 'picture.png' }],
            outDir,
        });
        assert.deepEqual(runner.roles, ['measurer']);
        assert.deepEqual(result.warnings, []);
        assert.equal(result.geometry.sources.length, 1);
        assert.equal(result.geometry.sources[0].elements.length, 1);
        const file = path.join(outDir, 'stages', 'geometry.json');
        assert.ok(await stat(file).then((info) => info.isFile()));
    } finally {
        await cleanup();
    }
});

test('the geometry stage without a segmentation says so', async () => {
    const { root, cleanup } = await workspace();
    try {
        const result = await runMeasureStage({
            root,
            workId: 'w1',
            config: cloneDefaults(),
            runner: fakeRunner(GEOMETRY),
            references: [{ kind: 'original', rel: 'picture.png' }],
            outDir: path.join(root, 'measurements'),
        });
        assert.equal(result.geometry, null);
        assert.match(result.warnings[0], /segmentate/i);
    } finally {
        await cleanup();
    }
});

test('the recognition stage reads the texts of the zones', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeStageFile(outDir, 'segmentation', {
            generatedBy: 'ai-measure',
            stage: 'segmentate',
            sources: [{
                source: 'picture.png',
                canvas: { x: 0, y: 0, width: 100, height: 80 },
                scale: 1,
                zones: SEGMENTATION.zones,
            }],
        });
        const runner = fakeRunner(RECOGNITION);
        const result = await runRecognizeStage({
            root,
            workId: 'w1',
            config: cloneDefaults(),
            runner,
            references: [{ kind: 'original', rel: 'picture.png' }],
            outDir,
        });
        assert.deepEqual(runner.roles, ['recognizer']);
        assert.equal(result.recognition.sources[0].texts.length, 1);
        assert.equal(result.recognition.sources[0].texts[0].zone, 'caption');
        const file = path.join(outDir, 'stages', 'recognition.json');
        assert.ok(await stat(file).then((info) => info.isFile()));
    } finally {
        await cleanup();
    }
});

test('the segmentation stage writes the zones of the reference', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        const runner = fakeRunner(SEGMENTATION);
        const result = await runSegmentStage({
            root,
            workId: 'w1',
            config: cloneDefaults(),
            runner,
            references: [{ kind: 'original', rel: 'picture.png' }],
            outDir,
        });
        assert.deepEqual(result.warnings, []);
        assert.equal(result.segmentation.sources.length, 1);
        assert.equal(result.segmentation.sources[0].zones.length, 3);
        const file = path.join(outDir, 'stages', 'segmentation.json');
        assert.ok(await stat(file).then((info) => info.isFile()));
        const written = JSON.parse(await readFile(file, 'utf-8'));
        assert.equal(written.stage, 'segmentate');
        assert.equal(written.sources[0].source, 'picture.png');
    } finally {
        await cleanup();
    }
});

test('the crop stage cuts the fragments the segmentation named', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeStageFile(outDir, 'segmentation', {
            generatedBy: 'ai-measure',
            stage: 'segmentate',
            sources: [{
                source: 'picture.png',
                canvas: { x: 0, y: 0, width: 100, height: 80 },
                scale: 1,
                zones: SEGMENTATION.zones,
            }],
        });
        const runner = fakeRunner(null);
        const result = await runCropStage({
            root,
            workId: 'w1',
            config: cloneDefaults(),
            runner,
            references: [{ kind: 'original', rel: 'picture.png' }],
            outDir,
        });
        // The zone that is marked "none" is not cut.
        assert.equal(result.crops.length, 2);
        assert.equal(result.crops[0].crop, 'crops/01-asset-badge.png');
        assert.equal(result.crops[1].crop, 'crops/02-detail-caption.png');
        assert.ok(await stat(path.join(outDir, 'crops', '01-asset-badge.png')).then((info) => info.isFile()));
        const written = JSON.parse(await readFile(path.join(outDir, 'stages', 'crops.json'), 'utf-8'));
        assert.equal(written.crops.length, 2);
    } finally {
        await cleanup();
    }
});

test('the crop stage without a segmentation says so', async () => {
    const { root, cleanup } = await workspace();
    try {
        const result = await runCropStage({
            root,
            workId: 'w1',
            config: cloneDefaults(),
            runner: fakeRunner(null),
            references: [{ kind: 'original', rel: 'picture.png' }],
            outDir: path.join(root, 'measurements'),
        });
        assert.equal(result.crops.length, 0);
        assert.match(result.warnings[0], /segmentate/i);
    } finally {
        await cleanup();
    }
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

/**
 * Write the files of the stages into the output directory.
 * @param {string} outDir the output directory
 * @param {object[]} [crops] the fragments of the crop stage
 * @returns {Promise<void>}
 */
async function writeParts(outDir, crops = []) {
    await writeStageFile(outDir, 'segmentation', {
        generatedBy: 'ai-measure',
        stage: 'segmentate',
        sources: [{
            source: 'picture.png',
            summary: 'A small mockup.',
            canvas: { x: 0, y: 0, width: 100, height: 80 },
            scale: 1,
            zones: SEGMENTATION.zones,
        }],
    });
    await writeStageFile(outDir, 'geometry', {
        generatedBy: 'ai-measure',
        stage: 'measure',
        sources: [{
            source: 'picture.png',
            summary: GEOMETRY.summary,
            unit: GEOMETRY.unit,
            units: GEOMETRY.units,
            confidence: GEOMETRY.confidence,
            assumptions: GEOMETRY.assumptions,
            elements: GEOMETRY.elements,
            rules: GEOMETRY.rules,
            notes: GEOMETRY.notes,
        }],
    });
    await writeStageFile(outDir, 'recognition', {
        generatedBy: 'ai-measure',
        stage: 'recognize',
        sources: [{
            source: 'picture.png',
            summary: RECOGNITION.summary,
            texts: RECOGNITION.texts,
            notes: RECOGNITION.notes,
        }],
    });
    await writeStageFile(outDir, 'palette', {
        generatedBy: 'ai-measure',
        stage: 'sample',
        mode: 'local',
        summary: 'The colours of the picture.',
        colors: [{
            name: 'Ink', hex: '#1c1c1b', oklch: 'oklch(0.23 0.002 108)', hsl: 'hsl(60 2% 11%)',
            rgb: 'rgb(28 28 27)', luminance: 0.01, share: 0.28, method: 'sampled',
            zone: 'badge', role: 'fill', contrast: null, confidence: 'high', notes: '',
        }],
        background: '#f0f1f1',
        text: '#1c1c1b',
        accent: null,
        colorSpace: { working: 'sRGB', encoding: 'sRGB', assumption: 'no ICC profile' },
        notes: '',
        samples: [{
            hex: '#1c1c1b', rgb: 'rgb(28 28 27)', hsl: 'hsl(60 2% 11%)', oklch: 'oklch(0.23 0.002 108)',
            luminance: 0.01, share: 0.28, source: 'picture.png', zone: 'badge', method: 'sampled',
            confidence: 'high', notes: '',
        }],
    });
    if (crops.length) {
        await writeStageFile(outDir, 'crops', {
            generatedBy: 'ai-measure',
            stage: 'crop',
            mode: 'local',
            crops,
        });
    }
}

test('the resolve stage writes the five artifacts', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeParts(outDir, [{
            kind: 'asset', name: 'badge', crop: 'crops/01-asset-badge.png',
            box: { x: 10, y: 10, width: 20, height: 20 }, source: 'picture.png',
        }]);
        const state = {
            root,
            config: { output: { dir: './measurements' } },
            outDir,
            warnings: [],
        };
        await runResolve(state, () => {});
        for (const name of ['measurements.json', 'palette.json', 'tokens.css', 'DESIGN.md', 'report.md']) {
            assert.ok(await stat(path.join(outDir, name)).then((info) => info.isFile()), `${name} is missing`);
        }
        const measurements = JSON.parse(await readFile(path.join(outDir, 'measurements.json'), 'utf-8'));
        assert.equal(measurements.generatedBy, 'ai-measure');
        // Every zone of the segmentation is an element of the sheet.
        assert.equal(measurements.elements.length, 3);
        assert.equal(measurements.regions.length, 1);
        assert.equal(measurements.rules.length, 1);
        const css = await readFile(path.join(outDir, 'tokens.css'), 'utf-8');
        assert.match(css, /--color-ink: #1c1c1b;/);
        assert.match(css, /--space-2: 0\.5rem;/);
        const report = await readFile(path.join(outDir, 'report.md'), 'utf-8');
        assert.match(report, /# Measurement report/);
    } finally {
        await cleanup();
    }
});

test('the elements carry the numbers of the geometry and the texts of the recognition', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeParts(outDir);
        const state = { root, config: { output: { dir: './measurements' } }, outDir, warnings: [] };
        await runResolve(state, () => {});
        const measurements = JSON.parse(await readFile(path.join(outDir, 'measurements.json'), 'utf-8'));
        const badge = measurements.elements.find((item) => item.name === 'badge');
        const caption = measurements.elements.find((item) => item.name === 'caption');
        assert.equal(badge.padding.top, 8);
        assert.equal(badge.radius, 4);
        assert.equal(badge.box.width, 20);
        assert.equal(badge.confidence, 'high');
        assert.equal(caption.typography.family, 'Inter');
        assert.equal(caption.typography.fontSize, 14);
        // The colour of the zone is attached to the zone it was read from.
        assert.equal(badge.colors[0].hex, '#1c1c1b');
        assert.equal(caption.colors.length, 0);
    } finally {
        await cleanup();
    }
});

test('the crops travel with the artifacts', async () => {
    const { root, cleanup } = await workspace();
    try {
        // A crop in the work directory, as an older run leaves it.
        const work = path.join(root, '.tmp', 'w1', 'crops');
        await mkdir(work, { recursive: true });
        await writeFile(path.join(work, '01-asset-badge.png'), 'PNG');
        const outDir = path.join(root, 'measurements');
        await writeParts(outDir, [{
            kind: 'asset', name: 'badge', crop: '.tmp/w1/crops/01-asset-badge.png',
            box: { x: 10, y: 10, width: 20, height: 20 }, source: 'picture.png',
        }]);
        const state = { root, config: { output: { dir: './measurements' } }, outDir, warnings: [] };
        await runResolve(state, () => {});
        const copy = path.join(outDir, 'crops', '01-asset-badge.png');
        assert.ok(await stat(copy).then((info) => info.isFile()), 'the crop is not in the output');
        const measurements = JSON.parse(await readFile(path.join(outDir, 'measurements.json'), 'utf-8'));
        assert.equal(measurements.crops[0].crop, 'crops/01-asset-badge.png');
        assert.equal(measurements.regions[0].crop, 'crops/01-asset-badge.png');
        assert.doesNotMatch(JSON.stringify(measurements), /\.tmp\/w1/);
        const report = await readFile(path.join(outDir, 'report.md'), 'utf-8');
        assert.match(report, /crops\/01-asset-badge\.png/);
        assert.doesNotMatch(report, /\.tmp\/w1/);
    } finally {
        await cleanup();
    }
});

test('a crop that is not there keeps its old path', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeParts(outDir, [{
            kind: 'asset', name: 'badge', crop: '.tmp/w1/crops/gone.png',
            box: { x: 10, y: 10, width: 20, height: 20 }, source: 'picture.png',
        }]);
        const state = { root, config: { output: { dir: './measurements' } }, outDir, warnings: [] };
        await runResolve(state, () => {});
        const measurements = JSON.parse(await readFile(path.join(root, 'measurements', 'measurements.json'), 'utf-8'));
        assert.equal(measurements.crops[0].crop, '.tmp/w1/crops/gone.png');
        assert.ok(state.warnings.length >= 1);
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

test('the sample stage reads the colours from the pixels and lets the model name them', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeStageFile(outDir, 'segmentation', {
            generatedBy: 'ai-measure',
            stage: 'segmentate',
            sources: [{
                source: 'picture.png',
                summary: 'A small mockup.',
                canvas: { x: 0, y: 0, width: 100, height: 80 },
                scale: 1,
                zones: SEGMENTATION.zones,
            }],
        });
        const seen = [];
        const runner = {
            run: async (role, params) => {
                seen.push({ role, params });
                return {
                    status: 'completed',
                    data: PALETTE,
                    text: '',
                    toolCalls: [],
                    usage: null,
                    error: null,
                };
            },
        };
        const config = cloneDefaults();
        config.stages.sample.mode = 'local';
        const result = await runSampleStage({
            root,
            workId: 'w1',
            config,
            runner,
            references: [{ rel: 'picture.png', kind: 'image' }],
            outDir,
        });
        assert.deepEqual(result.warnings, []);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].role, 'sampler');
        // The model sees no picture in the local mode: it only names the colours it was given.
        assert.deepEqual(seen[0].params.parts, []);
        assert.match(seen[0].params.text, /#f0f1f1/);
        // The file of the stage holds the colours.
        const written = JSON.parse(await readFile(path.join(outDir, 'stages', 'palette.json'), 'utf-8'));
        assert.equal(written.stage, 'sample');
        assert.equal(written.mode, 'local');
        assert.ok(written.colors.length >= 1);
        assert.ok(written.samples.length >= 1);
        // The colours of the pixels are in the palette even when the model names nothing.
        assert.ok(written.colors.every((item) => typeof item.hex === 'string' && item.hex.length > 0));
    } finally {
        await cleanup();
    }
});

test('the sample stage falls back to the colours of the pixels when the model names none', async () => {
    const { root, cleanup } = await workspace();
    try {
        const outDir = path.join(root, 'measurements');
        await writeStageFile(outDir, 'segmentation', {
            generatedBy: 'ai-measure',
            stage: 'segmentate',
            sources: [{
                source: 'picture.png',
                canvas: { x: 0, y: 0, width: 100, height: 80 },
                scale: 1,
                zones: [],
            }],
        });
        const runner = {
            run: async () => ({
                status: 'completed', data: { summary: '', colors: [] }, text: '',
                toolCalls: [], usage: null, error: null,
            }),
        };
        const config = cloneDefaults();
        config.stages.sample.mode = 'local';
        const result = await runSampleStage({
            root, workId: 'w1', config, runner,
            references: [{ rel: 'picture.png', kind: 'image' }],
            outDir,
        });
        assert.ok(result.palette.colors.length >= 1);
        assert.equal(result.palette.colors[0].method, 'sampled');
    } finally {
        await cleanup();
    }
});

test('the colours of the pixels are put back into the colours the model named', () => {
    const samples = [{
        hex: '#1c1c1b', rgb: 'rgb(28 28 27)', hsl: 'hsl(60 2% 11%)',
        oklch: 'oklch(0.23 0.002 108)', luminance: 0.01, share: 0.28,
        source: 'picture.png', zone: 'badge', method: 'sampled', confidence: 'high', notes: '',
    }];
    const named = [{
        name: 'Ink', hex: '#1c1c1b', oklch: '', hsl: '', rgb: '', luminance: null,
        share: null, method: 'perceived', zone: '', role: 'text', contrast: null,
        confidence: 'medium', notes: '',
    }];
    const merged = mergeSampled(named, samples);
    assert.equal(merged[0].oklch, 'oklch(0.23 0.002 108)');
    assert.equal(merged[0].share, 0.28);
    assert.equal(merged[0].zone, 'badge');
    assert.equal(merged[0].method, 'sampled');
    assert.equal(merged[0].confidence, 'high');
    // A colour the model invented keeps its own numbers and stays perceived.
    const invented = mergeSampled([{ name: 'Glow', hex: '#ff00aa', method: '', confidence: '' }], samples);
    assert.equal(invented[0].method, 'perceived');
    assert.equal(invented[0].confidence, 'medium');
});

test('the sampled colours are written as a list the model can read', () => {
    const text = colorLines([{ hex: '#1c1c1b', zone: 'badge', rgb: 'rgb(28 28 27)', oklch: 'oklch(0.23 0.002 108)', share: 0.28 }]);
    assert.match(text, /- #1c1c1b/);
    assert.match(text, /zone: badge/);
    assert.match(text, /share: 28%/);
});

test('the sheet joins the zones, the numbers, the texts and the colours', () => {
    const sheet = buildSheet({
        segmentation: {
            sources: [{
                source: 'picture.png',
                summary: 'A small mockup.',
                canvas: { x: 0, y: 0, width: 100, height: 80 },
                zones: SEGMENTATION.zones,
            }],
        },
        geometry: {
            sources: [{
                source: 'picture.png',
                unit: 'px',
                confidence: 'high',
                assumptions: ['The picture is a screenshot.'],
                elements: GEOMETRY.elements,
                rules: GEOMETRY.rules,
            }],
        },
        recognition: {
            sources: [{ source: 'picture.png', texts: RECOGNITION.texts }],
        },
        palette: {
            colors: [{ name: 'Ink', hex: '#1c1c1b', oklch: 'oklch(0.23 0.002 108)', method: 'sampled', confidence: 'high' }],
            background: '#f0f1f1',
            samples: [{ hex: '#1c1c1b', zone: 'badge', role: 'fill' }],
        },
        crops: [{ kind: 'asset', name: 'badge', crop: 'crops/01-asset-badge.png' }],
    });
    assert.equal(sheet.elements.length, 3);
    const badge = sheet.elements.find((item) => item.name === 'badge');
    assert.equal(badge.padding.top, 8);
    assert.equal(badge.colors[0].hex, '#1c1c1b');
    assert.equal(sheet.regions.length, 1);
    assert.equal(sheet.regions[0].crop, 'crops/01-asset-badge.png');
    assert.equal(sheet.rules.length, 1);
    assert.equal(sheet.confidence, 'high');
});

test('the pipeline writes the artifacts and the crops of a real run', async () => {
    const host = await mockHost({
        'You are the segmentator': SEGMENTATION,
        'You are the measurer': GEOMETRY,
        'You are the recognizer': RECOGNITION,
        'You are the sampler': PALETTE,
    });
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
        // The fragments are cut into the output directory.
        const crops = await stat(path.join(root, 'measurements', 'crops')).then((info) => info.isDirectory());
        assert.ok(crops);
        // The segmentation of the reference is written into the output directory.
        const segmentation = JSON.parse(await readFile(path.join(root, 'measurements', 'stages', 'segmentation.json'), 'utf-8'));
        assert.equal(segmentation.stage, 'segmentate');
        assert.equal(segmentation.sources[0].source, 'picture.png');
        // The geometry and the texts are written next to it.
        assert.ok(await stat(path.join(root, 'measurements', 'stages', 'geometry.json')).then((info) => info.isFile()));
        assert.ok(await stat(path.join(root, 'measurements', 'stages', 'recognition.json')).then((info) => info.isFile()));
        // The palette is read from the pixels and written next to the other parts.
        assert.ok(await stat(path.join(root, 'measurements', 'stages', 'palette.json')).then((info) => info.isFile()));
        // The host was asked eight times over the Responses route: every role explores with the
        // tools, and answers in the second call under the schema.
        assert.equal(host.calls.length, 8);
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
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['segmentate', 'crop', 'measure', 'recognize', 'sample', 'resolve']);
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
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['segmentate', 'crop', 'recognize', 'sample', 'resolve']);
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
