/**
 * @file src/stages/resolve.js
 * @module stages/resolve
 * @purpose Stage `resolve`: the parts of the stages into the files a coder can use.
 *
 * The stages before this one left their parts in the output directory: the zones, the fragments,
 * the geometry, the texts and the colours. The resolve stage puts them together and writes:
 *   - `measurements.json` — one sheet: the zones with their numbers, their texts and their colours;
 *   - `palette.json` — the colours with their hex, OKLCH and contrast notes;
 *   - `tokens.css` — the colours and the repeated measures as CSS custom properties;
 *   - `DESIGN.md` — the same tokens as a document a person reads;
 *   - `report.md` — what was measured, what is uncertain and which fragments exist.
 *
 * The stage works in two modes:
 *   - local (the default): the harness assembles the parts. No model, no tokens, no money.
 *   - ai: the resolver reconciles the parts — it reads all of them and writes one sheet.
 *
 * Every number in the files comes from a stage. Nothing is invented here: a value no stage
 * measured does not become a token.
 *
 * @depends node:path, node:fs/promises, agent/schemas, stages/artifacts
 * @usedBy stages/index, shared/pipeline
 * @exports runResolve, buildSheet, buildPalette, buildTokens, buildDesignMd, buildReport,
 *          collectCrops, repointCrops, MEASUREMENTS_FILE, PALETTE_FILE, TOKENS_FILE,
 *          DESIGN_MD_FILE, REPORT_FILE, CROPS_DIR
 * @ai.tags output, tokens, palette
 * @ai.hint io
 */

import path from 'node:path';
import { cp, mkdir, stat } from 'node:fs/promises';
import { MEASUREMENT_SCHEMA } from '../agent/schemas.js';
import { cropSlug, deliveryRel, readStageFile } from './artifacts.js';
import { toPosix } from '../agent/paths.js';
import { writeFileAtomic } from '../shared/house.js';

/** The names of the artifacts, inside the output directory. */
export const MEASUREMENTS_FILE = 'measurements.json';
export const PALETTE_FILE = 'palette.json';
export const TOKENS_FILE = 'tokens.css';
export const DESIGN_MD_FILE = 'DESIGN.md';
export const REPORT_FILE = 'report.md';
/** The directory of the fragments, next to the artifacts: the sheet and the fragments travel together. */
export const CROPS_DIR = 'crops';

/**
 * Copy the fragments next to the artifacts.
 *
 * The fragments of the crop stage already lie in the delivery; the ones of an older run may
 * still be in the work directory, which is scratch. A fragment that cannot be copied keeps
 * its old path — a missing file is better than a wrong path.
 *
 * The path of a fragment counts from the root of the project, in the stage files and in the
 * sheet of the delivery alike.
 *
 * @param {string} root the working directory
 * @param {string} target the output directory
 * @param {object[]} crops the fragments of the stage
 * @param {string[]} [warnings] the warnings of the run
 * @returns {Promise<{ crops: object[], map: Map<string, string> }>}
 * @exports
 * @ai.hint io
 */
export async function collectCrops(root, target, crops = [], warnings = []) {
    const map = new Map();
    if (!Array.isArray(crops) || !crops.length) return { crops: [], map };
    const dir = path.join(target, CROPS_DIR);
    const delivery = deliveryRel(root, target);
    const copied = [];
    for (const item of crops) {
        const source = toPosix(String(item?.crop ?? ''));
        if (!source) continue;
        const name = path.basename(source);
        const inDelivery = path.join(dir, name);
        const rel = toPosix(path.join(delivery, CROPS_DIR, name));
        // A fragment that already lies in the delivery stays where it is.
        if (await stat(inDelivery).then((info) => info.isFile()).catch(() => false)) {
            map.set(source, rel);
            copied.push({ ...item, crop: rel });
            continue;
        }
        // The fragment lies in the root of the project (the law of the house) or, in the files
        // of an older run, in the delivery or in the work directory.
        const places = [path.resolve(root, source)];
        if (delivery !== '.') places.push(path.resolve(root, delivery, source));
        let found = null;
        for (const place of places) {
            if (await stat(place).then((info) => info.isFile()).catch(() => false)) {
                found = place;
                break;
            }
        }
        if (!found) {
            // A missing file keeps its old path — a missing file is better than a wrong path.
            warnings.push(`resolve: the crop ${source} is not there: its path stays as it is.`);
            copied.push(item);
            continue;
        }
        try {
            await mkdir(dir, { recursive: true });
            await cp(found, inDelivery, { force: true });
        } catch (error) {
            warnings.push(`resolve: the crop ${source} was not copied (${error?.message ?? error})`);
            copied.push(item);
            continue;
        }
        map.set(source, rel);
        copied.push({ ...item, crop: rel });
    }
    return { crops: copied, map };
}

