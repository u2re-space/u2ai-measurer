/**
 * @file src/agent/schemas.js
 * @module agent/schemas
 * @purpose Strict JSON schemas for the structured answers of the roles (Responses API text.format
 *          = json_schema).
 *
 * Every schema is built with `object()`: all the properties are required and the extra ones are
 * rejected. The model therefore has to answer with every field, and `null` is the only way to say
 * "this was not measured" — which is the whole point of a measurement sheet.
 *
 * @exports MEASUREMENT_SCHEMA, DESIGN_SCHEMA, CROP_PLAN_SCHEMA, SEGMENTATION_SCHEMA,
 *          GEOMETRY_SCHEMA, RECOGNITION_SCHEMA, PALETTE_SCHEMA, strictSchema,
 *          strictnessProblems, schemaProblems, schemaProblemsText, SUB_REFERENCE_KINDS
 * @ai.tags schema, roles
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };

/**
 * Build a strict object schema: every property is required and extras are rejected.
 * @param {object} properties
 * @returns {object}
 * @ai.hint pure
 */
const object = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
});

/**
 * The kinds of a flat reference a decomposer may produce.
 * @type {string[]}
 */
export const SUB_REFERENCE_KINDS = ['crop', 'split', 'restored', 'repaired', 'regenerated', 'figma-export'];

/** A rectangle in source pixels. Every side is null when it cannot be read. */
const box = object({
    x: { ...nullableNumber, description: 'Left edge in source pixels.' },
    y: { ...nullableNumber, description: 'Top edge in source pixels.' },
    width: { ...nullableNumber, description: 'Width in source pixels.' },
    height: { ...nullableNumber, description: 'Height in source pixels.' },
});

const insets = object({
    top: { ...nullableNumber, description: 'Measured top side in source pixels.' },
    right: { ...nullableNumber, description: 'Measured right side in source pixels.' },
    bottom: { ...nullableNumber, description: 'Measured bottom side in source pixels.' },
    left: { ...nullableNumber, description: 'Measured left side in source pixels.' },
});

/** How a measured element or region may be reused by another role. */
const measuredKind = {
    type: 'string',
    enum: ['text', 'image', 'icon', 'logo', 'control', 'card', 'background', 'ornament', 'layer', 'other'],
    description: 'What the item is, so another role can decide whether to reuse its crop.',
};

/** The confidence scale of a measurement. */
const confidence = {
    type: 'string',
    enum: ['high', 'medium', 'low', 'unknown'],
    description: 'high only when the numbers were actually read; low when they were inferred.',
};

/**
 * The measurement sheet of one reference: the geometry, the colours and the typography of a
 * picture, with the evidence behind every number.
 */
