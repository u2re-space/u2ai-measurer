/**
 * @file src/cli/renderer.js
 * @module cli/renderer
 * @purpose The terminal renderer: it turns the events of the pipeline into lines a person reads.
 * @exports createRenderer, createPlainRenderer, detectMode
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import { COLORS, paint } from './colors.js';
import { formatBridgeLine } from '../shared/child-log.js';

/**
 * Detect the output mode of the terminal.
 * @returns {'tty'|'pipe'}
 * @exports
 * @ai.hint pure
 */
export function detectMode() {
    return process.stdout.isTTY ? 'tty' : 'pipe';
}

/**
 * Print the plan of the run.
 * @param {object} event
 * @ai.hint io
 */
function printPlan(event) {
    console.log('Plan:');
    const references = Array.isArray(event.references) ? event.references : [];
    console.log(`  references: ${references.length ? references.join(', ') : '(none)'}`);
    for (const stage of event.stages ?? []) {
        console.log(`  ${stage.id}: ${stage.label}${stage.model ? ` [${stage.model}]` : ''}`);
    }
    for (const output of event.outputs ?? []) console.log(`  output: ${output}`);
}

/**
 * The short answer of a tool: what it read, what it wrote, what it sampled.
 *
 * The model sees the whole answer; the reader sees the shape of it — the path of the
 * picture, the colours with their share, the number of the lines of a file.
 * @param {string} name the name of the tool
 * @param {string} output the answer of the tool
 * @returns {string[]}
 * @ai.hint pure
 */
