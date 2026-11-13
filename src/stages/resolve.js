/**
 * @file src/stages/resolve.js
 * @module stages/resolve
 * @purpose Stage `resolve`: turn the measurement sheet into the files a coder can use.
 *
 * The sheet is the answer of the measurer; the files are the answer of the CLI:
 *   - `measurements.json` — the sheet itself, with the crops and the conclusion;
 *   - `palette.json` — the colours of the reference, with their hex, OKLCH and contrast notes;
 *   - `tokens.css` — the colours and the repeated measures as CSS custom properties;
 *   - `DESIGN.md` — the same tokens as a document a person reads;
 *   - `report.md` — what was measured, what is uncertain and which crops exist.
 *
 * Every number in these files comes from the sheet. Nothing is invented here: a value the
 * measurer did not measure does not become a token.
 *
 * @depends node:path, node:fs/promises, stages/crop
 * @usedBy shared/pipeline
 * @exports runResolve, buildPalette, buildTokens, buildDesignMd, buildReport,
 *          MEASUREMENTS_FILE, PALETTE_FILE, TOKENS_FILE, DESIGN_MD_FILE, REPORT_FILE
 * @ai.tags output, tokens, palette
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { cropSlug } from './crop.js';
import { toPosix } from '../agent/paths.js';

/** The names of the artifacts, inside the output directory. */
export const MEASUREMENTS_FILE = 'measurements.json';
export const PALETTE_FILE = 'palette.json';
export const TOKENS_FILE = 'tokens.css';
export const DESIGN_MD_FILE = 'DESIGN.md';
export const REPORT_FILE = 'report.md';

/**
 * A token name a person can read: Latin letters, digits and dashes.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
function tokenSlug(value, fallback = 'token') {
    return cropSlug(value, fallback).replace(/-/g, '_');
}

/**
 * The palette of the reference: the colours the sheet relies on.
 *
 * @param {object} sheet the measurement sheet
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function buildPalette(sheet) {
    const colors = Array.isArray(sheet?.colors?.palette) ? sheet.colors.palette : [];
    const palette = {
        name: 'reference',
        source: String(sheet?.source ?? ''),
        background: sheet?.colors?.background ?? null,
        text: sheet?.colors?.text ?? null,
        accent: sheet?.colors?.accent ?? null,
        colorSpace: sheet?.colors?.colorSpace ?? null,
        colors: colors.map((item) => ({
            name: String(item?.name ?? ''),
            token: `--color-${tokenSlug(item?.name, 'color')}`,
            hex: String(item?.hex ?? ''),
            oklch: String(item?.oklch ?? ''),
            hsl: String(item?.hsl ?? ''),
            rgb: String(item?.rgb ?? ''),
            luminance: Number.isFinite(item?.luminance) ? item.luminance : null,
            share: Number.isFinite(item?.share) ? item.share : null,
            method: String(item?.method ?? ''),
            confidence: String(item?.confidence ?? 'unknown'),
            source: item?.source ?? null,
            notes: String(item?.notes ?? ''),
        })),
        notes: String(sheet?.colors?.notes ?? ''),
    };
    return palette;
}

/**
 * The CSS custom properties of the reference.
 *
 * The colours come from the palette; the other tokens come from the repeated measures of the
 * sheet, which already carry their CSS form (`--space-2: 0.5rem`).
 *
 * @param {object} sheet the measurement sheet
 * @param {object} [palette] the palette, when it was built already
 * @returns {{ css: string, tokens: Array<{ name: string, value: string, source: string }> }}
 * @exports
 * @ai.hint pure
 */