export const MEASUREMENT_SCHEMA = object({
    summary: { ...string, description: 'What the reference shows and how it was measured.' },
    source: { ...string, description: 'The reference file or image this sheet measures.' },
    unit: { ...string, description: 'Source unit of every raw number, usually px; CSS units belong in units and css.' },
    units: object({
        source: { ...string, description: 'Source unit such as px, pt, cm, or unknown.' },
        rootFontSize: { ...nullableNumber, description: 'Source pixels per 1rem when a root size can be supported; null when it is only a guess.' },
        scale: { ...nullableNumber, description: 'CSS pixels per source unit when the reference is scaled; null when unknown.' },
        preferred: { ...strings, description: 'CSS units suitable for the target, such as rem, em, %, vw, vh, ch.' },
        notes: { ...string, description: 'How the units were chosen and which conversions are assumptions.' },
    }),
    confidence: { ...confidence, description: 'Overall confidence in this sheet; low when key values are inferred.' },
    assumptions: { ...strings, description: 'Every inferred value or interpretation that is not directly measured.' },
    colors: object({
        palette: {
            type: 'array',
            description: 'Every colour the sheet relies on, in the order the reference uses them. One entry per distinct colour, not per element.',
            items: object({
                name: { ...string, description: 'What this colour is for: background, surface, text, muted-text, accent, border, success, danger, or a free name for anything else.' },
                hex: { ...string, description: 'sRGB hex exactly as sample_colors returned it (#rrggbb). Empty when the colour was only perceived.' },
                oklch: { ...string, description: 'OKLCH as sample_colors returned it, e.g. oklch(0.62 0.19 132.4). The perceptual value: use it when the hex reads wrong. Empty when not sampled.' },
                hsl: { ...string, description: 'HSL form of the same bytes, for a reader that thinks in HSL. Empty when not sampled.' },
                rgb: { ...string, description: 'rgb() form of the same bytes. Empty when not sampled.' },
                luminance: { ...nullableNumber, description: 'WCAG relative luminance 0..1 from sample_colors; null when not sampled.' },
                share: { ...nullableNumber, description: 'Coverage of the sampled area, 0..1, from sample_colors; null when not sampled or sampled at a point.' },
                method: { type: 'string', enum: ['sampled', 'perceived', 'inferred', ''], description: 'sampled: read from pixels by sample_colors. perceived: read off the picture. inferred: reasoned from a neighbouring element. Empty when unknown.' },
                box: { ...box, description: 'The box this colour was sampled from, in source pixels; null sides when it was sampled from the whole canvas.' },
                source: { ...nullableString, description: 'The image this colour was sampled from: the sub-reference path when one exists. Null when it is the sheet source.' },
                confidence: { ...confidence, description: 'high only for a sampled value; a perceived colour is never high.' },
                notes: { ...string, description: 'What is uncertain about this colour: a gradient, a blend, a photo white balance, a colour that only appears in a shadow. Empty when nothing.' },
            }),
        },
        background: { ...nullableString, description: 'The page/canvas background as hex, from sample_colors on the whole canvas. Null when not sampled.' },
        text: { ...nullableString, description: 'The dominant text colour as hex, from sample_colors over a text box. Null when not sampled.' },
        accent: { ...nullableString, description: 'The accent/brand colour as hex, from sample_colors over the element that carries it. Null when not sampled.' },
        colorSpace: object({
            working: { ...string, description: 'The working colour space the numbers are in, from sample_colors. Usually sRGB.' },
            encoding: { ...string, description: 'The transfer curve the stored bytes use, from sample_colors. Empty when unknown.' },
            assumption: { ...string, description: 'The assumption every value in this section rests on, copied from sample_colors. When the reference is a photo of a screen, say that the white balance is unknown here.' },
        }),
        notes: { ...string, description: 'Colour-only caveats the coder needs: gradients, blends, a plate whose white balance cannot be recovered, a colour that is only correct inside this file. Empty when nothing.' },
    }),
    canvas: { ...box, description: 'The whole reference size.' },
    elements: {
        type: 'array',
        description: 'Every element that carries a number: text block, control, icon, image, ornament.',
        items: object({
            name: { ...string, description: 'Short element name the author can reuse.' },
            kind: measuredKind,
            box,
            rotation: { ...nullableNumber, description: 'Turn clockwise from upright, in degrees. Null when straight or unreadable.' },
            borders: { ...string, description: 'Where the borders and edges fall and how thick they are; empty when none.' },
            radius: { ...nullableNumber, description: 'Corner radius in source pixels. Null when square or unknown.' },
            padding: { ...insets, description: 'Numeric inner spacing by side in source pixels; use null for sides that cannot be measured.' },
            margin: { ...insets, description: 'Numeric outer spacing by side in source pixels; use null for sides that cannot be measured.' },
            gap: { ...nullableNumber, description: 'Numeric gap to adjacent items in source pixels, or null when unknown.' },
            spacing: { ...string, description: 'Additional spacing notes; prefer numeric padding, margin, and gap fields when measurable.' },
            placement: { ...string, description: 'How to place it: grid or flex track, absolute anchor, stacking order; empty when unknown.' },
            css: { ...string, description: 'Ready CSS declarations with explicit units for this element, such as width: 12.5rem; padding: 1rem 1.25rem; font-size: 1.75rem; line-height: 1.2. Empty when no reliable conversion exists.' },
            typography: {
                ...object({
                    role: { ...string, description: 'Text role such as heading, body, label, or button.' },
                    family: { ...string, description: 'Visually identified family only when useful; empty when unknown. Do not guess an exact identity.' },
                    familyConfidence: { ...confidence, description: 'Confidence that the visible family identification is correct; unknown when it cannot be identified.' },
                    fontSize: { ...nullableNumber, description: 'Measured font size in source pixels.' },
                    weight: { ...nullableNumber, description: 'Measured or estimated CSS numeric font weight; null when unreadable.' },
                    lineHeight: { ...nullableNumber, description: 'Measured line height in source pixels.' },
                    letterSpacing: { ...nullableNumber, description: 'Measured letter spacing in source pixels.' },
                    style: { ...string, description: 'Visible style such as italic, uppercase, or underline; empty when none.' },
                }),
                type: ['object', 'null'],
                description: 'Typography measurements for text elements; null for non-text elements.',
            },
            confidence: { ...confidence, description: 'Confidence in this element: high only when its numbers were actually read.' },
            colors: {
                type: 'array',
                description: 'The colours that carry this element: its fill, its text, its border, its shadow. Sample them with sample_colors over this element box; do not guess a colour you did not read off the pixels.',
                items: object({
                    role: { ...string, description: 'fill, text, border, shadow, icon, or another part this colour belongs to.' },
                    hex: { ...string, description: 'sRGB hex exactly as sample_colors returned it. Empty when only perceived.' },
                    oklch: { ...string, description: 'OKLCH as returned by sample_colors — the perceptual value, what a later role should trust when the hex looks wrong.' },
                    method: { type: 'string', enum: ['sampled', 'perceived', 'inferred', ''], description: 'sampled from pixels, perceived by eye, or inferred from a neighbour.' },
                    contrast: { ...nullableNumber, description: 'WCAG contrast ratio against the surface it sits on, from sample_colors; null when not computed.' },
                    confidence: { ...confidence, description: 'high only when sampled.' },
                }),
            },
            source: { ...nullableString, description: 'Path or file name of the image this box was measured on: the sub-reference when one exists, the sheet source otherwise; null when it is the sheet source.' },
            notes: { ...string, description: 'What is inferred, ambiguous, or hidden; empty when the element is fully measured.' },
            use: { ...string, description: 'How another role should reuse this element or its crop; empty when it is only a measurement target.' },
            crop: { ...nullableString, description: 'Project-relative path to an existing crop of this element, or null.' },
        }),
    },
    regions: {
        type: 'array',
        description: 'How the picture divides into crops, artwork regions, and layers. Prefer many small, reusable fragments over a few large ones.',
        items: object({
            name: { ...string, description: 'Region name the author can reuse.' },
            kind: measuredKind,
            box,
            how: { ...string, description: 'What the crop contains and how to cut it out (crop_image or split_image with these numbers).' },
            use: { ...string, description: 'Which role reuses this fragment and for what, such as artwork reference, icon source, or background layer.' },
            source: { ...nullableString, description: 'Path or file name of the image this region was measured on: the sub-reference when one exists, the sheet source otherwise; null when it is the sheet source.' },
            crop: { ...nullableString, description: 'Project-relative path to an existing crop of this region, or null. The worker reuses it as a reference.' },
        }),
    },
    rules: {
        type: 'array',
        description: 'Repeated measures: spacing scale, ratios, column width, baseline step.',
        items: object({
            name: { ...string, description: 'What this rule covers.' },
            value: { ...nullableNumber, description: 'Numeric measured value, in the sheet unit.' },
            unit: { ...string, description: 'Unit for this value, usually px.' },
            css: { ...string, description: 'CSS form of this rule with an explicit unit, such as --space-2: 0.5rem or 1.5rem.' },
            from: { ...string, description: 'What it was measured between; empty for a global rule.' },
        }),
    },
    notes: { ...string, description: 'What is uncertain and what needs a re-measure on a crop; empty when nothing.' },
});

