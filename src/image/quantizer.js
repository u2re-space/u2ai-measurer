/**
 * @file src/image/quantizer.js
 * @module image/quantizer
 * @purpose K-means colour quantisation in RGB space, seeded and deterministic.
 *
 * The palette of a picture has to be reproducible: two runs over the same file
 * must give the same colours, or a measurement sheet stops being evidence.
 *
 * @exports kmeansPalette, samplePixels, dominantColors, toHex, backgroundColor, dominantSubjectColors
 * @ai.tags image, colors, quantizer, kmeans
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

/**
 * Create a deterministic pseudo-random number generator from a 32-bit seed.
 * @param {number} seed
 * @returns {() => number}
 * @ai.hint pure
 */
function mulberry32(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Euclidean distance in RGB space between two colours.
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 * @ai.hint pure
 */
function rgbDistance(a, b) {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * K-means++ initialisation: `k` centroids spread over the colour data.
 * @param {{ r: number, g: number, b: number }[]} colours
 * @param {number} k
 * @param {() => number} rand
 * @returns {{ r: number, g: number, b: number }[]}
 * @ai.hint pure
 */
function initCentroids(colours, k, rand) {
    const centroids = [{ ...colours[Math.floor(rand() * colours.length)] }];
    for (let c = 1; c < k; c++) {
        // Squared distance to the closest existing centroid drives the sampling weight.
        const weights = colours.map((col) => {
            let min = Infinity;
            for (const existing of centroids) {
                const d = rgbDistance(col, existing);
                if (d < min) min = d;
            }
            return min * min;
        });
        const sum = weights.reduce((s, w) => s + w, 0);
        if (sum <= 0) {
            centroids.push({ ...colours[Math.floor(rand() * colours.length)] });
            continue;
        }
        let r = rand() * sum;
        let idx = colours.length - 1;
        for (let i = 0; i < weights.length; i++) {
            r -= weights[i];
            if (r <= 0) { idx = i; break; }
        }
        centroids.push({ ...colours[idx] });
    }
    return centroids;
}

/**
 * The colour whose smallest distance to any of `centroids` is the largest.
 * @param {{ r: number, g: number, b: number }[]} colours
 * @param {{ r: number, g: number, b: number }[]} centroids
 * @returns {{ r: number, g: number, b: number }}
 * @ai.hint pure
 */
function farthestColour(colours, centroids) {
    let best = colours[0];
    let bestD = -1;
    for (const col of colours) {
        let min = Infinity;
        for (const c of centroids) {
            const d = rgbDistance(col, c);
            if (d < min) min = d;
        }
        if (min > bestD) { best = col; bestD = min; }
    }
    return { ...best };
}

/**
 * Run EM iterations of k-means. Returns final centroids plus cluster sizes.
 * @param {{ r: number, g: number, b: number }[]} colours
 * @param {{ r: number, g: number, b: number }[]} centroids
 * @param {number} iterations
 * @returns {{ centroids: { r: number, g: number, b: number, count: number }[] }}
 * @ai.hint pure
 */
function kmeansFit(colours, centroids, iterations) {
    let current = centroids.map((c) => ({ ...c }));
    const assignments = new Int32Array(colours.length);

    for (let iter = 0; iter < iterations; iter++) {
        // Assign step: nearest centroid per colour.
        for (let i = 0; i < colours.length; i++) {
            let minD = Infinity;
            let best = 0;
            for (let j = 0; j < current.length; j++) {
                const d = rgbDistance(colours[i], current[j]);
                if (d < minD) { minD = d; best = j; }
            }
            assignments[i] = best;
        }
        // Update step: centroids become cluster means.
        const sums = current.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
        for (let i = 0; i < colours.length; i++) {
            const bucket = sums[assignments[i]];
            bucket.r += colours[i].r;
            bucket.g += colours[i].g;
            bucket.b += colours[i].b;
            bucket.count++;
        }
        current = sums.map((bucket, j) => (bucket.count > 0
            ? { r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count }
            // An empty cluster is re-seeded with the colour farthest from every centroid,
            // so a degenerate palette never loses slots.
            : farthestColour(colours, current.filter((_, k) => k !== j))));
    }

    const counts = current.map(() => 0);
    for (let i = 0; i < colours.length; i++) counts[assignments[i]]++;
    return { centroids: current.map((c, i) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), count: counts[i] })) };
}

/**
 * Cluster a colour list with k-means++ and return centroids by coverage share.
 * @param {{ r: number, g: number, b: number }[]} colours input colours
 * @param {{ k?: number, iterations?: number, seed?: number }} [options]
 * @returns {{ r: number, g: number, b: number, share: number }[]} sorted by share (descending)
 * @ai.hint pure
 */
export function kmeansPalette(colours, { k = 4, iterations = 10, seed = 42 } = {}) {
    if (!Array.isArray(colours) || colours.length === 0) return [];
    const clusters = Math.max(1, Math.min(k, colours.length));
    const rand = mulberry32(seed);
    const { centroids } = kmeansFit(colours, initCentroids(colours, clusters, rand), iterations);
    const total = colours.length;
    return centroids
        .map((c) => ({ r: c.r, g: c.g, b: c.b, share: c.count / total }))
        .sort((a, b) => b.share - a.share);
}

