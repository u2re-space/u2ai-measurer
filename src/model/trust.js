/**
 * @file src/model/trust.js
 * @module model/trust
 * @purpose The models that do not answer every role: the stages that cut a picture apart do
 *          not trust the Gemini 4 Hydrogen and go to the Kimi instead.
 * @depends model/profiles
 * @usedBy roles/index
 * @exports SAFE_MODEL, SAFE_EFFORT, UNTRUSTED, isTrusted
 * @ai.tags model, trust
 * @ai.hint pure
 */

/**
 * The model the house trusts with the stages that cut a picture apart.
 *
 * The segmentation and the crop plan want a sharp eye and a quick answer, not a long thinking:
 * the Gemini 4 Hydrogen is not trusted with the boxes of the zones, so those two stages go to
 * the Kimi K3.1 Pro. The model is the fallback of the house anyway — it answers with the
 * reasoning off in a fraction of the time, and it is the one that stays cheap.
 */
export const SAFE_MODEL = 'moonshotai/kimi-k3.1-pro';

/**
 * The effort the safe model works on.
 *
 * The Kimi has no levels above `medium` — the answer of the same question costs the same
 * seconds there — so `medium` is the sharpest eye the model gives for the price of the run.
 */
export const SAFE_EFFORT = 'medium';

/**
 * The roles each model is not trusted with.
 *
 * The key is the model, the value is the list of the roles that move to the safe model. The
 * names of the roles are the names of the stages: `segmentator` is the stage `segmentate`,
 * `cropper` is the stage `crop`.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const UNTRUSTED = Object.freeze({
    'google/gemini-4-hydrogen': Object.freeze(['segmentator', 'cropper']),
});

/**
 * Whether a model may answer a role.
 *
 * A model that is not on the list of the trusted ones for the role is not asked: the role goes
 * to the safe model of the house. A model that is not in the table at all is trusted with every
 * role.
 * @param {string} role the name of the role
 * @param {string|null} model the model of the run
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isTrusted(role, model) {
    if (!model) return true;
    const roles = UNTRUSTED[model];
    if (!Array.isArray(roles)) return true;
    return !roles.includes(role);
}