function toolSummary(name, output) {
    const text = String(output ?? '').trim();
    if (!text) return [];
    const lines = text.split('\n');
    if (name === 'sample_colors') {
        const colours = [...text.matchAll(/^\s*\d+\.\s+(#[0-9a-fA-F]{3,8})\b.*?share:\s*([\d.]+)%/gm)]
            .map((match) => `${match[1].toLowerCase()} ${match[2]}%`);
        const plate = text.match(/^\s*plate:\s*(\S+)/m)?.[1] ?? '';
        const contrast = text.match(/^\s*contrast plate vs the most different colour:\s*([\d.]+):1/m)?.[1] ?? '';
        return [
            lines[0].trim(),
            colours.length ? `colours: ${colours.join('  ')}` : null,
            plate ? `plate: ${plate}${contrast ? `, contrast ${contrast}:1` : ''}` : null,
        ].filter(Boolean);
    }
    if (name === 'list_files') {
        const files = lines.filter(Boolean);
        return [`${files.length} file(s)`, ...files.slice(0, 10).map((file) => `  ${file}`)];
    }
    if (name === 'read_file') {
        return [
            `${lines.length} line(s), ${text.length} chars`,
            ...lines.slice(0, 5).map((line) => `  ${line.slice(0, 120)}`),
        ];
    }
    return lines.slice(0, 3).map((line) => line.slice(0, 160));
}

/**
 * The lines every renderer shares.
 * @param {object} e the event
 * @param {{ verbose?: boolean }} options
 * @returns {Array<{ text: string, level: 'log'|'warn'|'error' }>}
 * @ai.hint pure
 */
function linesOf(e, { verbose = false } = {}) {
    switch (e.type) {
        case 'plan':
            return [];
        case 'references':
            return (e.items ?? []).map((item) => ({
                text: `  reference: ${item.path} (${item.kind})`,
                level: 'log',
            }));
        case 'stage.start':
            return [{ text: `[${e.stage}] ${e.label ?? e.stage}`, level: 'log' }];
        case 'stage.done':
            return [{ text: `[${e.stage}] done`, level: 'log' }];
        case 'stage.error':
            return [{ text: `[${e.stage}] failed: ${e.error}`, level: 'error' }];
        case 'measure.pass':
            return [{ text: `  pass ${e.pass} of ${e.of}`, level: 'log' }];
        case 'measure.sheet': {
            const canvas = e.canvas?.width && e.canvas?.height ? `, canvas ${e.canvas.width}×${e.canvas.height}` : '';
            const lines = [{
                text: `  sheet: ${e.elements ?? 0} elements, ${e.regions ?? 0} regions, ${e.rules ?? 0} rules${canvas}`,
                level: 'log',
            }];
            for (const colour of e.colors ?? []) {
                const share = Number.isFinite(colour.share) ? ` ${(colour.share * 100).toFixed(1)}%` : '';
                lines.push({
                    text: `  colour: ${colour.name || '—'} ${colour.hex || '—'}${share} ${colour.method || ''}${colour.confidence ? ` (${colour.confidence})` : ''}`,
                    level: 'log',
                });
            }
            return lines;
        }
        case 'measure.crops':
            return (e.crops ?? []).map((crop) => ({
                text: `  crop: ${crop.crop} — ${crop.kind} "${crop.name}"`,
                level: 'log',
            }));
        case 'segment.zones':
            return [{ text: `  zones: ${e.zones ?? 0} in ${e.source ?? ''}`, level: 'log' }];
        case 'crop.done':
            return (e.crops ?? []).map((crop) => ({
                text: `  fragment: ${crop.crop} — ${crop.kind} "${crop.name}"`,
                level: 'log',
            }));
        case 'artifact':
            return [{
                text: `  written: ${e.file} (${Math.round((e.bytes ?? 0) / 1024)} kB)`,
                level: 'log',
            }];
        case 'design.start':
            return [{ text: `  references: ${e.references ?? 0}${e.designMd ? ', DESIGN.md read' : ''}`, level: 'log' }];
        case 'design.done':
            return e.template ? [{ text: `  template: ${e.template}`, level: 'log' }] : [];
        case 'resolve.done':
            return [
                { text: `  files: ${(e.files ?? []).length}`, level: 'log' },
                { text: `  tokens: ${e.tokens ?? 0}`, level: 'log' },
                ...(e.files ?? []).map((file) => ({ text: `  output: ${file}`, level: 'log' })),
            ];
        case 'warning':
            return [{ text: `warning: ${e.message}`, level: 'warn' }];
        case 'request.wait': {
            const seconds = Math.max(1, Math.round((e.elapsedMs ?? 0) / 1000));
            return [{ text: `  thinking (${seconds}s)`, level: 'log' }];
        }
        case 'request.retry':
            return [{
                text: `  retry ${e.attempt ?? ''}${e.error ? `: ${e.error}` : ''}`,
                level: 'warn',
            }];
        case 'request.error':
            return [{
                text: `  request failed${e.status ? ` (${e.status})` : ''}: ${e.error ?? ''}`,
                level: 'warn',
            }];
        case 'tool.call': {
            const args = e.arguments && typeof e.arguments === 'object' ? e.arguments : {};
            const detail = Object.entries(args)
                .filter(([, value]) => value !== undefined && value !== null && value !== '')
                .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
                .join(' ');
            return [{ text: `  tool: ${e.name ?? ''}${detail ? ` ${detail}` : ''}`, level: 'log' }];
        }
        case 'tool.result': {
            if (verbose) {
                return String(e.output ?? '')
                    .split('\n')
                    .slice(0, 12)
                    .map((line) => ({ text: `    ${line}`, level: 'log' }));
            }
            return toolSummary(e.name ?? '', e.output ?? '').map((line) => ({ text: `    ${line}`, level: 'log' }));
        }
        case 'bridge.log': {
            // The log of a sibling CLI: it comes live, while the CLI works.
            const text = formatBridgeLine(e.name, e.line);
            if (!text) return [];
            return [{ text: `  ${text}`, level: e.stream === 'stderr' ? 'warn' : 'log' }];
        }
        case 'request.start':
            return verbose ? [{ text: `  [request] ${e.backend ?? ''} ${e.path ?? ''}`, level: 'log' }] : [];
        case 'api':
            return verbose ? [{ text: `  [api] ${e.type ?? ''} ${JSON.stringify(e)}`, level: 'log' }] : [];
        default:
            return verbose ? [{ text: `  [${e.type}] ${JSON.stringify(e)}`, level: 'log' }] : [];
    }
}

/**
 * A renderer without colors, for a pipe.
 *
 * A run whose output is piped somewhere — a CI log, a file, another program — has to leave
 * something behind. The colored renderer is for a person at a terminal; this one is for the
 * reader on the other side of the pipe.
 *
 * @param {{ verbose?: boolean }} opts
 * @returns {{ event: (e: object) => void }}
 * @exports
 * @ai.hint io
 */
export function createPlainRenderer({ verbose = false } = {}) {
    function event(e) {
        if (!e || !e.type) return;
        if (e.type === 'plan') {
            printPlan(e);
            return;
        }
        for (const line of linesOf(e, { verbose })) {
            if (line.level === 'error') console.error(line.text);
            else if (line.level === 'warn') console.warn(line.text);
            else console.log(line.text);
        }
    }
    return { event };
}

/**
 * The colored renderer for a terminal.
 * @param {{ verbose?: boolean }} opts
 * @returns {{ event: (e: object) => void }}
 * @exports
 * @ai.hint io
 */
export function createRenderer({ verbose = false } = {}) {
    function event(e) {
        if (!e || !e.type) return;
        if (e.type === 'plan') {
            printPlan(e);
            return;
        }
        for (const line of linesOf(e, { verbose })) {
            if (line.level === 'error') console.error(paint(`  ✗ ${line.text}`, COLORS.red));
            else if (line.level === 'warn') console.warn(paint(`  ⚠ ${line.text}`, COLORS.yellow));
            else if (line.text.startsWith('[')) console.log(paint(`▶ ${line.text}`, COLORS.cyan));
            else console.log(paint(line.text, COLORS.dim));
        }
    }
    return { event };
}
