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
 *          agent/tool-specs, agent/paths
 * @exports createToolset, toolSpecs, enabledToolNames, resolveExternalCli, externalCliCandidates
 * @ai.tags tools, agent, external
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rasterInfo, rasterCrop, rasterSplit } from '../image/sharp.js';
import { sampleColors, contrastRatio } from '../image/colors.js';
import { clampRect } from '../image/crop.js';
import { toolSpecs as buildSpecs } from './tool-specs.js';
import { isInside, resolveInside, toPosix } from './paths.js';

export { toolSpecs, enabledToolNames } from './tool-specs.js';

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
 * @param {keyof typeof EXTERNAL_CLIS} name
 * @param {string[]} args
 * @param {{ root?: string, env?: object, cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 * @exports
 * @ai.hint io
 */
export async function runExternalCli(name, args, { root = PACKAGE_ROOT, env = process.env, cwd = PACKAGE_ROOT, timeoutMs = 600_000 } = {}) {
    const found = await resolveExternalCli(name, { root, env });
    if (!found) throw new Error(`The external CLI "${name}" is not installed: set ${EXTERNAL_CLIS[name]?.env ?? 'the path'} or install ${EXTERNAL_CLIS[name]?.package ?? 'the package'}.`);
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
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); });
    });
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
 * @param {{ root: string, config: object, role?: string|null, mcp?: object[],
 *   writeDirs?: string[], env?: object, packageRoot?: string }} opts
 * @returns {{ execute: (name: string, args: object) => Promise<string>, specs: object[], setWriteDirs: Function, writeDirs: Function }}
 */
export function createToolset({ root, config, role = null, mcp = [], writeDirs = null, env = process.env, packageRoot = PACKAGE_ROOT }) {
    const mcpTools = mcpToolEntries(mcp);
    const mcpSpecs = mcpTools.map((entry) => ({
        type: 'function',
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
    }));
    const specs = [...buildSpecs(config?.tools, { role }), ...mcpSpecs];
    let allowed = (writeDirs ?? [root]).map((dir) => path.resolve(dir));

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
     * @param {string} value
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    async function writePath(value) {
        const located = await resolveInside(root, String(value ?? ''), { forWrite: true, allowRoot: false });
        if (!allowed.some((dir) => isInside(dir, located.abs))) {
            throw new Error(`Writing outside the output directory is forbidden: ${located.rel}`);
        }
        return located;
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
        switch (name) {
            case 'view_image': {
                const located = await readPath(args.path);
                const info = await rasterInfo(located.abs);
                return `Image ${located.rel}: ${info.width}×${info.height} ${info.format ?? ''}`;
            }
            case 'crop_image': {
                const located = await readPath(args.path);
                const parsed = path.parse(located.abs);
                const fallback = path.join(parsed.dir, `${parsed.name}-crop.png`);
                const target = await writePath(args.output ?? fallback);
                const info = await rasterInfo(located.abs);
                const box = clampRect(args, info);
                await rasterCrop({ input: located.abs, output: target.abs, ...box });
                return `Cropped to ${target.rel} (${box.width}×${box.height})`;
            }
            case 'split_image': {
                const located = await readPath(args.path);
                const outDir = await writePath(args.outputDir ?? '.');
                await mkdir(outDir.abs, { recursive: true });
                const tiles = await rasterSplit({
                    input: located.abs,
                    outputDir: outDir.abs,
                    rows: Math.max(1, Number(args.rows) || 1),
                    cols: Math.max(1, Number(args.cols) || 1),
                    baseName: 'tile',
                });
                return `Split into ${tiles.length} tiles in ${outDir.rel}`;
            }
            case 'sample_colors': {
                const located = await readPath(args.path);
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
            case 'list_files': {
                const located = await resolveInside(root, String(args.path ?? '.'), { allowRoot: true });
                const depth = Math.max(1, Number(args.depth) || 1);
                const files = await walk(located.abs, depth, []);
                const lines = files
                    .map((file) => toPosix(path.relative(root, file)))
                    .sort()
                    .slice(0, 500);
                return lines.length ? lines.join('\n') : '(no files)';
            }
            case 'read_file': {
                const located = await readPath(args.path);
                return await readFile(located.abs, 'utf-8');
            }
            case 'write_file': {
                const target = await writePath(args.path);
                await mkdir(path.dirname(target.abs), { recursive: true });
                await writeFile(target.abs, String(args.content ?? ''), 'utf-8');
                return `Written ${target.rel}`;
            }
            case 'search_files': {
                const located = await resolveInside(root, String(args.path ?? '.'), { allowRoot: true });
                const query = String(args.query ?? '');
                const files = await walk(located.abs, 6, []);
                const inContent = args.inContent !== 0 && args.inContent !== false;
                const hits = [];
                for (const file of files) {
                    const rel = toPosix(path.relative(root, file));
                    if (!inContent) {
                        if (rel.toLowerCase().includes(query.toLowerCase())) hits.push(rel);
                        continue;
                    }
                    const body = await readFile(file, 'utf-8').catch(() => null);
                    if (body && body.toLowerCase().includes(query.toLowerCase())) hits.push(rel);
                    if (hits.length >= 200) break;
                }
                return hits.length ? hits.join('\n') : '(no matches)';
            }
            case 'call_ai_image': {
                const list = parseArgsList(args.args);
                const result = await runExternalCli('ai-image', list, { root: packageRoot, env, cwd: root });
                if (result.code !== 0) {
                    throw new Error(`ai-image exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
                }
                return (result.stdout.trim() || result.stderr.trim() || 'ai-image finished.');
            }
            case 'call_ai_decompose': {
                const list = parseArgsList(args.args);
                const result = await runExternalCli('ai-decompose', list, { root: packageRoot, env, cwd: root });
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
            return [...allowed];
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
