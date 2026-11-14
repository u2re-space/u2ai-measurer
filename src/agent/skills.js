/**
 * @file src/agent/skills.js
 * @module agent/skills
 * @purpose Read-only skill packs: the markdown a user drops next to the config to teach a role
 *          something the model does not know.
 *
 *   A skill pack comes in two shapes, and both live in `~/.ai-measure/skills`:
 *
 *   - a file: `measurer.md` belongs to the measurer alone, `shared.md` (or `_shared.md`)
 *     belongs to every role;
 *   - a directory: `my-pack/SKILL.md` is the pack, and the other `.md` files of the directory
 *     are its references, appended after the main text.
 *
 *   A pack may carry a frontmatter block:
 *
 *       ---
 *       name: My pack
 *       description: What the pack teaches.
 *       roles: measurer, designer
 *       ---
 *
 *   The frontmatter names the pack and the roles it belongs to; the text after it is the
 *   instruction. The packs are read, never written: the measurer has no business changing the
 *   files a user keeps for this purpose.
 *
 * @depends node:fs/promises, node:path
 * @usedBy roles/index, shared/pipeline
 * @exports defaultSkillsDir, loadSkills, skillsForRole, listSkillPacks, parseFrontmatter
 * @ai.tags skills, prompts
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const textOf = (value) => (typeof value === 'string' ? value : '');

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
 * Split the frontmatter of a markdown file from its body.
 *
 * The frontmatter is a YAML-ish block of `key: value` lines. The parser is deliberately small:
 * a skill pack is a note, not a configuration file.
 * @param {string} text
 * @returns {{ meta: Record<string, string>, body: string }}
 * @exports
 * @ai.hint pure
 */
export function parseFrontmatter(text) {
    const source = textOf(text);
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
    if (!match) return { meta: {}, body: source };
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        if (!key) continue;
        const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        meta[key] = value;
    }
    return { meta, body: source.slice(match[0].length) };
}

/**
 * The roles a pack declares, from the frontmatter and from its name.
 * @param {{ name: string, meta: object }} pack
 * @param {string|null} role the role that asks
 * @returns {boolean}
 * @ai.hint pure
 */
function belongsTo(pack, role) {
    if (!role) return true;
    const declared = textOf(pack?.meta?.roles).split(',').map((item) => item.trim()).filter(Boolean);
    if (declared.includes(role)) return true;
    if (declared.includes('*')) return true;
    const name = String(pack?.name ?? '');
    return name === role || name === 'shared' || name === '_shared';
}

/**
 * Read one markdown file as a pack.
 * @param {string} abs
 * @param {string} name
 * @returns {Promise<{ name: string, meta: object, content: string, bytes: number, files: string[] }|null>}
 * @ai.hint io
 */
async function readPackFile(abs, name) {
    const content = await readFile(abs, 'utf-8').catch(() => null);
    if (content === null) return null;
    const { meta, body } = parseFrontmatter(content);
    return {
        name: textOf(meta.name) || name,
        meta,
        content: body.trim(),
        bytes: Buffer.byteLength(body, 'utf-8'),
        files: [path.basename(abs)],
    };
}

/**
 * Read one directory as a pack: `SKILL.md` is the pack, the other markdown files are its
 * references.
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<{ name: string, meta: object, content: string, bytes: number, files: string[] }|null>}
 * @ai.hint io
 */
async function readPackDir(dir, name) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => entry.name)
        .sort();
    if (!files.length) return null;

    const main = files.find((file) => file.toLowerCase() === 'skill.md')
        ?? files.find((file) => file.toLowerCase() === 'index.md')
        ?? files[0];
    const head = await readPackFile(path.join(dir, main), name);
    if (!head) return null;

    const parts = [head.content];
    const used = [main];
    for (const file of files) {
        if (file === main) continue;
        const extra = await readPackFile(path.join(dir, file), file.slice(0, -3));
        if (!extra) continue;
        used.push(file);
        parts.push(`### ${file}\n${extra.content}`);
    }
    const content = parts.filter(Boolean).join('\n\n');
    return {
        name: head.name,
        meta: head.meta,
        content,
        bytes: Buffer.byteLength(content, 'utf-8'),
        files: used,
    };
}

/**
 * Load the skill packs of one directory.
 *
 * @param {{ dir?: string|null, role?: string|null, env?: object }} [options]
 *   `role` narrows the list to the packs of that role plus the shared packs.
 * @returns {Promise<Array<{ name: string, meta: object, content: string, bytes: number, files: string[] }>>}
 * @exports
 * @ai.hint io
 */
export async function loadSkills({ dir = null, role = null, env = process.env } = {}) {
    const root = dir ? path.resolve(dir) : defaultSkillsDir(env);
    let entries = [];
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const packs = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const pack = await readPackDir(path.join(root, entry.name), entry.name);
            if (pack) packs.push(pack);
            continue;
        }
        if (!entry.name.endsWith('.md')) continue;
        const pack = await readPackFile(path.join(root, entry.name), entry.name.slice(0, -3));
        if (pack) packs.push(pack);
    }
    return packs.filter((pack) => belongsTo(pack, role));
}

/**
 * Every pack of the directory, with the names only — for the `skills` command.
 * @param {{ dir?: string|null, env?: object }} [options]
 * @returns {Promise<Array<{ name: string, bytes: number, files: string[] }>>}
 * @exports
 * @ai.hint io
 */
export async function listSkillPacks({ dir = null, env = process.env } = {}) {
    const packs = await loadSkills({ dir, env });
    return packs
        .map((pack) => ({ name: pack.name, bytes: pack.bytes, files: pack.files }))
        .sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Whether a directory holds skill packs at all — the `skills` command says so.
 * @param {{ dir?: string|null, env?: object }} [options]
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
export async function skillsDirExists({ dir = null, env = process.env } = {}) {
    const root = dir ? path.resolve(dir) : defaultSkillsDir(env);
    const info = await stat(root).catch(() => null);
    return Boolean(info?.isDirectory());
}
