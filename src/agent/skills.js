/**
 * @file src/agent/skills.js
 * @module agent/skills
 * @purpose Read-only skill packs: the markdown a user drops next to the config to teach a role
 *          something the model does not know.
 *
 *   A skill pack is a set of markdown files in one directory. A file named after a role
 *   (`measurer.md`) belongs to that role alone; the files named `shared.md` or `_shared.md` belong
 *   to every role. The text is appended to the instructions of the role, so it is part of the
 *   system prompt and not something the model can be talked out of.
 *
 *   The packs are read, never written: the measurer has no business changing the files a user
 *   keeps for this purpose.
 *
 * @depends node:fs/promises, node:path
 * @usedBy roles/index, shared/pipeline
 * @exports defaultSkillsDir, loadSkills, skillsForRole, listSkillPacks
 * @ai.tags skills, prompts
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

/**
 * The default directory of the skill packs: `~/.ai-measure/skills`.
 * @param {object} [env]
 * @returns {string}
 * @ai.hint pure
 */
export function defaultSkillsDir(env = process.env) {
    const home = env.AI_MEASURE_HOME || env.HOME || env.USERPROFILE || '';
    return path.join(home, '.ai-measure', 'skills');
}

/**
 * Load the skill packs of one directory.
 *
 * @param {{ dir?: string|null, role?: string|null, env?: object }} [options]
 *   `role` narrows the list to the pack of that role plus the shared packs.
 * @returns {Promise<Array<{ name: string, content: string }>>}
 * @exports
 * @ai.hint io
 */
export async function loadSkills({ dir = null, role = null, env = process.env } = {}) {
    const root = dir ? path.resolve(dir) : defaultSkillsDir(env);
    let entries = [];
    try {
        entries = await readdir(root);
    } catch {
        return [];
    }
    const packs = [];
    for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const name = entry.slice(0, -3);
        if (role && name !== role && name !== 'shared' && name !== '_shared') continue;
        const content = await readFile(path.join(root, entry), 'utf-8').catch(() => null);
        if (content === null) continue;
        packs.push({ name, content });
    }
    return packs;
}

/**
 * Every pack of the directory, with the names only — for the `skills` command.
 * @param {{ dir?: string|null, env?: object }} [options]
 * @returns {Promise<Array<{ name: string, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function listSkillPacks({ dir = null, env = process.env } = {}) {
    const root = dir ? path.resolve(dir) : defaultSkillsDir(env);
    let entries = [];
    try {
        entries = await readdir(root);
    } catch {
        return [];
    }
    const packs = [];
    for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const name = entry.slice(0, -3);
        const content = await readFile(path.join(root, entry), 'utf-8').catch(() => null);
        if (content === null) continue;
        packs.push({ name, bytes: Buffer.byteLength(content, 'utf-8') });
    }
    return packs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The text of the skill packs that belong to one role, ready to be appended to its instructions.
 * @param {{ dir?: string|null, role?: string|null, env?: object }} [options]
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function skillsForRole(options = {}) {
    const packs = await loadSkills(options);
    if (!packs.length) return '';
    return packs
        .map((pack) => `## Skill pack: ${pack.name}\n${pack.content.trim()}`)
        .join('\n\n');
}
