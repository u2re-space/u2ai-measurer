/**
 * @file src/cli/renderer.js
 * @module cli/renderer
 * @purpose The terminal renderer: it turns the events of the pipeline into lines a person reads.
 * @exports createRenderer, createPlainRenderer, detectMode
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import { COLORS, paint } from './colors.js';

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
        case 'stage.start':
            return [{ text: `[${e.stage}] ${e.label ?? e.stage}`, level: 'log' }];
        case 'stage.done':
            return [{ text: `[${e.stage}] done`, level: 'log' }];
        case 'stage.error':
            return [{ text: `[${e.stage}] failed: ${e.error}`, level: 'error' }];
        case 'measure.pass':
            return [{ text: `  pass ${e.pass} of ${e.of}`, level: 'log' }];
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
