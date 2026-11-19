/**
 * @file src/agent/tools.js
 * @purpose The executor of the tools: it runs the calls the model asks for inside the working
 *          directory and answers with a short text the model can read.
 *
 * This CLI does not generate pictures and does not decompose screens: the two jobs live in their
 * own packages (`@u2ai/images`, `@u2ai/decomposer`), and the tools below call those CLIs as
 * subprocesses. The binary is looked up in this order: the environment variable, the checkout
 * of the sibling package, the installed `node_modules`, and the `PATH`.
 *
 * @depends node:path, node:fs/promises, node:child_process, image/sharp, image/colors,
 *          agent/tool-specs, agent/paths, agent/run-map
 * @exports createToolset, toolSpecs, enabledToolNames, resolveExternalCli, externalCliCandidates
 * @ai.tags tools, agent, external
 * @ai.hint keep
 * @ai.hint legacy-0.2
 * @changed 2026-11-15 The map of the run and the cache of the context answer the tools.
 */
import path from 'node:path';
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rasterInfo, rasterCrop, rasterSplit } from '../image/sharp.js';
import { sampleColors, contrastRatio } from '../image/colors.js';
import { describeColor as describeCssColor } from '../image/color-space.js';
import { clampRect } from '../image/crop.js';
import { toolSpecs as buildSpecs } from './tool-specs.js';
import { readSkill } from './skills.js';
import { isInside, resolveInside, toPosix } from './paths.js';
import { mapFiles } from './run-map.js';
import { writeFileAtomic } from '../shared/house.js';
import { createLineReader } from '../shared/child-log.js';

export { toolSpecs, enabledToolNames } from './tool-specs.js';

/** The tools whose answers are worth remembering: they read the same thing every time. */
const CACHEABLE = new Set(['view_image', 'sample_colors', 'parse_color']);

/** The root of this package: the sibling packages are looked up next to it. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The external CLIs this package may call. */
export const EXTERNAL_CLIS = Object.freeze({
    'ai-image': {
        command: 'ai-image',
        env: 'AI_IMAGE_BIN',
        package: '@u2ai/images',
        checkout: 'u2ai-images',
        script: path.join('bin', 'ai-image.js'),
    },
    'ai-decompose': {
        command: 'ai-decompose',
        env: 'AI_DECOMPOSE_BIN',
        package: '@u2ai/decomposer',
        checkout: 'u2ai-decomposer',
        script: path.join('bin', 'ai-decompose.js'),
    },
});

/**
 * The files that may hold an external CLI, in the order they are tried.
 * @param {keyof typeof EXTERNAL_CLIS} name
 * @param {{ root?: string, env?: object }} [options]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function externalCliCandidates(name, { root = PACKAGE_ROOT, env = process.env } = {}) {
    const spec = EXTERNAL_CLIS[name];
    if (!spec) return [];
    const candidates = [];
    if (env[spec.env]) candidates.push(path.resolve(env[spec.env]));
    // The checkout of the sibling package, next to this one or inside it.
    candidates.push(path.join(root, spec.checkout, spec.script));
    candidates.push(path.join(root, '..', spec.checkout, spec.script));
    candidates.push(path.join(root, 'submodules', spec.checkout, spec.script));
    // The installed package.
    candidates.push(path.join(root, 'node_modules', ...spec.package.split('/'), spec.script));
    return candidates;
}

/**
 * The `ai-image`/`ai-decompose` executable in PATH.
 * @param {keyof typeof EXTERNAL_CLIS} name
 * @param {object} env
 * @returns {Promise<{ command: string, args: string[], shell?: boolean }|null>}
 * @exports
 * @ai.hint io
 */
async function findOnPath(name, env) {
    const spec = EXTERNAL_CLIS[name];
    if (!spec) return null;
    const names = process.platform === 'win32'
        ? [`${spec.command}.cmd`, `${spec.command}.exe`, spec.command]
        : [spec.command];
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const candidate of names) {
            const full = path.join(dir, candidate);
            if (!await stat(full).then(() => true).catch(() => false)) continue;
            if (process.platform === 'win32' && candidate.endsWith('.cmd')) {
                return { command: full, args: [], shell: true };
            }
            return { command: full, args: [] };
        }
    }
    return null;
}

