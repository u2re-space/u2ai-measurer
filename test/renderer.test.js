/**
 * @file test/renderer.test.js
 * @purpose Tests of the renderer: what the reader sees of a run.
 * @depends node:test, cli/renderer
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlainRenderer } from '../src/cli/renderer.js';

/**
 * Send the events to the renderer and collect what it printed.
 * @param {object[]} events
 * @returns {string}
 */
function printed(events) {
    const lines = [];
    const log = console.log;
    const warn = console.warn;
    const error = console.error;
    console.log = (...args) => lines.push(args.join(' '));
    console.warn = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    try {
        const renderer = createPlainRenderer({ verbose: false });
        for (const event of events) renderer.event(event);
    } finally {
        console.log = log;
        console.warn = warn;
        console.error = error;
    }
    return lines.join('\n');
}

test('the references of the run are named', () => {
    const text = printed([
        { type: 'references', items: [{ path: 'landing.png', kind: 'original' }] },
    ]);
    assert.match(text, /landing\.png/);
    assert.match(text, /original/);
});

test('a tool call shows what it was given', () => {
    const text = printed([
        { type: 'tool.call', name: 'sample_colors', arguments: { path: 'landing.png', x: 10, y: 20, width: 30, height: 40 } },
    ]);
    assert.match(text, /sample_colors/);
    assert.match(text, /path=landing\.png/);
    assert.match(text, /width=30/);
});

test('the sampled colours are told with their share', () => {
    const output = [
        'Colours of landing.png (30×40 at 10,20):',
        '  1. #aabbcc  oklch: oklch(0.6 0.1 20)  hsl: hsl(200 20% 60%)  luminance: 0.45  share: 62.5%',
        '  2. #112233  oklch: oklch(0.2 0.05 250)  hsl: hsl(220 40% 13%)  luminance: 0.02  share: 37.5%',
        '  plate: #ffffff',
        '  contrast plate vs the most different colour: 18.5:1',
    ].join('\n');
    const text = printed([{ type: 'tool.result', name: 'sample_colors', output }]);
    assert.match(text, /#aabbcc 62\.5%/);
    assert.match(text, /#112233 37\.5%/);
    assert.match(text, /plate: #ffffff/);
    assert.match(text, /contrast 18\.5:1/);
});

test('the sheet is told with its counts and its colours', () => {
    const text = printed([
        {
            type: 'measure.sheet',
            canvas: { width: 1024, height: 768 },
            elements: 12,
            regions: 3,
            rules: 5,
            colors: [{ name: 'plate', hex: '#111111', share: 0.5, method: 'sampled', confidence: 'high' }],
        },
    ]);
    assert.match(text, /12 elements, 3 regions, 5 rules/);
    assert.match(text, /canvas 1024×768/);
    assert.match(text, /plate #111111 50\.0% sampled/);
});

test('the files of the delivery are named as they are written', () => {
    const text = printed([{ type: 'artifact', file: 'measurements/measurements.json', bytes: 2048 }]);
    assert.match(text, /written: measurements\/measurements\.json \(2 kB\)/);
});

test('the crops that were cut are named', () => {
    const text = printed([
        { type: 'measure.crops', crops: [{ crop: '.tmp/x/crops/01-bishop.png', kind: 'artwork', name: 'bishop' }] },
    ]);
    assert.match(text, /\.tmp\/x\/crops\/01-bishop\.png/);
    assert.match(text, /artwork "bishop"/);
});

test('the wait of the model is told in seconds', () => {
    const text = printed([{ type: 'request.wait', elapsedMs: 40_000 }]);
    assert.match(text, /thinking \(40s\)/);
});
