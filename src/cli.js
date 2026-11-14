/**
 * @file src/cli.js
 * @module cli
 * @purpose Parse argv, dispatch the commands, and map the failures to the exit codes.
 * @depends node:util, node:path, node:fs/promises, config, openai/client, shared/pipeline,
 *          cli/renderer, cli/compatibility, help, image/sharp, image/colors, image/crop,
 *          agent/documentation, agent/skills, stages/resolve
 * @exports HELP, parseArgv, main
 * @ai.tags cli, dispatch
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig, redactConfig, ENUMS } from './config.js';
import { createClient, resolveBackends } from './openai/client.js';
import { createRenderer, createPlainRenderer, detectMode } from './cli/renderer.js';
import { checkNodeVersion } from './cli/compatibility.js';
import { HELP, COMMAND_NAMES } from './help.js';
import { runPipeline } from './shared/pipeline.js';
import { sampleColors } from './image/colors.js';
import { rasterCrop, rasterInfo, rasterSplit } from './image/sharp.js';
import { clampRect } from './image/crop.js';
import { documentationFor, documentationNames } from './agent/documentation.js';
import { listSkillPacks } from './agent/skills.js';
import { buildPalette, buildTokens } from './stages/resolve.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** The exit codes of the CLI. */
export const EXIT = Object.freeze({ ok: 0, failure: 1, usage: 2, aborted: 130 });

/** The stages that look at a picture: without one they have nothing to read. */
const PICTURE_STAGES = Object.freeze(new Set(['segmentate', 'crop', 'measure', 'recognize', 'sample']));

/**
 * Whether a stage asks the model for something.
 *
 * The crop stage asks the cropper only in the `ai` mode; in the `local` mode the harness cuts
 * the fragments the segmentation named. The resolve stage asks the resolver only in the `ai`
 * mode; in the `local` mode the harness joins the parts itself. The sampler always asks: the
 * model names the colours the harness read.
 * @param {string} id the stage id
 * @param {object} config the resolved configuration
 * @returns {boolean}
 * @ai.hint pure
 */
function stageAsksModel(id, config) {
    if (id === 'design') return true;
    if (id === 'crop') return (config?.stages?.crop?.mode ?? 'local') === 'ai';
    if (id === 'resolve') return (config?.stages?.resolve?.mode ?? 'local') === 'ai';
    return PICTURE_STAGES.has(id);
}

/**
 * Parse the arguments of the CLI.
 *
 * The first positional is the command when it names one; anything else is an input of the
 * command, so `ai-measure screen.png` means `ai-measure measure screen.png`.
 *
 * @param {string[]} argv
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function parseArgv(argv) {
    const parsed = parseArgs({
        options: {
            image: { type: 'string', multiple: true, short: 'i' },
            out: { type: 'string', short: 'o' },
            config: { type: 'string', short: 'c' },
            stages: { type: 'string', multiple: true },
            model: { type: 'string', short: 'm' },
            effort: { type: 'string' },
            task: { type: 'string' },
            colors: { type: 'string', short: 'k' },
            x: { type: 'string' },
            y: { type: 'string' },
            width: { type: 'string', short: 'w' },
            height: { type: 'string' },
            output: { type: 'string' },
            rows: { type: 'string' },
            cols: { type: 'string' },
            'out-dir': { type: 'string' },
            verbose: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            version: { type: 'boolean', short: 'v', default: false },
        },
        strict: false,
        allowPositionals: true,
        args: argv,
    });

    const positionals = [...parsed.positionals];
    let command = 'measure';
    if (positionals.length && COMMAND_NAMES.includes(positionals[0])) {
        command = positionals.shift();
    }
    const images = [...(parsed.values.image ?? []), ...positionals];

    const stages = (parsed.values.stages ?? [])
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter(Boolean);

    return {
        command,
        images,
        out: parsed.values.out ?? null,
        outDir: parsed.values['out-dir'] ?? null,
        configPath: parsed.values.config ?? null,
        stages,
        model: parsed.values.model ?? null,
        effort: parsed.values.effort ?? null,
        task: parsed.values.task ?? null,
        colors: parsed.values.colors ?? null,
        x: parsed.values.x ?? null,
        y: parsed.values.y ?? null,
        width: parsed.values.width ?? null,
        height: parsed.values.height ?? null,
        output: parsed.values.output ?? null,
        rows: parsed.values.rows ?? null,
        cols: parsed.values.cols ?? null,
        verbose: parsed.values.verbose === true,
        dryRun: parsed.values['dry-run'] === true,
        help: parsed.values.help === true,
        version: parsed.values.version === true,
    };
}

/**
 * Is there a key to call the API with?
 *
 * A local server may work without one; a remote host may not, and the difference is worth a
 * sentence before the run starts rather than a 401 in the middle of it.
 *
 * @param {object} config
 * @param {object} [env]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function apiKeyAvailable(config, env = process.env) {
    const chain = resolveBackends(config, { kind: 'text', env });
    if (chain.some((item) => item.apiKey)) return true;
    return chain.length > 0 && chain.every((item) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(item.baseURL));
}

/**
 * A usage error: the message goes to stderr and the exit code is 2.
 * @param {string} message
 * @returns {number}
 * @ai.hint io
 */