/**
 * Find the external CLI to delegate to.
 *
 * A `.js` entry is run with the same Node that runs this CLI; anything else is an executable.
 * @param {keyof typeof EXTERNAL_CLIS} name
 * @param {{ root?: string, env?: object }} [options]
 * @returns {Promise<{ command: string, args: string[], shell?: boolean }|null>} null when it is not installed
 * @exports
 * @ai.hint io
 */
export async function resolveExternalCli(name, { root = PACKAGE_ROOT, env = process.env } = {}) {
    for (const candidate of externalCliCandidates(name, { root, env })) {
        if (!await stat(candidate).then(() => true).catch(() => false)) continue;
        if (candidate.endsWith('.js')) return { command: process.execPath, args: [candidate] };
        if (candidate.endsWith('.cmd')) return { command: candidate, args: [], shell: true };
        return { command: candidate, args: [] };
    }
    return await findOnPath(name, env);
}

/**
 * Run an external CLI and collect its answer.
 *
 * The log of the child comes live: `onLine` is called with every line of the child as it is
 * written, so the run shows what the sibling CLI does instead of waiting in silence. The whole
 * output is still collected in the answer.
 * @param {keyof typeof EXTERNAL_CLIS} name
 * @param {string[]} args
 * @param {{ root?: string, env?: object, cwd?: string, timeoutMs?: number,
 *   onLine?: ((event: { stream: string, line: string }) => void)|null }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 * @exports
 * @ai.hint io
 */
