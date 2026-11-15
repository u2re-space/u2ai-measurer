/**
 * @file src/stages/publish.js
 * @module stages/publish
 * @purpose Sign the contract of the project for the delivery of the measurer.
 *
 *   The contract of the project is `.ai/manifest.json`: one file that says what every system
 *   of the house made and where it lies. The measurer signs its own part of it — the sheet of
 *   the measurements, the palette, the tokens, the design direction and the fragments — and
 *   never touches the part of another system.
 *
 *   The paths in the contract are relative to the project and with forward slashes: the
 *   systems of the house read the contract on another machine and another system, and the
 *   path has to mean the same thing there.
 *
 * @depends node:path, node:fs/promises, stages/artifacts, stages/resolve, shared/house
 * @usedBy shared/pipeline
 * @exports publishDelivery
 * @ai.tags house, manifest, delivery
 * @ai.hint io
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { CROPS_DIR, deliveryRel } from './artifacts.js';
import {
    DESIGN_MD_FILE,
    MEASUREMENTS_FILE,
    PALETTE_FILE,
    REPORT_FILE,
    TOKENS_FILE,
} from './resolve.js';
import { HOUSE_SYSTEMS, publish } from '../shared/house.js';

/** The directory of the assets of the design inside the delivery. */
export const DESIGN_ASSETS_DIR = 'design-assets';

/**
 * Whether a file of the delivery is there.
 * @param {string} file
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function there(file) {
    return await stat(file).then((info) => info.isFile()).catch(() => false);
}

/**
 * Publish what the measurer made.
 *
 * The contract is a hint, not a reason to fail: a run that cannot write it warns and goes on.
 * @param {string} root the project directory
 * @param {object} [config] the config of the run
 * @param {object} [state] the state of the run
 * @returns {Promise<object|null>} the contract after the change, or null
 * @exports
 * @ai.hint io
 */
export async function publishDelivery(root, config = {}, state = {}) {
    const delivery = deliveryRel(root, state.outDir ?? config?.output?.dir ?? './measurements');
    const artifacts = {};

    /**
     * Name one file of the delivery, if it is there.
     * @param {string} name the name of the artifact
     * @param {string} file the name of the file inside the delivery
     */
    const add = async (name, file) => {
        if (await there(path.join(root, delivery, file))) artifacts[name] = `${delivery}/${file}`;
    };

    await add('measurements', MEASUREMENTS_FILE);
    await add('palette', PALETTE_FILE);
    await add('tokens', TOKENS_FILE);
    await add('design', DESIGN_MD_FILE);
    await add('report', REPORT_FILE);

    const crops = path.join(root, delivery, CROPS_DIR);
    if (await stat(crops).then((info) => info.isDirectory()).catch(() => false)) {
        artifacts.crops = `${delivery}/${CROPS_DIR}/`;
    }
    const assets = path.join(root, delivery, DESIGN_ASSETS_DIR);
    if (await stat(assets).then((info) => info.isDirectory()).catch(() => false)) {
        artifacts.designAssets = `${delivery}/${DESIGN_ASSETS_DIR}/`;
    }

    return await publish(root, HOUSE_SYSTEMS.measurer, {
        delivery: `${delivery}/`,
        artifacts,
        extra: {
            workId: state.workId ?? null,
            files: Array.isArray(state.artifacts) ? state.artifacts : [],
        },
    });
}