export function buildTokens(sheet, palette = null) {
    const pal = palette ?? buildPalette(sheet);
    const colors = pal.colors;
    const rules = Array.isArray(sheet?.rules) ? sheet.rules : [];
    const tokens = [];
    const seen = new Set();

    /**
     * Add one token, keeping the first value of a name.
     * @param {string} name
     * @param {string} value
     * @param {string} source
     */
    const add = (name, value, source) => {
        const clean = String(name ?? '').trim();
        const text = String(value ?? '').trim();
        if (!clean || !text || seen.has(clean)) return;
        seen.add(clean);
        tokens.push({ name: clean, value: text, source });
    };

    for (const color of colors) {
        if (!color.hex) continue;
        add(color.token || `--color-${tokenSlug(color.name, 'color')}`, color.hex, 'colour');
    }
    if (pal.background) add('--color-background', pal.background, 'colour');
    if (pal.text) add('--color-text', pal.text, 'colour');
    if (pal.accent) add('--color-accent', pal.accent, 'colour');

    for (const rule of rules) {
        const css = String(rule?.css ?? '').trim();
        const name = String(rule?.name ?? '').trim();
        if (css.includes(':')) {
            // The rule already carries its own declaration: `--space-2: 0.5rem`.
            const [key, ...rest] = css.split(':');
            add(key.trim(), rest.join(':').trim().replace(/;$/, ''), 'rule');
            continue;
        }
        const value = Number.isFinite(rule?.value) ? rule.value : null;
        if (value === null || !name) continue;
        add(`--${tokenSlug(name, 'rule')}`, `${value}${String(rule?.unit ?? '').trim()}`, 'rule');
    }

    const lines = tokens.map((token) => `  ${token.name}: ${token.value};`);
    const css = [
        '/* Generated by ai-measure from the measured reference. */',
        ':root {',
        ...lines,
        '}',
        '',
    ].join('\n');
    return { css, tokens };
}

/**
 * The `DESIGN.md` of the measurement: the tokens as a document.
 *
 * @param {object} sheet the measurement sheet
 * @param {object} [palette] the palette
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function buildDesignMd(sheet, palette = null) {
    const colors = (palette ?? buildPalette(sheet)).colors;
    const rules = Array.isArray(sheet?.rules) ? sheet.rules : [];
    const assumptions = Array.isArray(sheet?.assumptions) ? sheet.assumptions : [];

    const lines = [
        '# Design tokens',
        '',
        `Measured from \`${String(sheet?.source ?? 'the reference')}\`. Every value below was read from the reference; `
        + 'nothing here is a guess.',
        '',
        '## Colours',
        '',
    ];
    if (colors.length) {
        lines.push('| Token | Hex | OKLCH | Method | Confidence |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const color of colors) {
            lines.push(`| \`${color.token}\` | \`${color.hex || '—'}\` | \`${color.oklch || '—'}\` | ${color.method || '—'} | ${color.confidence} |`);
        }
    } else {
        lines.push('_No colour was measured._');
    }

    lines.push('', '## Spacing and rules', '');
    if (rules.length) {
        lines.push('| Rule | Value | CSS |');
        lines.push('| --- | --- | --- |');
        for (const rule of rules) {
            const value = Number.isFinite(rule?.value) ? `${rule.value}${String(rule?.unit ?? '')}` : '—';
            lines.push(`| ${String(rule?.name ?? '—')} | ${value} | \`${String(rule?.css ?? '—')}\` |`);
        }
    } else {
        lines.push('_No repeated measure was found._');
    }

    const units = sheet?.units ?? null;
    lines.push('', '## Units', '');
    lines.push(`- Source unit: ${String(units?.source ?? sheet?.unit ?? 'px')}`);
    lines.push(`- Root font size: ${Number.isFinite(units?.rootFontSize) ? `${units.rootFontSize}px` : 'not established'}`);
    lines.push(`- Preferred CSS units: ${(units?.preferred ?? []).join(', ') || '—'}`);
    if (units?.notes) lines.push(`- Notes: ${units.notes}`);

    if (assumptions.length) {
        lines.push('', '## Assumptions', '');
        for (const item of assumptions) lines.push(`- ${item}`);
    }
    if (sheet?.notes) {
        lines.push('', '## Notes', '', String(sheet.notes));
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * The markdown report of the run: what was measured, how certain it is and what was cut.
 *
 * @param {object} sheet the measurement sheet
 * @param {object} [options] the crops and the conclusion of the stage
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function buildReport(sheet, { crops = [], conclusion = null } = {}) {
    const elements = Array.isArray(sheet?.elements) ? sheet.elements : [];
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    const lines = [
        `# Measurement report`,
        '',
        `**Source:** ${String(sheet?.source ?? '—')}  `,
        `**Unit:** ${String(sheet?.unit ?? 'px')}  `,
        `**Confidence:** ${String(sheet?.confidence ?? 'unknown')}  `,
        `**Canvas:** ${sheet?.canvas?.width && sheet?.canvas?.height ? `${sheet.canvas.width}×${sheet.canvas.height}` : '—'}`,
        '',
    ];
    if (sheet?.summary) lines.push(sheet.summary, '');

    lines.push('## Counts', '');
    lines.push(`- Elements: ${elements.length}`);
    lines.push(`- Regions: ${regions.length}`);
    lines.push(`- Rules: ${Array.isArray(sheet?.rules) ? sheet.rules.length : 0}`);
    lines.push(`- Crops: ${crops.length}`);
    if (conclusion?.counts?.lowConfidence) lines.push(`- Low-confidence elements: ${conclusion.counts.lowConfidence}`);
    lines.push('');

    if (elements.length) {
        lines.push('## Elements', '');
        lines.push('| Name | Kind | Box | CSS | Confidence |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const item of elements) {
            const box = item?.box ?? {};
            const frame = [box.x, box.y, box.width, box.height]
                .every((value) => Number.isFinite(value))
                ? `${box.width}×${box.height} at ${box.x},${box.y}`
                : '—';
            lines.push(`| ${String(item?.name ?? '—')} | ${String(item?.kind ?? '—')} | ${frame} | \`${String(item?.css ?? '')}\` | ${String(item?.confidence ?? 'unknown')} |`);
        }
        lines.push('');
    }

    if (regions.length) {
        lines.push('## Regions', '');
        lines.push('| Name | Kind | Box | Crop |');
        lines.push('| --- | --- | --- | --- |');
        for (const item of regions) {
            const box = item?.box ?? {};
            const frame = [box.x, box.y, box.width, box.height]
                .every((value) => Number.isFinite(value))
                ? `${box.width}×${box.height} at ${box.x},${box.y}`
                : '—';
            lines.push(`| ${String(item?.name ?? '—')} | ${String(item?.kind ?? '—')} | ${frame} | \`${String(item?.crop ?? '')}\` |`);
        }
        lines.push('');
    }

    if (crops.length) {
        lines.push('## Crops', '');
        for (const item of crops) {
            lines.push(`- \`${String(item?.crop ?? '')}\` — ${String(item?.kind ?? '')} “${String(item?.name ?? '')}”`);
        }
        lines.push('');
    }

    const assumptions = Array.isArray(sheet?.assumptions) ? sheet.assumptions : [];
    if (assumptions.length) {
        lines.push('## Assumptions', '');
        for (const item of assumptions) lines.push(`- ${item}`);
        lines.push('');
    }
    if (sheet?.notes) lines.push('## Notes', '', String(sheet.notes), '');
    return lines.join('\n');
}

/**
 * Run the resolve stage: write the artifacts of the measurement.
 *
 * @param {object} state the pipeline state
 * @param {Function} [notify] event callback
 * @returns {Promise<void>}
 * @exports
 * @ai.hint io
 */
