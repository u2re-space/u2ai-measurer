/**
 * Home directory and config file locations.
 *
 * The CLI keeps its state in ~/.ai-measure (override with
 * AI_MEASURE_HOME); the home config is config.json there and the skill packs
 * live in ~/.ai-measure/skills.
 *
 * @ai.hint legacy-0.2
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Agent home directory: AI_MEASURE_HOME, or ~/.ai-measure.
 * @param {object} [env]
 * @returns {string}
 */
export function defaultHome(env = process.env) {
  return env.AI_MEASURE_HOME ? path.resolve(env.AI_MEASURE_HOME) : path.join(os.homedir(), '.ai-measure');
}

/**
 * Absolute path of the home config file.
 * @param {string} home
 * @returns {string}
 */
export function homeConfigFile(home) {
  return path.join(home, 'config.json');
}

/**
 * Absolute path of the home skill directory.
 * @param {string} home
 * @returns {string}
 */
export function homeSkillsDir(home) {
  return path.join(home, 'skills');
}

/**
 * Resolve a --config argument to an absolute path.
 * @param {string|null|undefined} configPath
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveConfigPath(configPath, cwd = process.cwd()) {
  if (!configPath || typeof configPath !== 'string' || !configPath.trim()) return null;
  return path.resolve(cwd, configPath.trim());
}

/**
 * Create the home directory when missing (best effort: a read-only home
 * must not break a run that works entirely from flags).
 * @param {string} home
 * @returns {Promise<void>}
 */
export async function ensureHomeDir(home) {
  try {
    await mkdir(home, { recursive: true });
  } catch { /* ignore */ }
}
