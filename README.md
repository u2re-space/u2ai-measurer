# u2ai-measurer

AI measurer and designer: it measures the geometry, the colours and the typography of a
reference picture and turns the measurements into a design guide a coder can use.

- Named CLI as `ai-measure`.
- Config in `~/.ai-measure/config.json`.
- Node.js 26+, ESM, no SDK.

The package has two roles — `measure` and `design` — and it does not generate images and does
not decompose a screenshot on its own: when a design needs an illustration or a decomposition,
the agent calls the external `ai-image` and `ai-decompose` CLIs.

## Install

```bash
npm i -g @u2ai/measurer
```

Or from a checkout:

```bash
npm install
node bin/ai-measure.js --help
```

## Pipeline

Three stages run in sequence. Each of them writes its own artifacts:

```
picture.png
    │
    ▼
┌─────────────────┐
│  1. design      │  Optional: a visual direction, the assets and an HTML skeleton.
│  (optional)     │  → .tmp/<id>/design.json, design-template.html, design-assets/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. measure     │  The measurement sheet: geometry, colours, typography, rules.
│                 │  → .tmp/<id>/crops/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. resolve     │  The files a coder reads.
│  (final)        │  → ./measurements/
└─────────────────┘
```

The crops are cut inside the measurement stage: the measurer names the boxes, the harness cuts
the pixels. A second pass (`agent.measurerPasses: 2`) hands the cut fragments back to the model
so it can refine the details that were too small to read in the overview.

## Commands

```bash
ai-measure measure screen.png                     # measure and write the artifacts
ai-measure measure screen.png --out ./tokens      # write the artifacts somewhere else
ai-measure measure screen.png --task "a pricing page"
ai-measure design screen.png                      # the design direction only

ai-measure palette screen.png --colors 6          # local: no model, no API key
ai-measure crop screen.png --x 0 --y 0 --width 320 --height 80 --output top.png
ai-measure split screen.png --rows 2 --cols 3 --out-dir tiles

ai-measure tokens ./measurements/measurements.json
ai-measure docs cssUnits wcagColors
ai-measure config
ai-measure skills
```

| Command | What it does | Needs a model |
|---------|--------------|----------------|
| `measure` | Runs the pipeline and writes the artifacts | yes |
| `design` | Runs the design stage only | yes |
| `palette` | Samples the colours of a picture: hex, OKLCH, HSL, share | no |
| `crop` | Cuts a rectangle out of a picture | no |
| `split` | Cuts a picture into a grid of tiles | no |
| `tokens` | Prints the CSS tokens of a `measurements.json` | no |
| `docs` | Prints the standards the roles are given | no |
| `config` | Prints the resolved configuration, the secrets shortened | no |
| `skills` | Lists the skill packs of the home directory | no |

The first positional is the command when it names one, so `ai-measure screen.png` means
`ai-measure measure screen.png`.

### Options

| Option | Meaning |
|--------|---------|
| `-i, --image <path>` | A reference picture. May be repeated. |
| `-o, --out <dir>` | Where the artifacts go (default: `./measurements`). |
| `--stages <list>` | The stages to run: `design`, `measure`, `resolve`. `crop` is an alias of `measure`. |
| `-m, --model <id>` | The model of the roles. |
| `--effort <level>` | The reasoning effort: `low`, `medium`, `high`, `xhigh`. |
| `--task <text>` | The task the design direction answers. |
| `-c, --config <file>` | The config file to use. |
| `-k, --colors <n>` | How many colours the palette holds (default 5). |
| `-x, --y, --width, --height` | The rectangle of the crop. |
| `--output <file>` | Where the crop or the token file is written. |
| `--rows, --cols` | The grid of the split. |
| `--out-dir <dir>` | Where the tiles are written. |
| `--dry-run` | Print the plan and stop. |
| `--verbose` | Print more. |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | the run failed |
| `2` | wrong usage |
| `130` | interrupted |

## Outputs

The artifacts land in `output.dir` (default `./measurements`):

| File | What it holds |
|------|---------------|
| `measurements.json` | The whole measurement sheet: the elements, the regions, the rules, the crops and the conclusion. |
| `palette.json` | The colours of the reference with their hex, OKLCH, HSL, luminance and confidence. |
| `tokens.css` | The colours and the repeated measures as CSS custom properties. |
| `DESIGN.md` | The same tokens as a document a person reads. |
| `report.md` | What was measured, how certain it is and which crops exist. |

The crops are PNG files in `.tmp/<id>/crops/`: `NN-element-header.png`, `NN-region-logo.png`.

### What the measurer measures

- The geometry of every element in the pixels of the reference: the box, the padding, the margin,
  the gap, the radius, the borders.
- The typography: the role, the family, the size, the weight, the line height, the tracking.
- The colours, sampled from the pixels — not guessed. A colour is `high` confidence only when
  the `sample_colors` tool read it; every colour carries its hex, its OKLCH, its share and the
  contrast against the plate.
- The CSS form of every value: the raw numbers stay in the source unit (`px`), the `units` block
  names the root font size and the preferred units, and every element carries a `css` string
  with explicit units.
- The repeated measures, as `rules[]` — the values that appear more than once and become tokens.

A value that cannot be read is `null`, never a guess. `DESIGN.md` of the project, when it exists,
is read and obeyed, and its conflicts with the reference are reported.

## Configuration

- File: `~/.ai-measure/config.json` (override the directory with `AI_MEASURE_HOME`).
- Env prefix: `AI_MEASURE_`.
- Substitutions: `{{env:NAME}}`.

