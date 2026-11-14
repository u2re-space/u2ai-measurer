# Examples

A run of the measurer over `landing.png`, and the pieces you can copy.

| Path | What it is |
|------|------------|
| `landing.png`, `landing.jpg` | The reference picture: an agency landing page, 1024×768. |
| `measurements.json` | The measurement sheet of that picture: the canvas, the elements, the regions, the rules, the palette. |
| `crops/` | The fragments the harness cut out of the boxes of the sheet. |
| `skills/house-style/` | An example skill pack. Copy the directory into `~/.ai-measure/skills/` and the measurer and the designer read it. |

Reproduce the run:

```bash
node bin/ai-measure.js measure landing.png --out . --effort xhigh
```

The crops are named `NN-element-<name>.png` and `NN-region-<name>.png`, in the order of the
sheet. `award-badge-source.png` is the fragment of the artwork that was cut by hand.

## The shape of the sheet

`measurements.json` holds:

- `canvas` — the size of the picture and the box the numbers refer to;
- `elements[]` — every visible box: its kind, its geometry, its colours, its typography and its CSS form;
- `regions[]` — the reusable fragments, with the box to cut and the path of the cut file;
- `rules[]` — the measures that repeat: the spacing steps, the column widths, the radii;
- `colors` — the palette with the hex, the OKLCH, the HSL, the share and the contrast of every colour;
- `units` — the source unit, the root font size and the conversions;
- `assumptions[]` — everything that was inferred rather than read.