/**
 * Sample opaque pixels from an RGBA frame as a colour list.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame RGBA frame
 * @param {{ alphaThreshold?: number, maxSamples?: number, seed?: number }} [options]
 * @returns {{ r: number, g: number, b: number }[]}
 * @ai.hint pure
 */
export function samplePixels(frame, { alphaThreshold = 128, maxSamples = 4096, seed = 42 } = {}) {
    const { width, height, data } = frame || {};
    if (!width || !height || !data) return [];
    const total = width * height;
    // Reading every Nth pixel keeps memory and CPU bounded on a 4K frame.
    const stride = Math.max(1, Math.floor(total / Math.max(1, maxSamples)));
    const jitter = mulberry32(seed);
    const offset = Math.floor(jitter() * stride);
    const result = [];
    for (let idx = offset; idx < total; idx += stride) {
        const p = idx * 4;
        if (data[p + 3] >= alphaThreshold) {
            result.push({ r: data[p], g: data[p + 1], b: data[p + 2] });
        }
    }
    return result;
}

/**
 * Dominant colours of the opaque part of a frame, by coverage share.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame RGBA frame
 * @param {{ k?: number, iterations?: number, alphaThreshold?: number, maxSamples?: number, seed?: number }} [options]
 * @returns {{ r: number, g: number, b: number, share: number }[]}
 * @ai.hint pure
 */
export function dominantColors(frame, { k = 4, iterations = 10, alphaThreshold = 128, maxSamples = 4096, seed = 42 } = {}) {
    const samples = samplePixels(frame, { alphaThreshold, maxSamples, seed });
    // A fully transparent (or unreadable) frame has no subject color to report.
    if (samples.length === 0) return [];
    return kmeansPalette(samples, { k, iterations, seed });
}

/**
 * Convert an RGB colour to a `#RRGGBB` hex string.
 * @param {{ r: number, g: number, b: number }} color
 * @returns {string}
 * @ai.hint pure
 */
export function toHex({ r, g, b }) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/**
 * Weighted RGB distance normalized to 0..255 (green weighs double).
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 * @ai.hint pure
 */
function perceptualDistance(a, b) {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt((2 * dr * dr + 4 * dg * dg + 2 * db * db) / 8);
}

/**
 * Sample the pixels along the four frame edges — the region a flat plate always covers.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame
 * @param {{ alphaThreshold?: number, maxSamples?: number }} [options]
 * @returns {{ r: number, g: number, b: number }[]}
 * @ai.hint pure
 */
function sampleBorder(frame, { alphaThreshold = 128, maxSamples = 512 } = {}) {
    const { width, height, data } = frame || {};
    if (!width || !height || !data) return [];
    const picked = [];
    // One pass over the perimeter with a stride keeps the border sample cheap on a 4K frame.
    const stride = Math.max(1, Math.floor((2 * (width + height)) / Math.max(1, maxSamples)));
    let seen = 0;
    const take = (x, y) => {
        const p = (y * width + x) * 4;
        if (data[p + 3] >= alphaThreshold && seen++ % stride === 0) {
            picked.push({ r: data[p], g: data[p + 1], b: data[p + 2] });
        }
    };
    for (let x = 0; x < width; x++) { take(x, 0); take(x, height - 1); }
    for (let y = 1; y + 1 < height; y++) { take(0, y); take(width - 1, y); }
    return picked;
}

/**
 * The color the frame is sitting on: the largest cluster of the border sample.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame
 * @param {{ alphaThreshold?: number, borderSamples?: number, seed?: number }} [options]
 * @returns {{ r: number, g: number, b: number }|null}
 * @ai.hint pure
 */
export function backgroundColor(frame, { alphaThreshold = 128, borderSamples = 512, seed = 42 } = {}) {
    const border = sampleBorder(frame, { alphaThreshold, maxSamples: borderSamples });
    if (border.length === 0) return null;
    const [top] = kmeansPalette(border, { k: Math.min(2, border.length), iterations: 8, seed });
    return top ? { r: top.r, g: top.g, b: top.b } : null;
}

/**
 * The dominant color of the subject, with the plate it rests on left out of the vote.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame RGBA frame
 * @param {{ backgroundTolerance?: number, k?: number, alphaThreshold?: number, maxSamples?: number, seed?: number, iterations?: number }} [options]
 * @returns {{ r: number, g: number, b: number, share: number }[]}
 * @ai.hint pure
 */
export function dominantSubjectColors(frame, { backgroundTolerance = 40, k = 3, alphaThreshold = 128, maxSamples = 4096, seed = 42, iterations = 10 } = {}) {
    const ground = backgroundColor(frame, { alphaThreshold, seed });
    const samples = samplePixels(frame, { alphaThreshold, maxSamples, seed });
    if (samples.length === 0) return [];
    // Pixels that sit within tolerance of the plate are the ground, not the artwork.
    const subject = ground
        ? samples.filter((c) => perceptualDistance(c, ground) > backgroundTolerance)
        : samples;
    // A subject painted in the plate color has no separate color to report: fall back to the whole frame.
    if (subject.length < 8) return kmeansPalette(samples, { k, iterations, seed });
    return kmeansPalette(subject, { k, iterations, seed });
}
