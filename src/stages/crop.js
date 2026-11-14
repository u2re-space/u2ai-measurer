/**
 * @file src/stages/crop.js
 * @module stages/crop
 * @purpose Cut the ready reference crops for the regions and the reusable elements of a
 *          measurement sheet.
 *
 * The measurer names the boxes; the harness cuts the files. The image an item is cut from is
 * resolved in this order: the item's own `source`, a sub-reference named in its notes, the sheet
 * source — with `measure-source: subrefs` forcing the derived sub-references over the named
 * original. The boxes are clamped to the size of that image, identical boxes share one file and
 * the number of files is capped.
 *
 * @depends node:path, node:fs/promises, image/sharp, image/crop, agent/paths
 * @usedBy stages/measure, stages/resolve
 * @exports stageMeasurementCrops, measurementConclusion, cropSlug, resolveSheetSource
 * @ai.tags images, measurement, crop
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { rasterCrop, rasterInfo } from '../image/sharp.js';
import { clampRect } from '../image/crop.js';
import { cropSlug } from './artifacts.js';
import { resolveInside } from '../agent/paths.js';

/** The upper bound of the automatic crops of one sheet. `maxCrops: 0` lifts the cap. */
export const MAX_CROPS = 192;

/**
 * True when a file exists inside the working directory.
 * @param {string} root
 * @param {string} ref
 * @returns {Promise<string|null>} the project-relative path of the file, or null
 * @ai.hint io
 */
async function insideFile(root, ref) {
    try {
        const { abs, rel } = await resolveInside(root, ref, { allowRoot: false });
        const info = await stat(abs).catch(() => null);
        return info?.isFile() ? rel : null;
    } catch {
        return null;
    }
}

/**
 * The sub-references one original produced, matched by path or by the file name of `source`.
 * @param {object[]} references the references of the run
 * @param {string} original project-relative path of the original
 * @returns {string[]}
 * @ai.hint pure
 */
function derivedSubReferences(references, original) {
    const base = path.basename(original);
    return references
        .filter((file) => file?.kind === 'subref'
            && typeof file.source === 'string' && file.source.trim()
            && (file.source.trim() === original || path.basename(file.source) === base))
        .map((file) => file.rel);
}

/**
 * The sub-reference an item was measured on, when its notes name one by path or by file name.
 * @param {object} item a sheet element or region
 * @param {object[]} references the references of the run
 * @returns {string|null}
 * @ai.hint pure
 */
function namedSubReference(item, references) {
    const text = `${item?.notes ?? ''} ${item?.how ?? ''}`;
    if (!text.trim()) return null;
    for (const file of references) {
        if (typeof file?.rel !== 'string') continue;
        const base = file.rel.split('/').pop();
        if (text.includes(file.rel) || (base && text.includes(base))) return file.rel;
    }
    return null;
}

/**
 * The picture the sheet measures.
 *
 * @param {{ root: string, sheet: object, references?: object[], measureSource?: string, warnings?: string[] }} options
 * @returns {Promise<string|null>} the project-relative path, or null when nothing was found
 * @exports
 * @ai.hint io
 */
export async function resolveSheetSource({ root, sheet, references = [], measureSource = 'auto', warnings = [] }) {
    const originals = references.filter((item) => item?.kind === 'original').map((item) => item.rel);
    const subRefs = references.filter((item) => item?.kind === 'subref').map((item) => item.rel);
    const preferSubRefs = measureSource !== 'original';
    const named = String(sheet?.source ?? '').trim();

    /** The sub-reference that replaces an original, or null when the original stays. */
    const overrideFor = (originalRel) => {
        if (!preferSubRefs) return null;
        const derived = derivedSubReferences(references, originalRel);
        if (derived.length === 1) return derived[0];
        if (derived.length > 1) return measureSource === 'subrefs' ? derived[0] : null;
        if (measureSource === 'subrefs' && subRefs.length) return subRefs[0];
        return null;
    };
    const replaced = (originalRel, overridden) => {
        warnings.push(`The source of the measurements ${originalRel} is replaced by the sub-reference ${overridden} (measure-source: ${measureSource}).`);
        return overridden;
    };

    if (named && !/^https?:|^data:/i.test(named)) {
        const exact = [...subRefs, ...originals].find((item) => item === named || path.basename(item) === path.basename(named));
        if (exact) {
            const overridden = subRefs.includes(exact) ? null : overrideFor(exact);
            if (overridden) return replaced(exact, overridden);
            if (await insideFile(root, exact)) return exact;
        }
        const direct = await insideFile(root, named);
        if (direct) {
            const overridden = subRefs.includes(direct) ? null : overrideFor(direct);
            if (overridden) return replaced(direct, overridden);
            return direct;
        }
    }

    const candidates = measureSource === 'subrefs'
        ? [...subRefs, ...originals]
        : [...originals, ...subRefs];
    for (const item of candidates) {
        if (await insideFile(root, item)) return item;
    }
    return null;
}

