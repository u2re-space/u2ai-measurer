/**
 * @file src/stages/sample.js
 * @module stages/sample
 * @purpose Stage `sample`: the colours of the reference, named.
 *
 * The stage works in two modes:
 *   - local (the default): the harness reads the pixels of the reference and of the zones the
 *     segmentation named, and the model only *names* the colours it was given. The reasoning is
 *     cheap, the numbers are exact, and the money stays small.
 *   - ai: the model reads the picture itself and samples it with the `sample_colors` tool. The
 *     reasoning is sharp, the colours are perceived rather than read, and the run costs more.
 *
 * The answer is written into `<out>/stages/palette.json`: the colours with their hex, OKLCH,
 * HSL, luminance and share, and what every colour is for.
 *
 * @depends node:path, agent/schemas, image/colors, stages/artifacts, stages/references
 * @usedBy stages/index, shared/pipeline
 * @exports runSampleStage, sampledColors, colorLines, mergeSampled
 * @ai.tags stage, colours, palette
 * @ai.hint io
 */

import path from 'node:path';
import { PALETTE_SCHEMA } from '../agent/schemas.js';
import { sampleColors } from '../image/colors.js';
import { capEffort } from '../model/profiles.js';
import { attachImage, attachmentBlock, splitReferences } from './references.js';
import { readStageFile, writeStageFile } from './artifacts.js';

/** How many zones of one source are sampled in the local mode. */
const MAX_ZONES = 12;

/** How many colours of one area are read. */
const CANVAS_COLORS = 5;
const ZONE_COLORS = 3;