/**
 * The design direction of the designer role: layout, typography, colour, spacing, the assets and
 * the tokens of `DESIGN.md`.
 */
export const DESIGN_SCHEMA = object({
    summary: { ...string, description: 'What the design direction covers and how it was chosen.' },
    layout: {
        ...object({
            summary: { ...string, description: 'Page structure and component layout in prose.' },
            structure: {
                type: 'array',
                description: 'Sections and components in visual order, top to bottom.',
                items: object({
                    name: { ...string, description: 'Short section or component name.' },
                    type: { type: 'string', enum: ['header', 'hero', 'grid', 'card', 'nav', 'footer', 'aside', 'main', 'section', 'other'], description: 'What kind of block this is.' },
                    purpose: { ...string, description: 'What this section does and what it contains.' },
                    children: { ...strings, description: 'Names of child sections or components; empty when it is a leaf.' },
                }),
            },
        }),
        description: 'Layout structure: sections, components, and their order.',
    },
    typography: {
        ...object({
            family: { ...string, description: 'Primary body font family recommendation.' },
            headingFamily: { ...nullableString, description: 'Heading font family; null when the same as body.' },
            scale: { ...string, description: 'Type scale description (e.g. "1.25 major-third").' },
            weights: { ...strings, description: 'Recommended weights, such as 400 and 700.' },
            cssFamily: { ...string, description: 'CSS font-family value with a suitable fallback.' },
        }),
        description: 'Typography direction: families, scale, and weights.',
    },
    color: {
        ...object({
            palette: {
                ...object({
                    name: { ...string, description: 'Name of the palette (e.g. "moooi-light").' },
                    colors: {
                        type: 'array',
                        description: 'Palette colours in semantic order.',
                        items: object({
                            name: { ...string, description: 'Token name (e.g. "primary", "surface", "accent").' },
                            value: { ...string, description: 'CSS colour value (hex or rgb).' },
                            role: { ...string, description: 'What this colour is used for.' },
                        }),
                    },
                }),
                description: 'The colour palette.',
            },
            gradients: {
                type: 'array',
                description: 'Gradient definitions for backgrounds and accents; empty when none.',
                items: object({
                    name: { ...string, description: 'Gradient name (e.g. "hero-bg").' },
                    stops: { ...strings, description: 'Colour stops in order, e.g. ["#f0f0f0", "#d0d0d0"].' },
                    direction: { ...string, description: 'CSS gradient direction (e.g. "to bottom right").' },
                }),
            },
        }),
        description: 'Colour direction: palette and gradients.',
    },
    spacing: {
        ...object({
            scale: {
                type: 'array',
                description: 'Base spacing values in px (e.g. [4, 8, 16, 24, 32, 48]).',
                items: { type: 'number' },
            },
            rules: { ...strings, description: 'Spacing conventions and rules.' },
        }),
        description: 'Spacing scale and layout rules.',
    },
    assets: {
        ...object({
            generated: {
                type: 'array',
                description: 'Images generated by the designer through the external ai-image CLI; empty when none.',
                items: object({
                    path: { ...string, description: 'Project-relative output path of the generated image.' },
                    size: { ...string, description: 'Resolution as WIDTHxHEIGHT (e.g. "1920x1080").' },
                    purpose: { ...string, description: 'What this asset is for.' },
                }),
            },
            external: {
                type: 'array',
                description: 'Verified external resources used for the design; empty when none.',
                items: object({
                    url: { ...string, description: 'URL of the external resource.' },
                    purpose: { ...string, description: 'What was taken from this resource.' },
                    cached: { type: 'boolean', description: 'Whether the result was served from the local cache.' },
                }),
            },
        }),
        description: 'Assets produced or referenced by the design.',
    },
    template: {
        ...object({
            path: { ...string, description: 'Project-relative path to the generated HTML skeleton; empty when no template was written.' },
            description: { ...string, description: 'What the template covers and how the worker should extend it.' },
        }),
        description: 'HTML template skeleton; empty when no template was produced.',
    },
    designMd: {
        ...object({
            read: { type: 'boolean', description: 'Whether DESIGN.md was found and read.' },
            tokens: { ...strings, description: 'Key design tokens and conventions extracted from DESIGN.md.' },
            conflicts: { ...strings, description: 'Conflicts between DESIGN.md and the generated direction; empty when none.' },
        }),
        description: 'DESIGN.md discovery and token extraction.',
    },
    notes: { ...strings, description: 'Ambiguities, assumptions, or limitations.' },
});

