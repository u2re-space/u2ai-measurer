/**
 * Configuration fields taken from the environment.
 *
 * Precedence inside the CLI: defaults < config.json < --config file < env <
 * CLI overrides. This module only maps env names to config paths; merging is
 * the loader's job. `AI_MEASURE_*` is the primary namespace; the plain
 * `OPENAI_*` / `AI_*` names are accepted for compatibility with the
 * monolith's user setup.
 *
 * @ai.hint legacy-0.2
 */

import { ENUMS } from './constants.js';

/**
 * Parse one env value as a bounded integer.
 * @param {string|undefined} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function intInRange(raw, min, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Parse one env value as a JSON array of backend entries; invalid input is ignored.
 * @param {string|undefined} raw
 * @returns {object[]|null}
 */
function backendList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build a partial config object from environment variables.
 * @param {object} [env]
 * @returns {object}
 */
export function fromEnv(env = process.env) {
  const out = {};
  const set = (path, value) => {
    if (value === undefined || value === null || value === '') return;
    let owner = out;
    for (const step of path.slice(0, -1)) {
      owner[step] ??= {};
      owner = owner[step];
    }
    owner[path.at(-1)] = value;
  };

  // --- API -----------------------------------------------------------------
  set(['model'], env.AI_MEASURE_MODEL ?? env.AI_MODEL ?? env.OPENAI_MODEL);
  set(['baseURL'], env.AI_MEASURE_BASE_URL ?? env.OPENAI_BASE_URL);
  set(['apiKey'], env.AI_MEASURE_API_KEY ?? env.OPENAI_API_KEY);
  set(['organization'], env.OPENAI_ORG_ID);
  set(['project'], env.OPENAI_PROJECT_ID);

  // --- reasoning ------------------------------------------------------------
  if (ENUMS.reasoningEfforts.includes(env.AI_MEASURE_EFFORT)) set(['reasoning', 'effort'], env.AI_MEASURE_EFFORT);

  // --- HTTP plumbing --------------------------------------------------------
  const retries = intInRange(env.AI_MEASURE_RETRIES, 0, 10);
  if (retries != null) set(['retries'], retries);
  const timeoutMs = intInRange(env.AI_MEASURE_TIMEOUT_MS, 5_000, 1_800_000);
  if (timeoutMs != null) set(['timeoutMs'], timeoutMs);
  const maxTurns = intInRange(env.AI_MEASURE_MAX_TURNS, 1, 200);
  if (maxTurns != null) set(['limits', 'maxTurns'], maxTurns);

  // --- backends -------------------------------------------------------------
  const backends = backendList(env.AI_MEASURE_BACKENDS);
  if (backends) set(['backends'], backends);

  // --- logging --------------------------------------------------------------
  // A directory turns the log of the API calls on: the records are the witness of a chain
  // that misbehaves.
  if (typeof env.AI_MEASURE_LOG_DIR === 'string' && env.AI_MEASURE_LOG_DIR.trim()) {
    set(['logging', 'enabled'], true);
    set(['logging', 'dir'], env.AI_MEASURE_LOG_DIR.trim());
  }

  // --- raster ---------------------------------------------------------------
  if (ENUMS.rasterEngines.includes(env.AI_MEASURE_RASTER_ENGINE)) set(['raster', 'engine'], env.AI_MEASURE_RASTER_ENGINE);
  set(['raster', 'magickPath'], env.AI_MEASURE_MAGICK_PATH);

  // --- agent ----------------------------------------------------------------
  if (ENUMS.measureModes.includes(env.AI_MEASURE_DESIGN)) set(['agent', 'design'], env.AI_MEASURE_DESIGN);

  // --- stages ---------------------------------------------------------------
  for (const stage of ENUMS.stages) {
    const flag = env[`AI_MEASURE_STAGE_${stage.toUpperCase()}`];
    if (flag === '0' || flag === 'false') set(['stages', stage, 'enabled'], false);
    else if (flag === '1' || flag === 'true') set(['stages', stage, 'enabled'], true);
  }

  return out;
}

/**
 * The config file named by the environment, if any.
 * @param {object} [env]
 * @returns {string|null}
 */
export function envConfigPath(env = process.env) {
  return env.AI_MEASURE_CONFIG || null;
}
