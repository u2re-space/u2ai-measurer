/**
 * @file src/agent/documentation.js
 * @module agent/documentation
 * @purpose The standards a role may be given as documentation.
 *
 *   The measurer writes CSS-ready numbers, so it needs to know what the units mean and what the
 *   accessibility thresholds are. The designer names tokens, so it needs the icon sets and the
 *   font catalogue. The texts live in the package: they are short, stable and part of the
 *   behaviour of the roles, not something a user has to download.
 *
 *   The config decides which of them a role gets: `documentation.roles.measurer` and
 *   `documentation.roles.designer` list the names of the sources.
 *
 * @depends config/constants
 * @usedBy roles/index, shared/pipeline
 * @exports DOCUMENTATION, documentationFor, documentationNames
 * @ai.tags documentation, css, standards
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

import { ENUMS } from '../config/constants.js';

/**
 * The texts of the standards, by the name the config uses.
 * @type {Readonly<Record<string, string>>}
 */
export const DOCUMENTATION = Object.freeze({
    cssUnits: `# CSS units

<https://drafts.csswg.org/css-values-5/>

Absolute: \`px\` (CSS pixels), \`in\`, \`cm\`, \`mm\`, \`q\`, \`pt\`, \`pc\`. 1in = 96px, 1pt = 1.333px.

Font-relative: \`rem\` = the root font size (16px unless the reference proves another),
\`em\` = the font size of the element itself, \`ch\` = the width of the "0" glyph,
\`ex\` = the height of the x-height.

Viewport-relative: \`vw\`, \`vh\`, \`vmin\`, \`vmax\` = 1% of the viewport size.

Container-relative: \`cqw\`, \`cqh\`, \`cqi\`, \`cqb\` = 1% of the container size.

Percentage: \`%\` — relative to the containing block for sizes, to the line box for line-height.

Rules for a measurement sheet:
- keep the raw numbers in the source unit (usually px) and give the CSS value with an explicit unit;
- prefer \`rem\` for type and spacing, \`%\`/\`vw\`/\`vh\` for fluid layout, \`px\` for hairlines,
  borders and small radii;
- never mix units inside one value;
- state the assumed root size and every conversion in the notes.`,

    cssColors: `# CSS colours

<https://drafts.csswg.org/css-color-5/>

A colour in CSS is one of the notations below; they are the same colour, and a sheet may
carry more than one of them when the reader has to check the value.

- hex: \`#f1463f\`, \`#f1463fff\` (with alpha), \`#f14\` (short).
- rgb: \`rgb(241 70 63)\`, \`rgb(241 70 63 / 0.5)\`. The legacy comma form is the same.
- hsl: \`hsl(2.4 86.4% 59.6%)\` — hue in degrees, saturation and lightness in percents.
- hwb: \`hwb(2.4 24.7% 5.5%)\` — hue, whiteness, blackness.
- oklab: \`oklab(0.6414 0.1857 0.0953)\` — lightness, a, b on the perceptual axes.
- oklch: \`oklch(0.6414 0.2087 27.18)\` — lightness, chroma, hue. The most stable notation:
  two readers with a different gamma still agree on the lightness of an OKLCH colour.
- lab: \`lab(56.35 65.42 44.3)\`, lch: \`lch(56.35 79.01 34.1)\` — the CIE spaces.
- Display-P3: \`color(display-p3 0.8726 0.329 0.2822)\` — wider than sRGB.
- \`currentColor\` takes the colour of the element; \`transparent\` is \`rgb(0 0 0 / 0)\`.

The spaces and the rules:
- sRGB is the default space of a screen; a hex value is the sRGB truth of the bytes.
- OKLCH is the notation to prefer for a token: its lightness is perceptual, so a dark grey
  reads as dark grey in every colour management.
- HSL is what designers quote, but its lightness is not perceptual: a saturated yellow and a
  saturated blue with the same HSL lightness are not equally bright.
- LAB/LCH are the measurement spaces: use them to compare two colours that do not share a hue.
- Display-P3 only matters when the target display is wide-gamut; check that the colour still
  fits sRGB before shipping a hex.

Alpha:
- \`rgb(241 70 63 / 0.5)\` is a translucent colour; it has no contrast of its own — it has the
  contrast of the composite over the surface it sits on.
- \`color-mix(in oklab, #f1463f 50%, white)\` mixes two colours in a named space; mixing in
  sRGB is the default and is the one that shifts the hue the most.

Measure and report:
- sample the pixels with \`sample_colors\` — that is the ground truth;
- convert a quoted colour with \`parse_color\` — that is the exact value of the text;
- never present a perceived colour as a sampled one.

The difference between two colours is measured as CIEDE2000 (\`ΔE00\`): below 1 is the same
colour, 1..2 is a difference nobody sees, 2..10 is a visible difference, above 10 is another
colour.`,

    cssDisplay: `# CSS display, position and layout

<https://drafts.csswg.org/css-display/>

\`display\` decides how a box takes part in the layout:
- \`block\` — a box on its own line, the default of a div.
- \`inline\` — a box in the text flow; width and height do not apply.
- \`inline-block\` — inline, but it keeps its own box, so width, height and padding apply.
- \`flex\` / \`inline-flex\` — the children are flex items.
- \`grid\` / \`inline-grid\` — the children are grid items.
- \`contents\` — the box disappears and the children take its place.
- \`flow-root\` — a block that contains its floats.
- \`none\` — the box is not rendered at all.

\`position\`:
- \`static\` — the default, the box follows the flow.
- \`relative\` — the box stays in the flow but is offset by \`top\`/\`right\`/\`bottom\`/\`left\`.
- \`absolute\` — the box leaves the flow and is placed against the nearest positioned ancestor.
- \`fixed\` — the box is placed against the viewport.
- \`sticky\` — the box follows the scroll until its container ends.

Stacking: \`z-index\` only works on a positioned element or a flex/grid item; the default is
\`auto\`, and a negative value puts the element behind the content of its stacking context.

The box model: \`content-box\` (the default) adds padding and border to the width,
\`border-box\` (the common choice) takes them out of it. Every measurement is the border box
unless the sheet says otherwise.

Overflow and clipping: \`overflow: hidden | scroll | auto | clip\`, \`overflow-x\` and
\`overflow-y\` for one axis. A picture with rounded corners is clipped by
\`border-radius\` and \`overflow: hidden\` together.

Gaps and spacing: \`gap\` (grid and flex), \`margin\` (outside the box, may be negative),
\`padding\` (inside the box, never negative).

In a measurement sheet, report the display of the element, its position, its z-index when it
overlaps another box, and the box model in use — a coder cannot rebuild the layout without them.`,

    cssShapes: `# CSS shapes

<https://drafts.csswg.org/css-shapes-2/>

Border radius: \`border-radius: <radius>\` — one value for all corners, four values for
top-left / top-right / bottom-right / bottom-left, or a shorthand with a slash: \`8px / 16px\`.

Circles: a square box with \`border-radius: 50%\`. Pills: a box with \`border-radius: 999px\`.

Clip paths: \`clip-path: polygon(...)\` for straight edges, \`circle()\`, \`ellipse()\`,
\`inset()\`, \`path()\` for an SVG path. Masks: \`mask-image\`, \`mask-size\`, \`mask-position\`,
\`mask-repeat\`, \`mask-composite\`.

Dividers: a 1px line is a border (\`border-bottom: 1px solid\`) or a \`::after\` with
\`height: 1px\` — never a 2px shadow that fakes it.

Measure the radius from the picture as the distance from the corner of the box to the start of
the straight edge; report it as px.`,

    cssTransform: `# CSS transforms

<https://drafts.csswg.org/css-transforms-2/>

\`transform: translate(x, y) rotate(deg) scale(x, y) skew(deg, deg)\` — the functions apply from
right to left.

Rotation is measured in degrees clockwise from upright. A negative value turns counter-clockwise.
\`transform-origin\` sets the pivot; the default is the centre of the box.

For a rotated element report: the rotation in degrees, the box of the element before the
rotation, and the placement of the pivot (usually the centre of the box).`,

    cssMotion: `# CSS motion

<https://drafts.csswg.org/motion/>

Transitions: \`transition: <property> <duration> <easing> <delay>\`; the default duration is 0s.
Easings: \`linear\`, \`ease\`, \`ease-in\`, \`ease-out\`, \`ease-in-out\`, \`cubic-bezier(...)\`.

Animations: \`@keyframes\` + \`animation: <name> <duration> <easing> <delay> <iteration> <direction>\`.

Reduced motion: \`@media (prefers-reduced-motion: reduce)\` must switch the long transitions off.

A measurement sheet reports what is visible, not the motion: the state of the picture is the
state to measure.`,

    cssContain: `# CSS containment and performance

<https://drafts.csswg.org/css-contain/>

\`contain: size | layout | style | paint\` — the sizes the element must not depend on outside itself.
\`content-visibility: auto\` + \`contain-intrinsic-size\` skips the rendering of the off-screen parts.

They change the layout of a component, never the geometry of a reference picture: report the
geometry, not the optimisation.`,

    cssImages: `# CSS images

<https://drafts.csswg.org/css-images-5/>

\`object-fit: cover | contain | fill | none | scale-down\` with \`object-position\` — the image keeps
its own proportions inside the box.

\`aspect-ratio: 16 / 9\` keeps the box when the picture is stretched.

A picture with its own background is a \`background-image\` with \`background-size\` and
\`background-position\`; a picture that fills the box and hides what is under it is a normal
\`<img>\` with \`object-fit: cover\`.

Measure the box of the image element, not the visible part of the picture inside it.`,

    cssMasking: `# CSS masking

<https://drafts.csswg.org/css-masking/>

\`mask-image\` takes a gradient or an SVG mask; \`mask-size\`, \`mask-position\`, \`mask-repeat\`
and \`mask-composite\` control it. The webkit prefixes (\`-webkit-mask\`) are still needed for
Safari.

A mask fades a picture out; it does not change its box. Measure the box and note the fade as a
visual property, not as a crop.`,

    cssFonts: `# CSS fonts

<https://drafts.csswg.org/css-fonts/>

\`font-family\` — a list of families with fallbacks. A family with spaces needs quotes.
Generic families: \`serif\`, \`sans-serif\`, \`monospace\`, \`cursive\`, \`fantasy\`, \`system-ui\`,
\`ui-monospace\`, \`emoji\`, \`math\`.

\`font-size\` — px, rem, em, % or a clamp() range. \`font-weight\` — 100..900, or normal/bold.
\`line-height\` — a unitless multiplier (1.2 = 120% of the font size) or a length.
\`letter-spacing\` — a length; 0 is normal. \`font-style\` — normal/italic.
\`font-variant\`, \`font-stretch\`, \`text-transform\` — the rest of the vocabulary.

A raster picture rarely proves an exact typeface: report the visible family, mark the family
confidence as low, and never present a likely family as certain.`,

    cssGrid: `# CSS grid

- <https://drafts.csswg.org/css-display/>
- <https://drafts.csswg.org/css-grid-3/>

\`display: grid\` with \`grid-template-columns\` (\`repeat(3, 1fr)\`, \`minmax(240px, 1fr)\`,
\`200px 1fr\`) and \`grid-template-rows\`. The gap is \`gap: <row> <column>\` (one value = both).
Items are placed by \`grid-column\`, \`grid-row\`, \`grid-area\`, or automatically by the flow.

Measure the tracks: the column width, the row height, the gap between them and the alignment
(\`justify-items\`, \`align-items\`, \`justify-content\`, \`align-content\`).`,

    cssFlex: `# CSS flexbox

- <https://drafts.csswg.org/css-display/>
- <https://drafts.csswg.org/css-flexbox/>

\`display: flex\` (\`inline-flex\` for an inline box). The main axis is the row by default, the
cross axis is the column; \`flex-direction\` changes that.

\`flex: <grow> <shrink> <basis>\`, \`flex-grow\`, \`flex-shrink\`, \`flex-basis\`.
\`justify-content\` places the items along the main axis, \`align-items\` along the cross axis.
\`gap\` is the space between the items; \`row-gap\` and \`column-gap\` set one of them.

Measure the gap, the size of the items and the alignment — these three are what a reader of the
picture sees.`,

    wcagColors: `# WCAG colour rules

- <https://drafts.csswg.org/css-color-5/>
- <https://w3c.github.io/wcag/guidelines/22/>

Contrast ratio: (L1 + 0.05) / (L2 + 0.05), where L is the relative luminance of the colour.
1 = identical, 21 = black on white.

The thresholds of WCAG 2.1:
- 4.5:1 — normal text (below 18pt / 24px, or below 14pt / 18.66px bold);
- 3:1 — large text (18pt / 24px and above, or 14pt / 18.66px bold and above);
- 3:1 — the contrast of a UI component and its background (the border of a button, the edge of an input);
- 3:1 — the contrast of a graphical object that carries meaning.

A contrast below the threshold is a fact about the reference, not a judgement about the design:
report it as measured.

Use \`sample_colors\` to get the numbers. The values are sRGB bytes and OKLCH on linear light;
the white balance of a photo of a screen is unknown, and the sheet has to say so.`,

    phosphorIcons: `# Phosphor icons

<https://phosphoricons.com/>

Phosphor (MIT): a family of 900+ icons in six weights (thin, light, regular, bold, fill, duotone)
and four styles (regular, duotone, fill). The markup is a web font or an SVG sprite.

Use the regular weight for the interface, the fill for the active state. The names are descriptive:
\`arrow-right\`, \`check-circle\`, \`magnifying-glass\`, \`gear\`.

An icon in a reference picture is a measured box with a measured stroke: report the box in px and
the stroke width in px, and name the icon only when the shape is unambiguous.`,

    lucideIcons: `# Lucide icons

<https://lucide.dev/icons/>

Lucide (ISC): a family of 1400+ icons, all drawn on a 24×24 grid with a 2px stroke, the round
caps and the 2px corner radius.

The names are the words of the icon: \`arrow-right\`, \`check\`, \`search\`, \`settings\`,
\`circle-alert\`.

The 24×24 grid is the reference: an icon of 16px has a stroke of about 1.33px, an icon of 32px has
a stroke of about 2.67px. Measure the stroke of the picture, then report the size that matches it.`,

    googleFonts: `# Google Fonts

<https://fonts.google.com/>

Google Fonts (SIL Open Font License): the catalogue of the open fonts — Roboto, Open Sans,
Inter, Lora, Playfair Display, Montserrat, Source Sans 3, IBM Plex Sans, Merriweather, Poppins.

What matters for a measurement: the family name, the weight (the styles a family offers), the
italic or not, and the size. The licence lets a project self-host the font files.

A raster picture does not prove a family. Report the visible family with a low confidence, and
list the candidates separately from the measurements.`,
});

/**
 * The names of the documentation sources, in the order of the enum.
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function documentationNames() {
    return [...ENUMS.documentationSources];
}

/**
 * The documentation of one role, as one text.
 *
 * @param {string[]} names the names of the sources
 * @returns {string} empty when nothing was asked for
 * @exports
 * @ai.hint pure
 */
export function documentationFor(names = []) {
    const wanted = Array.isArray(names) ? names : [];
    const blocks = [];
    for (const name of wanted) {
        const text = DOCUMENTATION[name];
        if (!text) continue;
        blocks.push(text);
    }
    if (!blocks.length) return '';
    return blocks.join('\n\n');
}