/**
 * The plan of the crops: which rectangles of which picture are worth cutting out.
 *
 * The cropper reads the picture, names the fragments a later role will reuse and gives the box of
 * every one of them. The harness cuts the files; the model never writes them itself.
 */
export const CROP_PLAN_SCHEMA = object({
    summary: { ...string, description: 'What the picture holds and how it was split into fragments.' },
    source: { ...string, description: 'The picture the plan was made on.' },
    crops: {
        type: 'array',
        description: 'The fragments worth cutting out, in the order they should be cut.',
        items: object({
            name: { ...string, description: 'Short fragment name, used in the file name.' },
            kind: measuredKind,
            box,
            how: { ...string, description: 'What the fragment contains and how to cut it.' },
            use: { ...string, description: 'Which role reuses this fragment and for what.' },
            source: { ...nullableString, description: 'The picture the box belongs to; null when it is the plan source.' },
            confidence: { ...confidence, description: 'How sure the box is.' },
        }),
    },
    notes: { ...string, description: 'What was left out and why; empty when nothing.' },
});

/**
 * The zones of a reference: what is where, before anything is measured.
 *
 * The segmentation is the cheapest stage and the most useful one: it names the parts of the
 * picture and their boxes, so that the stages after it do not have to look for them again.
 * It measures nothing else — no padding, no colours, no fonts. Those are other stages.
 */
