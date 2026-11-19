/**
 * @file src/model/trust.js
 * @module model/trust
 * @purpose The models that do not answer every role: the stages that cut a picture apart do
 *          not trust the Gemini 4 Hydrogen and go to the Kimi instead.
 * @depends config/defaults, model/refs
 * @usedBy roles/index
 * @exports SAFE_MODEL, SAFE_EFFORT, UNTRUSTED, HOUSE_MODELS, isTrusted, safeModel, safeEffort, houseModel
 * @ai.tags model, trust
 * @ai.hint pure
 */

import { defaults } from '../config/defaults.js';
import { familyModels, familyName, rankPath, resolveModelRef } from './refs.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The model the house trusts with the stages that cut a picture apart.
 *
 * The segmentation and the crop plan want a sharp eye and a quick answer, not a long thinking:
 * the Gemini 4 Hydrogen is not trusted with the boxes of the zones, so those two stages go to
 * the Kimi K3.1 Pro. The model is the fallback of the house anyway — it answers with the
 * reasoning off in a fraction of the time, and it is the one that stays cheap.
 *
 * The config decides: the section `house.safe` of the config holds the model and the effort
 * of the safe model, and the model may be a family of models (`family:claude`).
 */
export const SAFE_MODEL = defaults.house.safe.model;

/**
 * The effort the safe model works on.
 *
 * The Kimi has no levels above `medium` — the answer of the same question costs the same
 * seconds there — so `medium` is the sharpest eye the model gives for the price of the run.
 */
export const SAFE_EFFORT = defaults.house.safe.effort;

/**
 * The roles each model is not trusted with.
 *
 * The key is the model, the value is the list of the roles that move to the safe model. The
 * names of the roles are the names of the stages: `segmentator` is the stage `segmentate`,
 * `cropper` is the stage `crop`.
 *
 * The config decides: the section `house.untrusted` of the config holds the same table, and
 * a key may be a family of models (`family:gemini`).
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const UNTRUSTED = Object.freeze(
    Object.fromEntries(
        Object.entries(defaults.house.untrusted).map(([model, roles]) => [model, Object.freeze([...roles])]),
    ),
);

/**
 * The built-in model of the house for the roles that have one.
 * @type {Readonly<Record<string, string>>}
 */
export const HOUSE_MODELS = Object.freeze({ ...defaults.house.models });

/**
 * The model of the house for a role, or null when the role has none of its own.
 *
 * The name of the model may be a family of models (`family:gpt`) or a group of them
 * (`group:small`): the role then answers with the member that takes the effort and fits
 * the context.
 * @param {string|null} role the name of the role
 * @param {object|null} [config] the configuration of the run
 * @param {{ effort?: string|null, context?: string|number|null }} [options] the effort and the
 *   context budget the model has to take
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function houseModel(role, config = null, { effort = null, context = null, rank = null } = {}) {
    const key = String(role ?? '').trim().toLowerCase();
    if (!key) return null;
    const models = config?.house?.models;
    let ref = null;
    if (isRecord(models) && Object.hasOwn(models, key)) {
        // The config knows the role: an empty name means that the role has no model of the
        // house and answers on the model of the run.
        const value = models[key];
        ref = typeof value === 'string' && value.trim() ? value.trim() : null;
    } else {
        ref = HOUSE_MODELS[key] ?? null;
    }
    // The place of the family the role answers on: the path of the role, unless the caller
    // names the place itself.
    const place = rank ?? rankPath(config?.house?.ranks?.roles?.[key])?.[0] ?? null;
    return resolveModelRef(ref, config, { effort, context, rank: place });
}

/**
 * The model the house trusts with the roles the model of the run is not trusted with.
 * @param {object|null} [config]
 * @param {{ effort?: string|null }} [options]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function safeModel(config = null, { effort = null } = {}) {
    const ref = config?.house?.safe?.model ?? SAFE_MODEL;
    return resolveModelRef(ref, config, { effort }) ?? SAFE_MODEL;
}

/**
 * The effort the safe model works on.
 * @param {object|null} [config]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function safeEffort(config = null) {
    const effort = config?.house?.safe?.effort;
    return typeof effort === 'string' && effort.trim() ? effort.trim() : SAFE_EFFORT;
}

/**
 * Whether a model may answer a role.
 *
 * A model that is not on the list of the trusted ones for the role is not asked: the role goes
 * to the safe model of the house. A model that is not in the table at all is trusted with every
 * role.
 * @param {string} role the name of the role
 * @param {string|null} model the model of the run
 * @param {object|null} [config] the configuration of the run
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isTrusted(role, model, config = null) {
    if (!model) return true;
    const table = config?.house?.untrusted ?? UNTRUSTED;
    if (!isRecord(table)) return true;
    for (const [key, roles] of Object.entries(table)) {
        if (!Array.isArray(roles)) continue;
        const name = familyName(key);
        const models = name ? familyModels(config, name) : [key];
        if (!models.includes(model)) continue;
        return !roles.includes(role);
    }
    return true;
}