/**
 * Point the fragment paths of a sheet at the copies.
 * @param {object} sheet the measurement sheet
 * @param {Map<string, string>} map the old path and the new one
 * @returns {object} a new sheet
 * @exports
 * @ai.hint pure
 */
export function repointCrops(sheet, map) {
    if (!sheet || !(map instanceof Map) || !map.size) return sheet;
    const one = (item) => {
        const crop = toPosix(String(item?.crop ?? ''));
        const next = map.get(crop);
        return next && next !== crop ? { ...item, crop: next } : item;
    };
    const conclusion = sheet.conclusion && Array.isArray(sheet.conclusion.crops)
        ? { ...sheet.conclusion, crops: sheet.conclusion.crops.map(one) }
        : sheet.conclusion;
    return {
        ...sheet,
        elements: Array.isArray(sheet.elements) ? sheet.elements.map(one) : sheet.elements,
        regions: Array.isArray(sheet.regions) ? sheet.regions.map(one) : sheet.regions,
        conclusion,
    };
}

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
 * The geometry part of one source, found by the name of the file.
 * @param {object[]} sources the sources of a stage file
 * @param {string} source the name of the file
 * @returns {object|null}
 * @ai.hint pure
 */
function partOf(sources, source) {
    const list = Array.isArray(sources) ? sources : [];
    const wanted = String(source ?? '');
    return list.find((entry) => {
        const name = String(entry?.source ?? '');
        return name === wanted || path.basename(name) === path.basename(wanted);
    }) ?? null;
}

/**
 * Put the parts of the stages into one sheet.
 *
 * The zones of the segmentation are the skeleton: every element of the sheet is a zone, and the
 * geometry and the texts are attached to the zone they belong to. A zone without a measurement
 * stays in the sheet with an empty number — a missing value is better than an invented one.
 *
 * @param {{ segmentation?: object|null, geometry?: object|null, recognition?: object|null,
 *   palette?: object|null, crops?: object[] }} parts the files of the stages
 * @returns {object} the measurement sheet
 * @exports
 * @ai.hint pure
 */