export const SEGMENTATION_SCHEMA = object({
    summary: { ...string, description: 'What the reference shows and how it was split into zones.' },
    source: { ...string, description: 'The reference file this segmentation was made on.' },
    canvas: { ...box, description: 'The whole reference size.' },
    zones: {
        type: 'array',
        description: 'Every zone of the picture, from the largest region to the smallest element. One zone holds one thing: an object and the surface behind it are two zones.',
        items: object({
            name: { ...string, description: 'Short zone name the author can reuse: left-rail, hero-card, award-badge, contact-email. It says what the zone holds.' },
            kind: measuredKind,
            box,
            role: { ...string, description: 'What the zone is in the page: header, hero, aside, card, button, label. Empty when unknown.' },
            use: { ...string, description: 'How another role would reuse this zone: artwork, icon source, text block, background layer. Empty when nothing.' },
            crop: {
                type: 'string',
                enum: ['asset', 'detail', 'none'],
                description: 'asset: a fragment worth cutting out and reusing as an asset. detail: a fragment worth cutting to be read closely. none: the box is enough, cut nothing.',
            },
            hasText: { type: 'boolean', description: 'Whether the zone holds visible text. The recognizer reads it; the segmentator does not.' },
            notes: { ...string, description: 'What is ambiguous about this zone; empty when nothing.' },
        }),
    },
    notes: { ...string, description: 'What was left out and why; empty when nothing.' },
});

/**
 * The geometry of the zones: the CSS numbers of a segmented picture.
 *
 * The boxes are known from the segmentation — the measurer does not look for them again. It
 * measures what a box cannot tell: the display, the inner and the outer spacing, the borders,
 * the radius, the rotation and the placement.
 */