/**
 * Cut every region and every reusable element of the sheet that has a usable box and no crop yet.
 *
 * @param {{ root: string, workId: string, sheet: object, references?: object[], measureSource?: string,
 *   maxCrops?: number, reuse?: Array<{ crop?: string, box?: object }> }} options
 * @returns {Promise<{ crops: Array<{ kind: string, name: string, crop: string, bytes?: number, box?: object }>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function stageMeasurementCrops({
    root,
    workId,
    sheet,
    references = [],
    measureSource = 'auto',
    maxCrops = MAX_CROPS,
    reuse = [],
}) {
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    const elements = Array.isArray(sheet?.elements) ? sheet.elements : [];
    if (!regions.length && elements.length === 0) return { crops: [], warnings: [] };

    const warnings = [];
    const source = await resolveSheetSource({ root, sheet, references, measureSource, warnings });
    if (!source) {
        return { crops: [], warnings: warnings.length ? warnings : ['The source of the measurements is not found: no crops were cut.'] };
    }

    const subRefRels = references.filter((item) => item?.kind === 'subref').map((item) => item.rel);

    /**
     * The picture one item is cut from.
     * @param {object} item
     * @param {string} name
     * @returns {Promise<string>}
     */
    const resolveItemSource = async (item, name) => {
        const explicit = String(item?.source ?? '').trim();
        if (explicit && !/^https?:|^data:/i.test(explicit)) {
            const sub = references.find((file) => file?.rel === explicit || path.basename(file?.rel ?? '') === path.basename(explicit));
            if (sub?.kind === 'subref' && await insideFile(root, sub.rel)) return sub.rel;
            const originalRel = await insideFile(root, explicit);
            if (originalRel) {
                if (measureSource === 'subrefs' && subRefRels.length && !subRefRels.includes(originalRel)) {
                    const derived = derivedSubReferences(references, originalRel);
                    const forced = derived[0] ?? subRefRels[0];
                    warnings.push(`The item "${name}" named the source ${originalRel}: in the measure-source: subrefs mode the crop is cut from ${forced}.`);
                    return forced;
                }
                return originalRel;
            }
            warnings.push(`The source "${explicit}" of the item "${name}" is not found — the source of the sheet is used.`);
        }
        return namedSubReference(item, references) ?? source;
    };

    // The size is resolved per source: a box measured on a restored sub-reference clamps against
    // that sub-reference, not against the original tilted picture.
    const sizeCache = new Map();
    const sizeFor = async (rel) => {
        if (!sizeCache.has(rel)) {
            const abs = path.resolve(root, rel);
            sizeCache.set(rel, await rasterInfo(abs).catch(() => null));
        }
        return sizeCache.get(rel);
    };
    const size = await sizeFor(source);
    if (!size?.width || !size?.height) {
        return { crops: [], warnings: [...warnings, `The size of ${source} could not be read.`] };
    }

    const crops = [];
    const seen = new Map();
    const manifest = new Set();
    const reserved = new Set();
    const cropPrefix = `.tmp/${workId}/crops/`;
    const isCropPath = (rel) => path.normalize(rel).startsWith(path.normalize(cropPrefix));
    let capped = false;
    const cap = Number.isSafeInteger(maxCrops) && maxCrops > 0 ? maxCrops : null;

    // Reuse the fragments cut after the overview pass when their box survived the second pass.
    for (const item of reuse) {
        if (!item?.crop || !item.box) continue;
        const existing = await insideFile(root, item.crop);
        if (!existing || !isCropPath(existing)) continue;
        reserved.add(existing);
        const key = [Math.round(item.box.x), Math.round(item.box.y), Math.round(item.box.width), Math.round(item.box.height)].join(':');
        if (!seen.has(key)) seen.set(key, existing);
    }

    /**
     * Cut one item and attach the project-relative path of the file to it.
     * @param {object} item
     * @param {string} kind
     * @param {number} index
     * @param {string} fallback
     */
    const stage = async (item, kind, index, fallback) => {
        if (!item || typeof item !== 'object') return;
        const box = item.box ?? {};
        const x = Number(box.x);
        const y = Number(box.y);
        const width = Number(box.width);
        const height = Number(box.height);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        const name = String(item.name ?? `${fallback} ${index + 1}`);
        const key = [Math.round(x), Math.round(y), Math.round(width), Math.round(height)].join(':');

        if (typeof item.crop === 'string' && item.crop.trim()) {
            const existing = await insideFile(root, item.crop);
            if (existing && isCropPath(existing)) {
                item.crop = existing;
                reserved.add(existing);
                seen.set(key, existing);
                if (!manifest.has(existing)) {
                    manifest.add(existing);
                    crops.push({ kind, name, crop: existing, box: { x, y, width, height } });
                }
                return;
            }
        }

        const shared = seen.get(key);
        if (shared) {
            item.crop = shared;
            if (!manifest.has(shared)) {
                manifest.add(shared);
                crops.push({ kind, name, crop: shared, box: { x, y, width, height } });
            }
            return;
        }
        if (cap && reserved.size >= cap) {
            if (!capped) warnings.push(`The crops are limited to ${cap} fragments.`);
            capped = true;
            return;
        }

        const itemSource = await resolveItemSource(item, name);
        const itemSize = itemSource === source ? size : await sizeFor(itemSource);
        if (!itemSize?.width || !itemSize?.height) {
            warnings.push(`The size of ${itemSource} could not be read: the crop "${name}" was not cut.`);
            return;
        }

        const cut = clampRect({ x, y, width, height }, itemSize);
        const left = cut.x;
        const top = cut.y;
        const w = cut.width;
        const h = cut.height;
        if (w <= 0 || h <= 0) return;

        let serial = reserved.size + 1;
        let rel = `.tmp/${workId}/crops/${String(serial).padStart(2, '0')}-${kind}-${cropSlug(name, fallback)}.png`;
        while (reserved.has(rel) || await insideFile(root, rel)) {
            serial += 1;
            rel = `.tmp/${workId}/crops/${String(serial).padStart(2, '0')}-${kind}-${cropSlug(name, fallback)}.png`;
        }
        try {
            const result = await rasterCrop({
                input: path.resolve(root, itemSource),
                output: path.resolve(root, rel),
                x: left,
                y: top,
                width: w,
                height: h,
            });
            item.crop = rel;
            seen.set(key, rel);
            manifest.add(rel);
            reserved.add(rel);
            crops.push({ kind, name, crop: rel, bytes: result.bytes, box: { x: left, y: top, width: w, height: h } });
        } catch (error) {
            warnings.push(`The crop "${name}" was not cut: ${error?.message ?? error}`);
        }
    };

    for (const [index, region] of regions.entries()) await stage(region, 'region', index, 'region');
    for (const [index, element] of elements.entries()) await stage(element, 'element', index, 'element');
    return { crops, warnings };
}