export async function runResolve(state, notify = () => {}) {
    const { root, config, sheet, crops = [], conclusion = null } = state;
    const outDir = state.outDir ?? config?.output?.dir ?? './measurements';
    const target = path.resolve(root, outDir);
    await mkdir(target, { recursive: true });

    const palette = buildPalette(sheet);
    const { css, tokens } = buildTokens(sheet, palette);
    const designMd = buildDesignMd(sheet, palette);
    const report = buildReport(sheet, { crops, conclusion });

    const measurements = {
        ...(sheet ?? {}),
        crops: crops.map((item) => ({
            kind: String(item?.kind ?? ''),
            name: String(item?.name ?? ''),
            crop: toPosix(String(item?.crop ?? '')),
            box: item?.box ?? null,
        })),
        conclusion: conclusion ?? null,
        generatedBy: 'ai-measure',
    };

    const files = [
        { name: MEASUREMENTS_FILE, content: `${JSON.stringify(measurements, null, 2)}\n` },
        { name: PALETTE_FILE, content: `${JSON.stringify(palette, null, 2)}\n` },
        { name: TOKENS_FILE, content: css },
        { name: DESIGN_MD_FILE, content: designMd },
        { name: REPORT_FILE, content: report },
    ];

    const written = [];
    for (const file of files) {
        const target3 = path.join(target, file.name);
        try {
            await writeFile(target3, file.content, 'utf-8');
            written.push(toPosix(path.relative(root, target3)));
        } catch (error) {
            state.warnings?.push(`resolve: ${file.name} was not written (${error?.message ?? error})`);
        }
    }

    state.palette = palette;
    state.tokens = tokens;
    state.artifacts = written;
    state.outputPath = path.join(target, MEASUREMENTS_FILE);
    notify({ type: 'resolve.done', files: written, tokens: tokens.length });
}