export const GEOMETRY_SCHEMA = object({
    summary: { ...string, description: 'What was measured and how.' },
    source: { ...string, description: 'The reference file these numbers belong to.' },
    unit: { ...string, description: 'Source unit of every raw number, usually px.' },
    units: object({
        source: { ...string, description: 'Source unit such as px, pt, cm, or unknown.' },
        rootFontSize: { ...nullableNumber, description: 'Source pixels per 1rem when a root size can be supported; null when it is only a guess.' },
        scale: { ...nullableNumber, description: 'CSS pixels per source unit when the reference is scaled; null when unknown.' },
        preferred: { ...strings, description: 'CSS units suitable for the target, such as rem, em, %, vw, vh, ch.' },
        notes: { ...string, description: 'How the units were chosen and which conversions are assumptions.' },
    }),
    confidence: { ...confidence, description: 'Overall confidence in these numbers; low when key values are inferred.' },
    assumptions: { ...strings, description: 'Every inferred value or interpretation that is not directly measured.' },
    elements: {
        type: 'array',
        description: 'One entry per zone that carries a number. A zone without a measured value may be left out.',
        items: object({
            zone: { ...string, description: 'The name of the zone from the segmentation. It must match it exactly.' },
            display: { ...string, description: 'How the zone lays its content out: block, flex, grid, inline-flex, absolute, inline. Empty when unknown.' },
            padding: { ...insets, description: 'Numeric inner spacing by side in source pixels; use null for sides that cannot be measured.' },
            margin: { ...insets, description: 'Numeric outer spacing by side in source pixels; use null for sides that cannot be measured.' },
            gap: { ...nullableNumber, description: 'Numeric gap between the children of the zone in source pixels, or null when unknown.' },
            borders: { ...string, description: 'Where the borders and edges fall and how thick they are; empty when none.' },
            radius: { ...nullableNumber, description: 'Corner radius in source pixels. Null when square or unknown.' },
            rotation: { ...nullableNumber, description: 'Turn clockwise from upright, in degrees. Null when straight or unreadable.' },
            placement: { ...string, description: 'How to place it: grid or flex track, absolute anchor, stacking order; empty when unknown.' },
            css: { ...string, description: 'Ready CSS declarations with explicit units for this zone, such as width: 12.5rem; padding: 1rem 1.25rem. Empty when no reliable conversion exists.' },
            confidence: { ...confidence, description: 'Confidence in this zone: high only when its numbers were actually read.' },
            notes: { ...string, description: 'What is inferred, ambiguous, or hidden; empty when the zone is fully measured.' },
        }),
    },
    rules: {
        type: 'array',
        description: 'Repeated measures: spacing scale, ratios, column width, baseline step.',
        items: object({
            name: { ...string, description: 'What this rule covers.' },
            value: { ...nullableNumber, description: 'Numeric measured value, in the sheet unit.' },
            unit: { ...string, description: 'Unit for this value, usually px.' },
            css: { ...string, description: 'CSS form of this rule with an explicit unit, such as --space-2: 0.5rem or 1.5rem.' },
            from: { ...string, description: 'What it was measured between; empty for a global rule.' },
        }),
    },
    notes: { ...string, description: 'What is uncertain and what needs a re-measure on a crop; empty when nothing.' },
});

/**
 * The texts and the fonts of the zones: what the picture says.
 *
 * The recognizer reads the fragments of the text zones and writes down the words and the
 * typography. It measures no geometry — that is the measurer's job.
 */
export const RECOGNITION_SCHEMA = object({
    summary: { ...string, description: 'What was read and where it was read.' },
    texts: {
        type: 'array',
        description: 'One entry per text zone that was read.',
        items: object({
            zone: { ...string, description: 'The name of the zone from the segmentation. It must match it exactly.' },
            text: { ...string, description: 'The visible text, exactly as it is written. Empty when the zone holds no readable text.' },
            role: { ...string, description: 'What the text is: heading, subheading, body, label, button, caption, tag. Empty when unknown.' },
            family: { ...string, description: 'The font family, when it can be identified. Do not guess an exact identity; empty when unknown.' },
            familyConfidence: { ...confidence, description: 'Confidence that the visible family identification is correct; unknown when it cannot be identified.' },
            fontSize: { ...nullableNumber, description: 'Measured font size in source pixels.' },
            weight: { ...nullableNumber, description: 'Measured or estimated CSS numeric font weight; null when unreadable.' },
            lineHeight: { ...nullableNumber, description: 'Measured line height in source pixels.' },
            letterSpacing: { ...nullableNumber, description: 'Measured letter spacing in source pixels.' },
            style: { ...string, description: 'Visible style such as italic, uppercase, or underline; empty when none.' },
            confidence: { ...confidence, description: 'Confidence in this text; high only when it was read clearly.' },
            notes: { ...string, description: 'What is uncertain about this text; empty when nothing.' },
        }),
    },
    notes: { ...string, description: 'What could not be read and why; empty when nothing.' },
});