/**
 * The compact conclusion of a sheet: what was measured, the unit strategy, the assumptions and
 * the crops that were cut.
 * @param {object} sheet
 * @param {Array<{ kind?: string, name?: string, crop?: string, bytes?: number }>} [crops]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function measurementConclusion(sheet, crops = []) {
    const elements = Array.isArray(sheet?.elements) ? sheet.elements : [];
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    const rules = Array.isArray(sheet?.rules) ? sheet.rules : [];
    const lowConfidence = elements.filter((item) => ['low', 'unknown'].includes(item?.confidence)).length;
    return {
        summary: String(sheet?.summary ?? ''),
        source: String(sheet?.source ?? ''),
        unit: String(sheet?.unit ?? 'px'),
        canvas: sheet?.canvas ?? null,
        units: sheet?.units ?? null,
        confidence: String(sheet?.confidence ?? 'unknown'),
        counts: {
            elements: elements.length,
            textElements: elements.filter((item) => item?.typography).length,
            regions: regions.length,
            rules: rules.length,
            crops: crops.length,
            lowConfidence,
        },
        assumptions: Array.isArray(sheet?.assumptions) ? sheet.assumptions : [],
        notes: String(sheet?.notes ?? ''),
        crops: crops.map((item) => ({
            kind: String(item?.kind ?? ''),
            name: String(item?.name ?? ''),
            crop: String(item?.crop ?? ''),
            bytes: Number.isFinite(item?.bytes) ? item.bytes : null,
        })),
    };
}
