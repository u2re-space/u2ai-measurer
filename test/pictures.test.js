/**
 * @file test/pictures.test.js
 * @module test/pictures
 * @purpose The tests of the pictures of the measurer: the picture that a tool names goes back
 *          into the conversation, so the model sees what it asked to see.
 * @depends node:test, node:fs/promises, node:os, node:path, roles/index
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import { createRoleRunner, pictureParts } from '../src/roles/index.js';

const configFor = (overrides = {}) => ({
    model: 'vendor/default',
    reasoning: { effort: 'high' },
    roles: { default: {}, measurer: {} },
    documentation: { roles: { measurer: [] } },
    ...overrides,
});

/**
 * A project with one picture.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function project() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-pictures-'));
    // A PNG of one pixel: the header is enough for the part of the request.
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
    await writeFile(path.join(root, 'landing.png'), png);
    return {
        root,
        cleanup: async () => {
            const { rm } = await import('node:fs/promises');
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('the picture that a tool names goes back into the conversation', async () => {
    const { root, cleanup } = await project();
    try {
        const calls = [];
        const client = {
            responses: {
                async create(params) {
                    calls.push(params);
                    if (calls.length === 1) {
                        return {
                            output: [{
                                type: 'function_call',
                                id: 'call-1',
                                call_id: 'call-1',
                                name: 'view_image',
                                arguments: JSON.stringify({ path: 'landing.png' }),
                            }],
                            output_text: '',
                        };
                    }
                    return { output_text: 'I measured a box of 10 by 10.', output: [] };
                },
            },
        };
        const toolset = {
            specsFor: () => [{ type: 'function', name: 'view_image', parameters: { type: 'object' } }],
            async execute() { return 'Image landing.png: 1024×768 png'; },
        };
        const runner = createRoleRunner({ client, config: configFor(), toolset, root });
        await runner.run('measurer', { text: 'measure', maxTurns: 2 });

        // The second request carries the picture: the model asked to see it and sees it.
        const second = JSON.stringify(calls[1].input);
        assert.match(second, /input_image/);
        assert.match(second, /data:image\/png;base64,/);
    } finally {
        await cleanup();
    }
});

test('the pictures of an answer are found by their paths', async () => {
    const { root, cleanup } = await project();
    try {
        const parts = await pictureParts(root, 'Image landing.png: 1024×768 png');
        assert.equal(parts.length, 1);
        assert.equal(parts[0].type, 'input_image');
        assert.match(parts[0].image_url, /^data:image\/png;base64,/);

        // The text without a picture gives nothing.
        assert.deepEqual(await pictureParts(root, 'the colours of the plate'), []);
        // The path that is not in the project gives nothing.
        assert.deepEqual(await pictureParts(root, 'Image ../outside.png: 10×10 png'), []);
    } finally {
        await cleanup();
    }
});