/**
 * The palette of a reference: the colours it relies on, named.
 *
 * The sampler reads the pixels (locally or with the model) and names what every colour is for.
 */
export const PALETTE_SCHEMA = object({
    summary: { ...string, description: 'What the palette covers and how the colours were read.' },
    colors: {
        type: 'array',
        description: 'Every distinct colour the reference relies on, in the order it uses them.',
        items: object({
            name: { ...string, description: 'What this colour is for: background, surface, text, muted-text, accent, border, or a free name.' },
            hex: { ...string, description: 'sRGB hex of the colour (#rrggbb). Empty when the colour was only perceived.' },
            oklch: { ...string, description: 'OKLCH of the same bytes, e.g. oklch(0.62 0.19 132.4). Empty when unknown.' },
            hsl: { ...string, description: 'HSL form of the same bytes. Empty when unknown.' },
            rgb: { ...string, description: 'rgb() form of the same bytes. Empty when unknown.' },
            luminance: { ...nullableNumber, description: 'WCAG relative luminance 0..1; null when not measured.' },
            share: { ...nullableNumber, description: 'Coverage of the sampled area, 0..1; null when unknown.' },
            method: { type: 'string', enum: ['sampled', 'perceived', 'inferred', ''], description: 'sampled: read from the pixels. perceived: read off the picture. inferred: reasoned from a neighbour. Empty when unknown.' },
            zone: { ...string, description: 'The zone this colour was read from; empty when it was read from the whole canvas.' },
            role: { ...string, description: 'What part of the element the colour belongs to: background, text, border, fill, icon, shadow. Empty when unknown.' },
            contrast: { ...nullableNumber, description: 'WCAG contrast ratio against the surface it sits on; null when not computed.' },
            confidence: { ...confidence, description: 'high only for a sampled value; a perceived colour is never high.' },
            notes: { ...string, description: 'What is uncertain about this colour: a gradient, a blend, a photo white balance. Empty when nothing.' },
        }),
    },
    background: { ...nullableString, description: 'The page/canvas background as hex. Null when not known.' },
    text: { ...nullableString, description: 'The dominant text colour as hex. Null when not known.' },
    accent: { ...nullableString, description: 'The accent/brand colour as hex. Null when not known.' },
    colorSpace: object({
        working: { ...string, description: 'The working colour space the numbers are in, usually sRGB.' },
        encoding: { ...string, description: 'The transfer curve the stored bytes use. Empty when unknown.' },
        assumption: { ...string, description: 'The assumption every value in this section rests on. Empty when nothing.' },
    }),
    notes: { ...string, description: 'Colour-only caveats the coder needs: gradients, blends, a plate whose white balance cannot be recovered. Empty when nothing.' },
});

/**
 * Wrap a schema for the Responses API: a strict JSON schema with a name.
 * @param {string} name the name of the schema
 * @param {object} schema the schema itself
 * @returns {object}
 * @ai.hint pure
 */
export function strictSchema(name, schema) {
    return { name, schema, strict: true };
}

/**
 * Check that every object of a schema is strict: all the properties are required and the extra
 * ones are rejected.
 *
 * The check walks the schema the way the API reads it: objects, arrays of objects and the
 * `anyOf`/`oneOf` branches.
 * @param {object} schema
 * @returns {string[]} the problems; empty when the schema is strict
 * @exports
 * @ai.hint pure
 */