export async function runExternalCli(name, args, { root = PACKAGE_ROOT, env = process.env, cwd = PACKAGE_ROOT, timeoutMs = 600_000, onLine = null } = {}) {
    const found = await resolveExternalCli(name, { root, env });
    if (!found) throw new Error(`The external CLI "${name}" is not installed: set ${EXTERNAL_CLIS[name]?.env ?? 'the path'} or install ${EXTERNAL_CLIS[name]?.package ?? 'the package'}.`);
    const live = typeof onLine === 'function';
    const readers = {
        stdout: live ? createLineReader((line) => onLine({ stream: 'stdout', line })) : null,
        stderr: live ? createLineReader((line) => onLine({ stream: 'stderr', line })) : null,
    };
    return await new Promise((resolve, reject) => {
        const child = spawn(found.command, [...found.args, ...args], {
            cwd,
            env,
            shell: found.shell ?? false,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
            readers.stdout?.push(chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
            readers.stderr?.push(chunk);
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            readers.stdout?.flush();
            readers.stderr?.flush();
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            // The last line of the child may have no line break at the end.
            readers.stdout?.flush();
            readers.stderr?.flush();
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
}

/**
 * The matcher of a pattern of the names of the files.
 *
 * A pattern is a glob: `*` is any text except the slash, `**` is any text, `?` is one
 * character. A pattern without a slash matches the name of the file, a pattern with a
 * slash matches the path of the file from the root.
 * @param {string} pattern
 * @returns {RegExp|null}
 * @exports
 * @ai.hint pure
 */
export function globMatcher(pattern) {
    const text = String(pattern ?? '').trim();
    if (!text) return null;
    const body = text
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${body}$`, 'i');
}

/**
 * Turn a name into a token the API accepts.
 * @param {string} value
 * @returns {string}
 * @ai.hint pure
 */
function token(value) {
    return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The tools of the connected MCP servers, named so that two servers cannot collide.
 * @param {Array<{ name: string, tools: object[], call: Function }>} connections
 * @returns {Array<{ name: string, description: string, parameters: object, connection: object, tool: string }>}
 * @exports
 * @ai.hint pure
 */
export function mcpToolEntries(connections = []) {
    const out = [];
    for (const [index, connection] of (connections ?? []).entries()) {
        const prefix = `mcp_${token(connection?.name ?? index)}`;
        for (const tool of connection?.tools ?? []) {
            if (!tool || typeof tool.name !== 'string') continue;
            out.push({
                name: `${prefix}_${token(tool.name)}`,
                description: String(tool.description ?? ''),
                parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
                    ? tool.inputSchema
                    : { type: 'object', properties: {} },
                connection,
                tool: tool.name,
            });
        }
    }
    return out;
}

/**
 * Create a toolset executor bound to a working directory.
 *
 * Every path the model names is resolved inside the working directory, and every file the model
 * writes has to land in one of the directories the current stage opened for writing.
 *
 * The map of the run is the fast path: the search and the read of a file the map knows do not
 * touch the disk. The context of the run is the memory: the answer of a question that was
 * already asked comes from the cache, and every call is written into the journal.
 * @param {{ root: string, config: object, role?: string|null, mcp?: object[],
 *   writeDirs?: string[], env?: object, packageRoot?: string, context?: object|null,
 *   map?: object|null, scratch?: string|null,
 *   notify?: ((event: object) => void)|null }} opts
 * @returns {{ execute: (name: string, args: object) => Promise<string>, specs: object[], setWriteDirs: Function, writeDirs: Function }}
 */
export function createToolset({ root, config, role = null, mcp = [], writeDirs = null, env = process.env, packageRoot = PACKAGE_ROOT, context = null, map = null, scratch = null, notify = null }) {
    const mcpTools = mcpToolEntries(mcp);
    const mcpSpecs = mcpTools.map((entry) => ({
        type: 'function',
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
    }));
    const specs = [...buildSpecs(config?.tools, { role }), ...mcpSpecs];
    let allowed = (writeDirs ?? [root]).map((dir) => path.resolve(dir));
    // The scratch of the run: the files the model makes for itself.
    //
    // A file name without a folder is not a file of the delivery — it is the model's own
    // scratch work, and it dies with the run. The root of the project is not the model's, and
    // a file that lands there is litter the reader has to clean up by hand.
    const scratchDir = scratch ? path.resolve(scratch) : null;
    const scratchRel = scratchDir ? toPosix(path.relative(path.resolve(root), scratchDir)) : '';

    /**
     * The directories the model may write into right now.
     * @returns {string[]}
     */
    const openDirs = () => (scratchDir ? [...new Set([...allowed, scratchDir])] : allowed);

    /**
     * Resolve a path the model wants to read.
     * @param {string} value
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    async function readPath(value) {
        return await resolveInside(root, String(value ?? ''), { allowRoot: false });
    }

    /**
     * Resolve a path the model wants to write, and refuse the ones outside the allowed dirs.
     *
     * The root of the project is not writable: a file the model names without a folder is
     * its own scratch work, and it lands in the scratch of the run.
     * @param {string} value
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    async function writePath(value) {
        const requested = String(value ?? '').trim();
        if (scratchDir && (requested === '' || requested === '.')) {
            return { abs: scratchDir, rel: scratchRel };
        }
        const located = await resolveInside(root, requested, { forWrite: true, allowRoot: false });
        const bare = path.dirname(located.rel) === '.';
        const target = bare && scratchDir
            ? { abs: path.join(scratchDir, path.basename(located.rel)), rel: `${scratchRel}/${path.basename(located.rel)}` }
            : located;
        if (!openDirs().some((dir) => isInside(dir, target.abs))) {
            throw new Error(`Writing outside the output directory is forbidden: ${target.rel}`);
        }
        return target;
    }

    /**
     * The answer to a file that is not there.
     *
     * The answer names the files the run really has: a model that is told where the picture is
     * does not go looking for it in the working directory of the run.
     * @param {string} requested the path the model named
     * @returns {string}
     * @ai.hint pure
     */
    function missingAnswer(requested) {
        const references = Array.isArray(context?.state?.references) ? context.state.references : [];
        const wanted = path.basename(String(requested ?? '')).toLowerCase();
        const lines = [`There is no file at \`${requested}\`.`];
        const same = references.find((item) => path.basename(String(item?.rel ?? '')).toLowerCase() === wanted);
        if (same) {
            lines.push(`The picture of this run is \`${same.rel}\` — open it by that path.`);
            return lines.join('\n');
        }
        if (references.length) {
            lines.push('The pictures of this run are:');
            for (const item of references) lines.push(`- \`${item.rel}\``);
            lines.push('These paths are exact — do not look for the pictures anywhere else.');
            return lines.join('\n');
        }
        lines.push('Use `list_files` to see the files of the working directory.');
        return lines.join('\n');
    }

    /**
     * The text of a file, from the map of the run.
     *
     * The map is used only when the file has not changed since the map was built: the mtime of
     * the file decides, so a stale map never lies.
     * @param {string} rel the path of the file, relative to the root
     * @returns {Promise<string|null>}
     */
    async function readFromMap(rel) {
        if (!map?.enabled) return null;
        const record = map.data?.files?.[rel];
        if (!record || record.partial || !Array.isArray(record.lines)) return null;
        const info = await stat(path.join(root, ...rel.split('/'))).catch(() => null);
        if (!info?.isFile() || info.mtimeMs !== record.mtimeMs) return null;
        return record.lines.join(record.eol ?? '\n');
    }

    /**
     * The key of the cache of a call: the name of the tool, its arguments and the moment of
     * the file it reads.
     * @param {string} name
     * @param {object} args
     * @returns {Promise<string>}
     */
    async function cacheKeyOf(name, args) {
        const parts = [name, JSON.stringify(args ?? {})];
        const rel = String(args?.path ?? '');
        if (rel) {
            const info = await stat(path.resolve(root, rel)).catch(() => null);
            parts.push(info?.mtimeMs ?? 'no-file');
        }
        return parts.join('|');
    }

    /**
     * Index a file of the run in the map, so the next search finds it.
     * @param {string} rel
     * @returns {Promise<void>}
     */
    async function rememberInMap(rel) {
        if (!map?.enabled || !rel) return;
        await map.update(rel).catch(() => {});
    }

    /**
     * Every file of a directory, up to a depth.
     * @param {string} dir absolute path
     * @param {number} depth
     * @param {string[]} out
     * @returns {Promise<string[]>}
     */
    async function walk(dir, depth, out) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth > 1) await walk(full, depth - 1, out);
                continue;
            }
            out.push(full);
        }
        return out;
    }

    async function execute(name, args = {}) {
        const mcpTool = mcpTools.find((entry) => entry.name === name);
        if (mcpTool) {
            const result = await mcpTool.connection.call(mcpTool.tool, args ?? {});
            const content = Array.isArray(result?.content) ? result.content : null;
            if (content) {
                return content
                    .map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
                    .join('\n');
            }
            return typeof result === 'string' ? result : JSON.stringify(result ?? null);
        }
        // The answer of a question that was already asked comes from the cache of the run.
        const key = CACHEABLE.has(name) ? await cacheKeyOf(name, args) : null;
        if (key) {
            const hit = await context?.cached?.(key);
            if (hit?.answer) {
                await context?.action?.(`${name} ${JSON.stringify(args ?? {})}`, { role });
                return String(hit.answer);
            }
        }
        const answer = await runTool(name, args);
        if (key) await context?.put?.(key, { answer, at: new Date().toISOString() });
        await context?.action?.(`${name} ${JSON.stringify(args ?? {})}`, { role });
        return answer;
    }

    /**
     * Run one tool of the catalogue.
     * @param {string} name
     * @param {object} args
     * @returns {Promise<string>}
     */
    async function runTool(name, args = {}) {
        switch (name) {
            case 'view_image': {
                const located = await readPath(args.path);
                const exists = await stat(located.abs).then((info) => info.isFile()).catch(() => false);
                if (!exists) return missingAnswer(located.rel);
                const info = await rasterInfo(located.abs);
                return `Image ${located.rel}: ${info.width}×${info.height} ${info.format ?? ''}`;
            }
            case 'crop_image': {
                const located = await readPath(args.path);
                const exists = await stat(located.abs).then((info) => info.isFile()).catch(() => false);
                if (!exists) return missingAnswer(located.rel);
                const parsed = path.parse(located.abs);
                const fallbackName = `${parsed.name}-crop.png`;
                const fallback = scratchDir
                    ? path.join(scratchDir, fallbackName)
                    : path.join(parsed.dir, fallbackName);
                const target = await writePath(args.output ?? fallback);
                const info = await rasterInfo(located.abs);
                const box = clampRect(args, info);
                await rasterCrop({ input: located.abs, output: target.abs, ...box });
                await rememberInMap(target.rel);
                return `Cropped to ${target.rel} (${box.width}×${box.height})`;
            }
            case 'split_image': {
                const located = await readPath(args.path);
                const exists = await stat(located.abs).then((info) => info.isFile()).catch(() => false);
                if (!exists) return missingAnswer(located.rel);
                const outDir = await writePath(args.outputDir ?? (scratchDir ?? '.'));
                await mkdir(outDir.abs, { recursive: true });
                const tiles = await rasterSplit({
                    input: located.abs,
                    outputDir: outDir.abs,
                    rows: Math.max(1, Number(args.rows) || 1),
                    cols: Math.max(1, Number(args.cols) || 1),
                    baseName: 'tile',
                });
                await rememberInMap(outDir.rel);
                return `Split into ${tiles.length} tiles in ${outDir.rel}`;
            }
            case 'sample_colors': {
                const located = await readPath(args.path);
                const exists = await stat(located.abs).then((info) => info.isFile()).catch(() => false);
                if (!exists) return missingAnswer(located.rel);
                const hasBox = Number.isFinite(Number(args.width)) && Number.isFinite(Number(args.height));
                const box = hasBox
                    ? { x: Number(args.x) || 0, y: Number(args.y) || 0, width: Number(args.width), height: Number(args.height) }
                    : null;
                const result = await sampleColors({
                    abs: located.abs,
                    box,
                    k: Math.max(1, Number(args.k) || 5),
                    engine: config?.raster?.engine ?? 'auto',
                });
                // The most different colour from the plate: the one a text would sit on.
                const subject = result.colors
                    .filter((c) => c.hex !== result.background?.hex)
                    .sort((a, b) => Math.abs((b.luminance ?? 0) - (result.background?.luminance ?? 0))
                        - Math.abs((a.luminance ?? 0) - (result.background?.luminance ?? 0)))[0];
                const lines = result.colors.map((c, i) =>
                    `  ${i + 1}. ${c.hex}  oklch: ${c.oklch}  hsl: ${c.hsl}  luminance: ${c.luminance}  share: ${(Number(c.share ?? 0) * 100).toFixed(1)}%`);
                const contrast = result.background && subject
                    ? Number(contrastOf(result.background, subject).toFixed(2))
                    : null;
                return [
                    `Colours of ${located.rel}${box ? ` (${box.width}×${box.height} at ${box.x},${box.y})` : ''}:`,
                    ...lines,
                    result.background ? `  plate: ${result.background.hex}` : '  plate: unknown',
                    contrast != null ? `  contrast plate vs the most different colour: ${contrast}:1` : null,
                    `  colour space: ${result.colorSpace?.working ?? 'sRGB'} — ${result.colorSpace?.assumption ?? ''}`,
                    ...result.warnings,
                ].filter(Boolean).join('\n');
            }
            case 'parse_color': {
                const value = String(args.color ?? '').trim();
                if (!value) return 'The colour is empty.';
                const against = String(args.against ?? '').trim();
                const described = describeCssColor(value, { against: against || null });
                if (!described) return `Not a CSS colour: ${value}`;
                const lines = [
                    `Colour ${described.color}:`,
                    `  hex: ${described.hex}${described.alpha < 1 ? ` (alpha ${described.alpha})` : ''}`,
                    `  rgb: ${described.rgb}`,
                    `  hsl: ${described.hsl}`,
                    `  hwb: ${described.hwb}`,
                    `  oklab: ${described.oklab}`,
                    `  oklch: ${described.oklch}`,
                    `  lab: ${described.lab}`,
                    `  lch: ${described.lch}`,
                    `  display-p3: ${described.p3}`,
                    `  luminance: ${described.luminance}`,
                    described.contrast != null ? `  contrast against ${described.against}: ${described.contrast}:1` : null,
                    `  ${described.note}`,
                ].filter(Boolean);
                return lines.join('\n');
            }
            case 'list_files': {
                const located = await resolveInside(root, String(args.path ?? '.'), { allowRoot: true });
                const depth = Math.max(1, Number(args.depth) || 1);
                if (map?.enabled) {
                    const relDir = toPosix(path.relative(root, located.abs)) || '.';
                    const lines = mapFiles(map.data, { dir: relDir, depth }).slice(0, 500);
                    return lines.length ? lines.join('\n') : '(no files)';
                }
                const files = await walk(located.abs, depth, []);
                const lines = files
                    .map((file) => toPosix(path.relative(root, file)))
                    .sort()
                    .slice(0, 500);
                return lines.length ? lines.join('\n') : '(no files)';
            }
            case 'read_file': {
                const located = await readPath(args.path);
                const exists = await stat(located.abs).then((info) => info.isFile()).catch(() => false);
                if (!exists) return missingAnswer(located.rel);
                const rel = toPosix(path.relative(root, located.abs));
                const known = await readFromMap(rel);
                if (known !== null) return known;
                return await readFile(located.abs, 'utf-8');
            }
            case 'read_skill': {
                const name = String(args.name ?? '').trim();
                const extraDirs = config?.skills?.dir ? [String(config.skills.dir)] : [];
                const skill = await readSkill(name, root, { extraDirs, env });
                if (!skill) return `Skill not found: ${name}`;
                const head = skill.description ? `${skill.description}\n\n` : '';
                return `# ${skill.name}\n\n${head}${skill.body}`;
            }
            case 'write_file': {
                const target = await writePath(args.path);
                await mkdir(path.dirname(target.abs), { recursive: true });
                await writeFileAtomic(target.abs, String(args.content ?? ''));
                await rememberInMap(target.rel);
                await context?.file?.(target.rel);
                return `Written ${target.rel}`;
            }
            case 'search_files': {
                const located = await resolveInside(root, String(args.path ?? '.'), { allowRoot: true });
                const query = String(args.query ?? '');
                const relDir = toPosix(path.relative(root, located.abs)) || '.';
                const scope = String(args.scope ?? (args.inContent === 0 || args.inContent === false ? 'path' : 'content'));
                const regex = Boolean(args.regex);
                const glob = String(args.glob ?? '');
                // The map answers the search without touching the disk; only the files it did
                // not read in full are looked at again.
                if (map?.enabled && query.trim()) {
                    const found = map.search({ query, dir: relDir, scope, regex, glob, maxResults: 200 });
                    const hits = found.text ? found.text.split('\n') : [];
                    for (const rel of found.partial) {
                        const body = await readFile(path.join(root, ...rel.split('/')), 'utf-8').catch(() => null);
                        if (body === null) continue;
                        const hit = regex ? new RegExp(query, 'i').test(body) : body.toLowerCase().includes(query.toLowerCase());
                        if (hit) hits.push(rel);
                    }
                    return hits.length ? hits.join('\n') : '(no matches)';
                }
                const files = await walk(located.abs, 6, []);
                const inContent = scope !== 'path' && scope !== 'symbol';
                const names = globMatcher(glob);
                // A pattern without a slash names the files, a pattern with a slash names the paths.
                const onName = !glob.trim().includes('/');
                let matcher = null;
                if (regex) {
                    try { matcher = new RegExp(query, 'i'); }
                    catch (error) { throw new Error(`The regular expression is wrong: ${error.message}`); }
                }
                const hits = [];
                for (const file of files) {
                    const rel = toPosix(path.relative(root, file));
                    if (names && !names.test(onName ? path.posix.basename(rel) : rel)) continue;
                    if (!inContent) {
                        const hit = matcher ? matcher.test(rel) : rel.toLowerCase().includes(query.toLowerCase());
                        if (hit) hits.push(rel);
                        continue;
                    }
                    const body = await readFile(file, 'utf-8').catch(() => null);
                    if (body === null) continue;
                    const hit = matcher ? matcher.test(body) : body.toLowerCase().includes(query.toLowerCase());
                    if (hit) hits.push(rel);
                    if (hits.length >= 200) break;
                }
                return hits.length ? hits.join('\n') : '(no matches)';
            }
            case 'call_ai_image': {
                const list = parseArgsList(args.args);
                const result = await runExternalCli('ai-image', list, {
                    root: packageRoot,
                    env,
                    cwd: root,
                    // The log of the sibling CLI comes live: the run shows what it does
                    // while it works.
                    onLine: (event) => notify?.({ type: 'bridge.log', name: 'ai-image', stream: event.stream, line: event.line }),
                });
                if (result.code !== 0) {
                    throw new Error(`ai-image exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
                }
                return (result.stdout.trim() || result.stderr.trim() || 'ai-image finished.');
            }
            case 'call_ai_decompose': {
                const list = parseArgsList(args.args);
                const result = await runExternalCli('ai-decompose', list, {
                    root: packageRoot,
                    env,
                    cwd: root,
                    onLine: (event) => notify?.({ type: 'bridge.log', name: 'ai-decompose', stream: event.stream, line: event.line }),
                });
                if (result.code !== 0) {
                    throw new Error(`ai-decompose exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
                }
                return (result.stdout.trim() || result.stderr.trim() || 'ai-decompose finished.');
            }
            default:
                return `Unknown tool: ${name}`;
        }
    }

    return {
        execute,
        specs,
        /**
         * The tool list of one role: the catalogue, cut down to what that role may call.
         * @param {string} roleName
         * @param {string[]|null} names
         * @returns {object[]}
         */
        specsFor(roleName, names = null) {
            const local = buildSpecs(config?.tools, { role: roleName, names });
            if (names) {
                const wanted = new Set(names);
                return [...local, ...mcpSpecs.filter((spec) => wanted.has(spec.name))];
            }
            return [...local, ...mcpSpecs];
        },
        /**
         * Open these directories for writing; every other path is refused.
         * @param {string[]} dirs
         */
        setWriteDirs(dirs) {
            allowed = (dirs ?? []).map((dir) => path.resolve(dir));
        },
        /** The directories the model may write into right now. */
        writeDirs() {
            return [...openDirs()];
        },
    };
}

/**
 * The contrast ratio of two colour descriptions.
 * @param {{ hex: string }} a
 * @param {{ hex: string }} b
 * @returns {number}
 * @ai.hint pure
 */
function contrastOf(a, b) {
    const parse = (entry) => {
        const clean = String(entry?.hex ?? entry ?? '').replace('#', '');
        const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
        const number = Number.parseInt(full, 16);
        if (!Number.isFinite(number)) return null;
        return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
    };
    const first = parse(a);
    const second = parse(b);
    if (!first || !second) return 1;
    return contrastRatio(first, second);
}

/**
 * The argument list of an external CLI: a JSON array of strings.
 * @param {unknown} raw
 * @returns {string[]}
 * @ai.hint pure
 */
function parseArgsList(raw) {
    if (Array.isArray(raw)) return raw.map((item) => String(item));
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch { /* not JSON: treat it as one argument */ }
    return [raw];
}