The precedence is: defaults < `~/.ai-measure/config.json` < `--config <file>` < `AI_MEASURE_*`
environment < the command line.

The starter file:

```json
{
  "model": "moonshotai/kimi-k3.1-pro",
  "reasoning": { "effort": "xhigh", "summary": "auto" },
  "backends": [
    { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" }
  ],
  "agent": {
    "measure": "auto",
    "measureSource": "auto",
    "measurerPasses": 1,
    "measurerMaxTurns": 8,
    "design": "off"
  },
  "stages": {
    "crop": { "enabled": true },
    "measure": { "enabled": true },
    "design": { "enabled": true },
    "resolve": { "enabled": true }
  }
}
```

The knobs a user edits most often:

| Field | Meaning |
|-------|---------|
| `agent.measure` | `off` \| `auto` \| `always` — when the measurement stage runs. `auto` runs it when there are references. |
| `agent.measureSource` | `auto` \| `subrefs` \| `original` — which pictures the measurer measures. `subrefs` forces the derived sub-references. |
| `agent.measurerPasses` | `1` = one overview sheet; `2` = the overview and then the staged fragments. |
| `agent.measurerMaxTurns` | The tool turns of the measurement passes. |
| `agent.maxCrops` | The cap of the automatic crops (default 192, `0` lifts it). |
| `agent.design` | `off` \| `auto` \| `always` — when the design stage runs. `auto` runs it when there are references, a `DESIGN.md`, or design words in the task. |
| `agent.designerMaxTurns` | The tool turns the designer may spend. |
| `output.dir` | Where the artifacts go. |
| `roles.<name>.model` | The model of one role: `measurer`, `cropper`, `designer`. `roles.default` applies to every role without a model of its own. |
| `documentation.roles` | The standards a role is given: `cssUnits`, `cssShapes`, `cssTransform`, `cssMotion`, `cssContain`, `cssImages`, `cssMasking`, `cssFonts`, `cssGrid`, `cssFlex`, `wcagColors`, `phosphorIcons`, `lucideIcons`, `googleFonts`. |
| `tools` | The switches of the tools: `read`, `write`, `list`, `search`, `image_view`, `image_crop`, `image_split`, `image_sample`, `external_image`, `external_decompose`. |
| `mcp.servers` | The MCP tool servers: `{ name, url }` or `{ name, command, args }`. |

A config that does not validate is refused with a message that names the exact path — the
messages of the config are in Russian, like in `u2ai-decomposer` and `u2ai-images`.

### Skills

Markdown files in `~/.ai-measure/skills` are given to the roles as extra instructions. A file
named after a role belongs to that role alone; `shared.md` and `_shared.md` belong to every role:

```
~/.ai-measure/skills/
├── measurer.md   → the measurer only
├── designer.md   → the designer only
└── shared.md     → every role
```

The text is appended to the instructions of the role, so it is part of the system prompt and
not something the model can be talked out of. The packs are read, never written.

### The API key

The key comes from the `apiKey` field, from the `env` field of a backend, or from
`AI_MEASURE_API_KEY`. A backend on `localhost` may work without one.

## Architecture

| Directory | What it holds |
|-----------|---------------|
| `src/cli.js`, `src/cli/*` | The argv parser, the dispatcher, the renderer, the exit codes. |
| `src/config/*` | The defaults, the parser, the merge, the validation. |
| `src/openai/*` | The Responses API client, the Chat Completions fallback, the backends. |
| `src/image/*` | The raster layer: `sharp` first, `canvas` second, ImageMagick last. |
| `src/agent/*` | The tools, the schemas, the skills, the documentation, the MCP client. |
| `src/roles/*` | The instructions of the roles and the loop that talks to the API. |
| `src/stages/*` | The three stages and the crops. |
| `src/shared/pipeline.js` | The orchestrator of the stages. |

### The roles

| Role | Stage | Purpose |
|------|-------|---------|
| `measurer` | measure | The measurement sheet of the reference. |
| `measurerFragment` | measure | The second pass over the cut fragments. |
| `cropper` | — | The plan of the crops, when it is asked for one. |
| `designer` | design | The visual direction, the assets and the HTML skeleton. |

### The tools of the agent

`view_image`, `crop_image`, `split_image`, `sample_colors`, `list_files`, `read_file`,
`write_file`, `search_files`, `call_ai_image`, `call_ai_decompose` — plus the tools of the MCP
servers. Every tool is bound to the working directory: a file may not be read outside it, and a
file may only be written into the directories the stage opened.

The external CLIs are called as subprocesses. The binary is looked up in `AI_IMAGE_BIN` (or
`AI_DECOMPOSE_BIN`), in the sibling checkout `u2ai-images` (or `u2ai-decomposer`) next to this
package, in `submodules/u2ai-images` (or `submodules/u2ai-decomposer`), in the installed package
`node_modules/@u2ai/images` (or `node_modules/@u2ai/decomposer`) and in `PATH`.

## Development

```bash
npm run check          # the syntax of every file
npm test               # the tests
npm pack --dry-run     # what the package would publish
```

## Lineage

The roles and the stages were ported from the monolith `Universal-AI` (0.2.xx), where the
measure and the design stages lived inside the agent flow. Here they are a package of their own:
one CLI, one config, one pipeline, and tests for every layer.

The files that came from the monolith carry `@ai.hint legacy-0.2` in their header: the openai
layer, the image layer, the agent layer, the roles and the stages. The files written for this
package do not.

## License

MIT.