function usage(message) {
    console.error(message);
    console.error('Run `ai-measure --help` for the commands and the options.');
    return EXIT.usage;
}

/**
 * The `palette` command: sample the colours of a picture. No model, no API key.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandPalette(opts) {
    const file = opts.images[0];
    if (!file) return usage('The palette command needs a picture.');
    const abs = path.resolve(process.cwd(), file);
    const info = await rasterInfo(abs).catch(() => null);
    if (!info) return EXIT.failure;
    const result = await sampleColors({
        abs,
        k: Math.max(1, Number(opts.colors) || 5),
        engine: 'auto',
    });
    console.log(`${file} — ${info.width}×${info.height}`);
    for (const color of result.colors) {
        console.log(`  ${color.hex}  oklch: ${color.oklch}  hsl: ${color.hsl}  share: ${(Number(color.share ?? 0) * 100).toFixed(1)}%`);
    }
    if (result.background) console.log(`  plate: ${result.background.hex}`);
    for (const warning of result.warnings ?? []) console.warn(`  warning: ${warning}`);
    return EXIT.ok;
}

/**
 * The `crop` command: cut a rectangle out of a picture. No model.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandCrop(opts) {
    const file = opts.images[0];
    if (!file) return usage('The crop command needs a picture.');
    const abs = path.resolve(process.cwd(), file);
    const info = await rasterInfo(abs).catch(() => null);
    if (!info) return EXIT.failure;
    const width = Number(opts.width);
    const height = Number(opts.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return usage('The crop command needs --width and --height.');
    }
    const box = clampRect({ x: Number(opts.x) || 0, y: Number(opts.y) || 0, width, height }, info);
    const parsed = path.parse(abs);
    const output = path.resolve(process.cwd(), opts.output ?? path.join(parsed.dir, `${parsed.name}-crop.png`));
    await mkdir(path.dirname(output), { recursive: true });
    await rasterCrop({ input: abs, output, ...box });
    console.log(`Cropped to ${path.relative(process.cwd(), output) || output} (${box.width}×${box.height})`);
    return EXIT.ok;
}

/**
 * The `split` command: cut a picture into a grid of tiles. No model.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandSplit(opts) {
    const file = opts.images[0];
    if (!file) return usage('The split command needs a picture.');
    const abs = path.resolve(process.cwd(), file);
    const info = await rasterInfo(abs).catch(() => null);
    if (!info) return EXIT.failure;
    const outDir = path.resolve(process.cwd(), opts.outDir ?? '.');
    await mkdir(outDir, { recursive: true });
    const tiles = await rasterSplit({
        input: abs,
        outputDir: outDir,
        rows: Math.max(1, Number(opts.rows) || 1),
        cols: Math.max(1, Number(opts.cols) || 1),
        baseName: path.parse(file).name,
    });
    console.log(`Split into ${tiles.length} tiles in ${path.relative(process.cwd(), outDir) || outDir}`);
    return EXIT.ok;
}

/**
 * The `tokens` command: the CSS tokens of a measurement sheet.
 * @param {object} opts
 * @param {object} config
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandTokens(opts, config) {
    const file = opts.images[0]
        ?? path.join(opts.out ?? config?.output?.dir ?? './measurements', 'measurements.json');
    const abs = path.resolve(process.cwd(), file);
    const sheet = await readFile(abs, 'utf-8')
        .then((text) => JSON.parse(text))
        .catch(() => null);
    if (!sheet) {
        console.error(`The measurements ${file} could not be read.`);
        return EXIT.failure;
    }
    const { css, tokens } = buildTokens(sheet, buildPalette(sheet));
    if (opts.output) {
        const output = path.resolve(process.cwd(), opts.output);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, css, 'utf-8');
        console.log(`Wrote ${tokens.length} tokens to ${path.relative(process.cwd(), output) || output}`);
    } else {
        console.log(css.trimEnd());
    }
    return EXIT.ok;
}

/**
 * The `docs` command: the standards the roles are given.
 * @param {object} opts
 * @returns {number}
 * @ai.hint io
 */
function commandDocs(opts) {
    const names = opts.images.length ? opts.images : documentationNames();
    const unknown = names.filter((name) => !documentationNames().includes(name));
    if (unknown.length) return usage(`Unknown documentation: ${unknown.join(', ')}.`);
    const text = documentationFor(names);
    if (!text.trim()) return usage('No documentation was found for these names.');
    console.log(text);
    return EXIT.ok;
}