/**
 * The colours of one area, as the flat list the stage works with.
 *
 * Every entry carries the zone it was read from and the area it covers, so that the model only
 * has to name the colours and the resolver can put them back where they came from.
 *
 * @param {object} area the result of `sampleColors`
 * @param {string} source the file the colours were read from
 * @param {string} zone the zone the colours belong to; empty for the whole canvas
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function sampledColors(area, source, zone = '') {
    const colors = Array.isArray(area?.colors) ? area.colors : [];
    return colors.map((item) => ({
        hex: String(item?.hex ?? ''),
        rgb: String(item?.rgb ?? ''),
        hsl: String(item?.hsl ?? ''),
        oklch: String(item?.oklch ?? ''),
        luminance: Number.isFinite(item?.luminance) ? item.luminance : null,
        share: Number.isFinite(item?.share) ? item.share : null,
        source,
        zone,
        method: 'sampled',
        confidence: 'high',
        notes: '',
    }));
}

/**
 * The sampled colours as a text the model reads.
 * @param {object[]} samples the sampled colours
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function colorLines(samples = []) {
    return samples.map((item) => {
        const parts = [`- ${item.hex}`];
        if (item.zone) parts.push(`zone: ${item.zone}`);
        if (item.rgb) parts.push(item.rgb);
        if (item.oklch) parts.push(item.oklch);
        if (Number.isFinite(item.share)) parts.push(`share: ${Math.round(item.share * 100)}%`);
        return parts.join(' — ');
    }).join('\n');
}

/**
 * Put the numbers of the pixels back into the colours the model named.
 *
 * The model names the colours; the pixels hold the numbers. A colour the model wrote with the
 * hex of a sampled colour gets the exact OKLCH, HSL, luminance and share of that colour: the
 * naming is the model's, the numbers are the file's. A colour the model invented keeps its own
 * numbers and is marked as perceived.
 *
 * @param {object[]} colors the colours of the model
 * @param {object[]} samples the colours read from the pixels
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function mergeSampled(colors = [], samples = []) {
    const byHex = new Map();
    for (const item of samples) {
        const hex = String(item?.hex ?? '').trim().toLowerCase();
        if (hex) byHex.set(hex, item);
    }
    return colors.map((color) => {
        const hex = String(color?.hex ?? '').trim().toLowerCase();
        const hit = byHex.get(hex);
        if (!hit) {
            return {
                ...color,
                method: String(color?.method ?? '') || 'perceived',
                confidence: String(color?.confidence ?? '') || 'medium',
            };
        }
        return {
            ...color,
            oklch: String(hit.oklch ?? color?.oklch ?? ''),
            hsl: String(hit.hsl ?? color?.hsl ?? ''),
            rgb: String(hit.rgb ?? color?.rgb ?? ''),
            luminance: Number.isFinite(hit.luminance) ? hit.luminance : (color?.luminance ?? null),
            share: Number.isFinite(color?.share) ? color.share : (hit.share ?? null),
            zone: String(color?.zone ?? '') || String(hit.zone ?? ''),
            source: String(color?.source ?? '') || String(hit.source ?? ''),
            method: 'sampled',
            confidence: 'high',
        };
    });
}

/**
 * Run the sample stage.
 *
 * @param {{ root: string, workId: string, config: object, runner: object, references?: object[],
 *   outDir?: string, notify?: Function|null, signal?: AbortSignal|null, effort?: string|null }} options
 * @returns {Promise<{ palette: object|null, file: string|null, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runSampleStage({
    root,
    workId,
    config,
    runner,
    references = [],
    outDir = null,
    notify = null,
    signal = null,
    effort = null,
}) {
    const warnings = [];
    const mode = config?.stages?.sample?.mode ?? 'local';
    const maxTurns = Math.max(1, Number(config?.stages?.sample?.maxTurns) || 4);
    const wanted = mode === 'ai'
        ? (config?.stages?.sample?.aiEffort ?? 'xhigh')
        : (config?.stages?.sample?.localEffort ?? 'low');
    const stageEffort = capEffort(wanted, effort ?? config?.reasoning?.effort ?? null);

    const segmentation = await readStageFile(outDir, 'segmentation');
    if (!segmentation) {
        return { palette: null, file: null, warnings: ['There is no segmentation to sample: run the segmentate stage first.'] };
    }

    // The files the references came from.
    const files = new Map();
    for (const item of references) {
        if (!item?.rel) continue;
        files.set(item.rel, path.resolve(root, item.rel));
        files.set(path.basename(item.rel), path.resolve(root, item.rel));
    }

    const sources = Array.isArray(segmentation.sources) ? segmentation.sources : [];
    const samples = [];
    const pictures = [];
    for (const entry of sources) {
        const source = String(entry?.source ?? '');
        const file = files.get(source) ?? files.get(path.basename(source));
        if (!file) {
            warnings.push(`The reference ${source} could not be found: its colours were not read.`);
            continue;
        }
        // The colours of the whole canvas: the background lives there.
        const canvas = await sampleColors({ abs: file, k: CANVAS_COLORS }).catch(() => null);
        if (canvas?.colors?.length) {
            samples.push(...sampledColors(canvas, source, ''));
        }
        // The colours of the zones: only in the local mode, where the harness does the reading.
        if (mode === 'local') {
            const zones = (Array.isArray(entry?.zones) ? entry.zones : [])
                .filter((zone) => zone?.box && Number.isFinite(zone.box.width))
                .sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))
                .slice(0, MAX_ZONES);
            for (const zone of zones) {
                const area = await sampleColors({ abs: file, box: zone.box, k: ZONE_COLORS }).catch(() => null);
                if (area?.colors?.length) {
                    samples.push(...sampledColors(area, source, String(zone?.name ?? '')));
                }
            }
        }
    }

    // The pictures the model may see. In the local mode the model sees none: it has the colours.
    const { attached } = splitReferences(references);
    if (mode === 'ai') {
        for (const item of attached) {
            const image = await attachImage({ abs: path.resolve(root, item.rel), config });
            if (!image) continue;
            pictures.push({ part: image.part, rel: item.rel });
        }
    }

    if (!samples.length && !pictures.length) {
        return { palette: null, file: null, warnings };
    }

    const lines = [];
    if (pictures.length) {
        lines.push(attachmentBlock(pictures.map((item) => ({ rel: item.rel, role: 'original' }))));
        lines.push('');
    }
    if (samples.length) {
        lines.push('# Colours read from the pixels');
        lines.push('These are the exact bytes of the file. Copy every hex exactly as it is written.');
        lines.push(colorLines(samples));
        lines.push('');
    }
    lines.push('# Work directory', `.tmp/${workId}/`, '');
    lines.push(mode === 'ai'
        ? 'Read the colours of the picture and name them. Sample the areas you need with the tool.'
        : 'Name the colours above. Keep every hex exactly as it is written.');

    const answer = await runner.run('sampler', {
        text: lines.join('\n'),
        parts: pictures.map((item) => item.part),
        schema: PALETTE_SCHEMA,
        schemaName: 'palette',
        maxTurns,
        effort: stageEffort,
        signal,
    });
    if (answer.error) {
        warnings.push(`The sampler failed: ${answer.error}`);
    }

    const named = Array.isArray(answer.data?.colors) ? answer.data.colors : [];
    // When the model named nothing, the colours of the pixels are the palette.
    const colors = named.length
        ? mergeSampled(named, samples)
        : samples.map((item, index) => ({
            name: `colour-${index + 1}`,
            hex: item.hex,
            oklch: item.oklch,
            hsl: item.hsl,
            rgb: item.rgb,
            luminance: item.luminance,
            share: item.share,
            method: 'sampled',
            zone: item.zone,
            role: '',
            contrast: null,
            confidence: 'high',
            notes: '',
        }));

    const palette = {
        generatedBy: 'ai-measure',
        stage: 'sample',
        mode,
        createdAt: new Date().toISOString(),
        summary: String(answer.data?.summary ?? (samples.length ? 'The colours read from the pixels.' : '')),
        colors,
        background: answer.data?.background ?? (samples[0]?.hex ?? null),
        text: answer.data?.text ?? null,
        accent: answer.data?.accent ?? null,
        colorSpace: answer.data?.colorSpace ?? {
            working: 'sRGB',
            encoding: '',
            assumption: '',
        },
        notes: String(answer.data?.notes ?? ''),
        // The colours of the pixels, as they were read: the resolver attaches them to the zones.
        samples,
    };

    notify?.({ type: 'sample.colors', count: colors.length, mode });
    const file = outDir ? await writeStageFile(outDir, 'palette', palette) : null;
    return { palette, file, warnings };
}