export function buildSheet({ segmentation = null, geometry = null, recognition = null, palette = null, crops = [] } = {}) {
    const sources = Array.isArray(segmentation?.sources) ? segmentation.sources : [];
    const cropList = Array.isArray(crops) ? crops : [];

    const elements = [];
    const regions = [];
    const rules = [];
    const assumptions = [];
    const notes = [];
    let units = null;
    let unit = 'px';
    let confidence = 'unknown';
    let summary = '';
    let canvas = null;
    let source = '';

    for (const entry of sources) {
        const file = String(entry?.source ?? '');
        if (!source) source = file;
        if (!canvas && entry?.canvas) canvas = entry.canvas;
        if (entry?.summary) summary = summary || String(entry.summary);

        const geometryPart = partOf(geometry?.sources, file);
        const recognitionPart = partOf(recognition?.sources, file);
        if (geometryPart?.units && !units) units = geometryPart.units;
        if (geometryPart?.unit) unit = String(geometryPart.unit);
        if (geometryPart?.confidence) confidence = String(geometryPart.confidence);
        for (const item of Array.isArray(geometryPart?.assumptions) ? geometryPart.assumptions : []) {
            assumptions.push(String(item));
        }
        if (geometryPart?.notes) notes.push(String(geometryPart.notes));

        const numbers = new Map();
        for (const item of Array.isArray(geometryPart?.elements) ? geometryPart.elements : []) {
            numbers.set(String(item?.zone ?? ''), item);
        }
        const texts = new Map();
        for (const item of Array.isArray(recognitionPart?.texts) ? recognitionPart.texts : []) {
            texts.set(String(item?.zone ?? ''), item);
        }
        const samples = Array.isArray(palette?.samples) ? palette.samples : [];

        for (const zone of Array.isArray(entry?.zones) ? entry.zones : []) {
            const name = String(zone?.name ?? '');
            const number = numbers.get(name) ?? null;
            const text = texts.get(name) ?? null;
            const crop = cropList.find((item) => String(item?.name ?? '') === name) ?? null;
            const colors = samples
                .filter((item) => String(item?.zone ?? '') === name)
                .map((item) => ({
                    role: String(item?.role ?? ''),
                    hex: String(item?.hex ?? ''),
                    oklch: String(item?.oklch ?? ''),
                    method: 'sampled',
                    contrast: null,
                    confidence: 'high',
                }));

            elements.push({
                name,
                kind: String(zone?.kind ?? 'other'),
                box: zone?.box ?? null,
                display: String(number?.display ?? ''),
                rotation: Number.isFinite(number?.rotation) ? number.rotation : null,
                borders: String(number?.borders ?? ''),
                radius: Number.isFinite(number?.radius) ? number.radius : null,
                padding: number?.padding ?? null,
                margin: number?.margin ?? null,
                gap: Number.isFinite(number?.gap) ? number.gap : null,
                spacing: '',
                placement: String(number?.placement ?? ''),
                css: String(number?.css ?? ''),
                typography: text
                    ? {
                        role: String(text?.role ?? ''),
                        family: String(text?.family ?? ''),
                        familyConfidence: String(text?.familyConfidence ?? 'unknown'),
                        fontSize: Number.isFinite(text?.fontSize) ? text.fontSize : null,
                        weight: Number.isFinite(text?.weight) ? text.weight : null,
                        lineHeight: Number.isFinite(text?.lineHeight) ? text.lineHeight : null,
                        letterSpacing: Number.isFinite(text?.letterSpacing) ? text.letterSpacing : null,
                        style: String(text?.style ?? ''),
                    }
                    : null,
                confidence: String(number?.confidence ?? 'unknown'),
                colors,
                source: file || null,
                notes: [String(zone?.notes ?? ''), String(number?.notes ?? ''), String(text?.notes ?? '')]
                    .filter(Boolean)
                    .join(' '),
                use: String(zone?.use ?? ''),
                crop: crop ? String(crop.crop ?? '') : null,
            });

            // The fragments are the reusable parts of the picture: they are the regions.
            if (crop) {
                regions.push({
                    name,
                    kind: String(zone?.kind ?? 'other'),
                    box: zone?.box ?? null,
                    how: String(zone?.role ?? ''),
                    use: String(zone?.use ?? ''),
                    source: file || null,
                    crop: String(crop.crop ?? ''),
                });
            }
        }

        for (const rule of Array.isArray(geometryPart?.rules) ? geometryPart.rules : []) {
            rules.push({
                name: String(rule?.name ?? ''),
                value: Number.isFinite(rule?.value) ? rule.value : null,
                unit: String(rule?.unit ?? ''),
                css: String(rule?.css ?? ''),
                from: String(rule?.from ?? ''),
            });
        }
    }

    const colors = Array.isArray(palette?.colors) ? palette.colors : [];
    return {
        summary: summary || (colors.length ? 'The colours of the reference.' : ''),
        source,
        unit,
        units: units ?? { source: unit, rootFontSize: null, scale: null, preferred: [], notes: '' },
        confidence,
        assumptions,
        colors: {
            palette: colors,
            background: palette?.background ?? null,
            text: palette?.text ?? null,
            accent: palette?.accent ?? null,
            colorSpace: palette?.colorSpace ?? { working: '', encoding: '', assumption: '' },
            notes: String(palette?.notes ?? ''),
        },
        canvas,
        elements,
        regions,
        rules,
        notes: notes.join('\n'),
    };
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
    return {
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
            zone: String(item?.zone ?? ''),
            role: String(item?.role ?? ''),
            contrast: Number.isFinite(item?.contrast) ? item.contrast : null,
            confidence: String(item?.confidence ?? 'unknown'),
            source: item?.source ?? null,
            notes: String(item?.notes ?? ''),
        })),
        notes: String(sheet?.colors?.notes ?? ''),
    };
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
 * @param {object} [options] the fragments of the stage
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function buildReport(sheet, { crops = [] } = {}) {
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
    const { root, config } = state;
    const outDir = state.outDir ?? config?.output?.dir ?? './measurements';
    const target = path.resolve(root, outDir);
    await mkdir(target, { recursive: true });

    // The parts the stages left. A stage that never ran leaves no file: the sheet misses it.
    const segmentation = await readStageFile(outDir, 'segmentation');
    const cropFile = await readStageFile(outDir, 'crops');
    const geometry = await readStageFile(outDir, 'geometry');
    const recognition = await readStageFile(outDir, 'recognition');
    const palette = await readStageFile(outDir, 'palette');
    const crops = Array.isArray(cropFile?.crops) ? cropFile.crops : [];

    if (!segmentation && !geometry && !palette) {
        state.warnings?.push('resolve: no stage left a part: the artifacts are empty.');
    }

    let sheet = buildSheet({ segmentation, geometry, recognition, palette, crops });

    // The ai mode: the resolver reconciles the parts into one sheet.
    const mode = config?.stages?.resolve?.mode ?? 'local';
    if (mode === 'ai' && state.roles?.run) {
        const answer = await askResolver({
            state,
            sheet,
            segmentation,
            geometry,
            recognition,
            palette,
            crops,
            signal: state.signal ?? null,
        });
        if (answer?.data) {
            sheet = { ...sheet, ...answer.data, crops: sheet.crops };
        } else if (answer?.error) {
            state.warnings?.push(`resolve: the resolver failed (${answer.error}); the parts were joined by the harness.`);
        }
    }

    // The fragments travel with the artifacts: the work directory is scratch, the output is the
    // delivery.
    const gathered = await collectCrops(root, target, crops, state.warnings ?? []);
    const pointed = repointCrops(sheet, gathered.map);

    const paletteFile = buildPalette(pointed);
    const { css, tokens } = buildTokens(pointed, paletteFile);
    const designMd = buildDesignMd(pointed, paletteFile);
    const report = buildReport(pointed, { crops: gathered.crops });

    const measurements = {
        ...pointed,
        crops: gathered.crops.map((item) => ({
            kind: String(item?.kind ?? ''),
            name: String(item?.name ?? ''),
            crop: toPosix(String(item?.crop ?? '')),
            box: item?.box ?? null,
        })),
        conclusion: null,
        generatedBy: 'ai-measure',
    };

    const files = [
        { name: MEASUREMENTS_FILE, content: `${JSON.stringify(measurements, null, 2)}\n` },
        { name: PALETTE_FILE, content: `${JSON.stringify(paletteFile, null, 2)}\n` },
    ];
    // The switches of the stage decide which of the optional files are written.
    if (config?.stages?.resolve?.tokens !== false) {
        files.push({ name: TOKENS_FILE, content: css });
    }
    if (config?.stages?.resolve?.designMd !== false) {
        files.push({ name: DESIGN_MD_FILE, content: designMd });
    }
    if (config?.stages?.resolve?.report !== false) {
        files.push({ name: REPORT_FILE, content: report });
    }

    const written = [];
    for (const file of files) {
        const target3 = path.join(target, file.name);
        try {
            await writeFileAtomic(target3, file.content);
            written.push(toPosix(path.relative(root, target3)));
            // Every file of the delivery is named as it is written.
            notify({
                type: 'artifact',
                file: toPosix(path.relative(root, target3)),
                bytes: Buffer.byteLength(file.content, 'utf-8'),
            });
        } catch (error) {
            state.warnings?.push(`resolve: ${file.name} was not written (${error?.message ?? error})`);
        }
    }

    state.palette = paletteFile;
    state.tokens = tokens;
    // The delivery joins the files of the stages: everything the run wrote is named at the end.
    state.artifacts = [...(state.artifacts ?? []), ...written];
    state.outputPath = path.join(target, MEASUREMENTS_FILE);
    notify({ type: 'resolve.done', files: written, tokens: tokens.length });
}

/**
 * Ask the resolver to put the parts into one sheet.
 *
 * @param {object} options the parts of the stages
 * @returns {Promise<object|null>} the answer of the resolver
 * @ai.hint io
 */
async function askResolver({ state, sheet, segmentation, geometry, recognition, palette, crops, signal }) {
    const maxTurns = Math.max(1, Number(state.config?.stages?.resolve?.maxTurns) || 4);
    const text = [
        '# Zones',
        JSON.stringify(segmentation ?? {}, null, 2),
        '',
        '# Geometry',
        JSON.stringify(geometry ?? {}, null, 2),
        '',
        '# Texts',
        JSON.stringify(recognition ?? {}, null, 2),
        '',
        '# Colours',
        JSON.stringify(palette ?? {}, null, 2),
        '',
        '# Fragments',
        JSON.stringify(crops ?? [], null, 2),
        '',
        'Put these parts into one measurement sheet. Keep every number as it is and every zone name.',
    ].join('\n');
    return await state.roles.run('resolver', {
        text,
        schema: MEASUREMENT_SCHEMA,
        schemaName: 'measurement',
        maxTurns,
        effort: state.config?.stages?.resolve?.effort ?? null,
        signal,
    });
}