/**
 * The `config` command: the resolved configuration.
 * @param {object} config
 * @returns {number}
 * @ai.hint io
 */
function commandConfig(config) {
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return EXIT.ok;
}

/**
 * The `skills` command: the skill packs of the home directory.
 * @param {object} config
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandSkills(config) {
    const packs = await listSkillPacks({ dir: config?.skills?.dir ?? null });
    if (!packs.length) {
        console.log('No skill packs found. Put markdown files into ~/.ai-measure/skills.');
        return EXIT.ok;
    }
    for (const pack of packs) {
        const files = pack.files?.length ? ` (${pack.files.join(', ')})` : '';
        console.log(`  ${pack.name} — ${pack.bytes} bytes${files}`);
    }
    return EXIT.ok;
}

/**
 * Main entry point: parse the arguments, load the config, dispatch the command.
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export async function main(argv = process.argv.slice(2)) {
    // A run that dies must say so.
    //
    // A thinking model works for minutes, and the process may be killed or may fall over
    // somewhere deep inside the transport. Without this the terminal stays empty and the exit
    // code is the only witness: a silent death is the hardest kind of failure to read.
    process.on('unhandledRejection', (reason) => {
        console.error(`Unhandled rejection: ${reason?.message ?? reason}`);
    });
    process.on('uncaughtException', (error) => {
        console.error(`Uncaught exception: ${error?.message ?? error}`);
    });

    const opts = parseArgv(argv);
    if (opts.help) {
        console.log(HELP);
        return EXIT.ok;
    }
    if (opts.version) {
        console.log(pkg.version);
        return EXIT.ok;
    }

    const runtime = checkNodeVersion();
    if (!runtime.ok) {
        console.error(`Node.js ${runtime.required} is required, this is ${runtime.version}.`);
        return EXIT.failure;
    }

    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd: process.cwd() });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    // The local commands: no model, no API key.
    switch (opts.command) {
        case 'palette':
            return await commandPalette(opts);
        case 'crop':
            return await commandCrop(opts);
        case 'split':
            return await commandSplit(opts);
        case 'tokens':
            return await commandTokens(opts, config);
        case 'docs':
            return commandDocs(opts);
        case 'config':
            return commandConfig(config);
        case 'skills':
            return await commandSkills(config);
        default:
            break;
    }

    // The commands that talk to the model.
    const unknownStages = opts.stages.filter((stage) => !ENUMS.stages.includes(stage));
    if (unknownStages.length) {
        return usage(`Unknown stage: ${unknownStages.join(', ')}. The stages are: ${ENUMS.stages.join(', ')}.`);
    }

    // The design stage is the whole of the `design` command; `measure` runs the whole pipeline.
    const stages = opts.command === 'design'
        ? ['design']
        : (opts.stages.length ? opts.stages : null);

    // A picture is needed by the stages that look at one. The resolve stage only reads the
    // artifacts of the stages before it, so it runs without a picture.
    const selected = stages ?? ENUMS.stages;
    const needsPicture = selected.some((id) => PICTURE_STAGES.has(id));
    if (needsPicture && !opts.images.length) {
        return usage(`The ${opts.command} command needs at least one picture.`);
    }

    // The key is needed by the stages that ask the model. The local stages — the harness cuts
    // the fragments, reads the pixels and joins the parts — run without a key.
    const asksModel = selected.some((id) => stageAsksModel(id, config));
    if (!opts.dryRun && asksModel && !apiKeyAvailable(config)) {
        console.error('No API key: set AI_MEASURE_API_KEY, put "apiKey" into ~/.ai-measure/config.json, '
            + 'or give a backend the name of an environment variable that holds the key.');
        return EXIT.failure;
    }

    const isTTY = detectMode() === 'tty';
    const renderer = isTTY
        ? createRenderer({ verbose: opts.verbose })
        : createPlainRenderer({ verbose: opts.verbose });

    try {
        const client = await createClient({
            config,
            signal: null,
            // The events of the client go straight to the renderer: the heartbeat of a waiting
            // request and a failed backend are part of what the reader has to see.
            onEvent: (event) => renderer.event(event),
        });
        const result = await runPipeline({
            root: process.cwd(),
            images: opts.images,
            outDir: opts.out,
            stages,
            config,
            client,
            model: opts.model,
            effort: opts.effort,
            task: opts.task ?? '',
            dryRun: opts.dryRun,
            notify: (event) => renderer.event(event),
        });
        return result?.failed ? EXIT.failure : EXIT.ok;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.error('Aborted.');
            return EXIT.aborted;
        }
        console.error(`Error: ${error?.message ?? error}`);
        return EXIT.failure;
    }
}