export function strictnessProblems(schema) {
    const problems = [];
    const walk = (node, where) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${where}[${index}]`));
            return;
        }
        if (node.type === 'object' || node.properties) {
            const keys = Object.keys(node.properties ?? {});
            const required = Array.isArray(node.required) ? node.required : [];
            for (const key of keys) {
                if (!required.includes(key)) problems.push(`${where}.${key}: not required`);
            }
            for (const key of required) {
                if (!keys.includes(key)) problems.push(`${where}.required: ${key} is not a property`);
            }
            if (node.additionalProperties !== false) problems.push(`${where}: additionalProperties is not false`);
            for (const [key, value] of Object.entries(node.properties ?? {})) {
                walk(value, `${where}.${key}`);
            }
        }
        if (node.items) walk(node.items, `${where}[]`);
        for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) walk(branch, `${where}|`);
    };
    walk(schema, '$');
    return problems;
}

/**
 * Check an answer against the schema it was asked for.
 *
 * The API holds a model to a schema only when the backend really applies the format rule. A
 * gateway that drops it lets the model answer in its own words: the field the harness reads
 * is called something else, and the answer looks fine to everybody but the harness. The
 * harness has to see that itself — a silent answer that fits nothing is no answer at all.
 *
 * @param {unknown} data the answer of the model
 * @param {object} schema the schema the answer should follow
 * @returns {string[]} the problems; empty when the answer follows the schema
 * @exports
 * @ai.hint pure
 */
export function schemaProblems(data, schema) {
    const problems = [];
    const walk = (value, node, where) => {
        if (!node || typeof node !== 'object') return;
        const types = Array.isArray(node.type) ? node.type : (node.type ? [node.type] : []);
        // A null is a value of its own in these schemas: "not measured" is an answer.
        if (types.includes('null') && value === null) return;
        if (types.includes('object')) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                problems.push(`${where}: an object was expected`);
                return;
            }
            const properties = node.properties ?? {};
            for (const key of node.required ?? []) {
                if (!(key in value)) problems.push(`${where}.${key}: the field is missing`);
            }
            for (const key of Object.keys(value)) {
                if (!Object.hasOwn(properties, key)) problems.push(`${where}.${key}: the field is not in the schema`);
            }
            for (const [key, sub] of Object.entries(properties)) {
                if (key in value) walk(value[key], sub, `${where}.${key}`);
            }
            return;
        }
        if (types.includes('array')) {
            if (!Array.isArray(value)) {
                problems.push(`${where}: an array was expected`);
                return;
            }
            value.forEach((item, index) => walk(item, node.items, `${where}[${index}]`));
            return;
        }
        if (types.includes('string')) {
            if (typeof value !== 'string') {
                problems.push(`${where}: a string was expected`);
                return;
            }
            if (Array.isArray(node.enum) && !node.enum.includes(value)) {
                problems.push(`${where}: "${value}" is not one of ${node.enum.join(', ')}`);
            }
            return;
        }
        if (types.includes('number')) {
            if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${where}: a number was expected`);
            return;
        }
        if (types.includes('boolean') && typeof value !== 'boolean') {
            problems.push(`${where}: a boolean was expected`);
        }
    };
    walk(data, schema, '$');
    return problems;
}

/**
 * The problems of an answer as one line, for a warning a person reads.
 *
 * The list of the problems may be long — one line per field of every zone — and the warning
 * has to stay readable: the first few problems are named, the rest are counted.
 * @param {string[]} problems the problems of the answer
 * @param {number} [limit] how many problems are named
 * @returns {string} the line; empty when there are no problems
 * @exports
 * @ai.hint pure
 */
export function schemaProblemsText(problems, limit = 6) {
    const list = (Array.isArray(problems) ? problems : []).filter(Boolean);
    if (!list.length) return '';
    const shown = list.slice(0, Math.max(1, limit));
    const rest = list.length - shown.length;
    return `${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}`;
}
