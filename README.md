# u2ai-measurer

AI measurer and designer: it measures the geometry, the colours and the typography of a
reference picture and turns the measurements into a design guide a coder can use.

- Named CLI as `ai-measure`.
- Config in `~/.ai-measure/config.json`.
- Node.js 26+, ESM, no SDK.

The package has six stages and an optional design stage — and it does not generate images and does
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

Six stages run in sequence, and every one of them may run alone. Each stage writes its own file
into `<out>/stages/` and reads the files of the stages before it from the same place: the file is
the contract, not the state of the process.

```
picture.png
    │
    ▼
┌─────────────────┐
│  1. segmentate  │  The zones of the reference and the box of each one.
│                 │  → <out>/stages/segmentation.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. crop        │  The fragments, cut into files.
│                 │  → <out>/crops/, <out>/stages/crops.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. measure     │  The geometry of the zones: display, spacing, borders, padding.
│                 │  → <out>/stages/geometry.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. recognize   │  The texts and the typography they use.
│                 │  → <out>/stages/recognition.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  5. sample      │  The colours, read from the pixels and named.
│                 │  → <out>/stages/palette.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  6. resolve     │  The files a coder reads.
│  (final)        │  → <out>/measurements.json, palette.json, tokens.css, ...
└─────────────────┘
```

The design stage is the seventh one and it is optional: `agent.design` decides whether it runs.

One picture is measured once. The same file named twice on the command line is one reference:
the segmentation holds one zone list for it, and the fragments are cut once. One object is cut
once as well: a zone that names the object another zone already named is not cut a second time,
and the folder of the fragments holds the fragments of this run and nothing else.

One zone is one thing. An object that stands in front of another — a chess piece in front of a
numbered board, a logo on a panel, a button on a card — is two zones, and the box of a zone does
not swallow the neighbours it only touches. A merged zone hides the object inside it.

### One stage at a time

```bash
ai-measure measure screen.png --stages segmentate    # only the zones
ai-measure measure screen.png --stages segmentate,crop,measure
ai-measure measure screen.png --stages resolve       # no picture needed: it reads the files
```

A stage that was named on the command line always runs — even the design stage, even when
`agent.design` is `off`. The switch in the config (`stages.<id>.enabled: false`) is a hard switch
and always wins: a stage that is off does not run, however it was asked for.

The stages that look at a picture need one; the resolve stage only reads the files of the stages
before it and runs without a picture and without a key.

### The money

Every stage asks for the reasoning effort it needs (`stages.<id>.effort`), and the run has a
ceiling (`--effort`). The answer is the lower of the two: the ceiling lowers the effort of a
stage, it never raises it. The ceiling of the role (`roles.<role>.maxEffort`) lowers it too.

Two stages work in two ways, and the local way costs nothing:

| Stage | `local` | `ai` |
|-------|---------|-----|
| `crop` | The harness cuts the boxes the segmentation named | The cropper reads the picture and names the fragments |
| `sample` | The harness reads the pixels, the model only names the colours | The model samples the colours itself |
| `resolve` | The harness joins the parts into one sheet | The resolver reconciles the parts |

The default is `local` for all three.

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
| `--stages <list>` | The stages to run: `segmentate`, `crop`, `measure`, `recognize`, `sample`, `resolve`, `design`. Every stage may run alone. |
| `-m, --model <id>` | The model of the roles. |
| `--effort <level>` | The ceiling of the run: `low`, `medium`, `high`, `xhigh`. It lowers the effort of a stage, never raises it. |
| `--task <text>` | The task the design direction answers. |
| `-c, --config <file>` | The config file to use. |
| `-k, --colors <n>` | How many colours the palette holds (default 5). |
| `-x, --y, --width, --height` | The rectangle of the crop. |
| `--output <file>` | Where the crop or the token file is written. |
| `--rows, --cols` | The grid of the split. |
| `--out-dir <dir>` | Where the tiles are written. |
| `--dry-run` | Print the plan and stop. |
| `--verbose` | Print more. |

### A long run

A thinking model may work for minutes without a word. The terminal says so every 20 seconds —
`thinking (40s)` — and the tool calls of a role are printed as they happen, so a quiet run is a
run that is waiting, not a run that is stuck.

The wait has a limit: `timeoutMs` (default `900000`, `AI_MEASURE_TIMEOUT_MS`) is the idle timeout
of one request. It has to outlive the longest thinking of the model: a timeout cuts the request off
and the answer is lost, so the default is generous. A request that fails is retried, and the retry
is printed too.

### What the run reads and writes

The log of a run says what happens, not only that something happens:

| Line | What it means |
|------|---------------|
| `reference: landing.png (original)` | The picture the measurer reads. |
| `tool: sample_colors path=landing.png x=10 y=20 width=30 height=40` | The call the model made, with its arguments. |
| `colours: #aabbcc 62.5%  #112233 37.5%` | What the tool found: the colours and their share of the area. |
| `crop: .tmp/<id>/crops/01-bishop.png — artwork "bishop"` | The fragment that was cut out of the reference. |
| `sheet: 12 elements, 3 regions, 5 rules` | The shape of the sheet the model returned. |
| `written: measurements/measurements.json (12 kB)` | The file of the delivery. |

`--verbose` prints the whole answer of every tool instead of the short summary.

A run that dies says so: an unhandled rejection and an uncaught exception are printed, so an empty
terminal is never the only sign of a failure.

### The log of the API calls

A run that fails says only "failed" — unless the log is on. The log is a witness: one JSON file
per request, with the body that went out, the chain of the hosts, the time of every attempt, the
answer that came back and the error that broke it.

```json
{
  "at": "2026-11-15T03:41:02.113Z",
  "path": "responses",
  "model": "moonshotai/kimi-k3.1-pro",
  "attempts": [
    { "backend": "https://routerai.ru/api/v1", "ok": true, "durationMs": 181_233 }
  ],
  "durationMs": 181_233,
  "response": { "output": [ "…" ] }
}
```

The pictures are not written into the record: the body of an image is megabytes of base64, and it
is the same picture every time. The record says how big it was. The log is off by default — turn it
on with the directory:

```json
{ "logging": { "enabled": true, "dir": ".tmp/api" } }
```

or with `AI_MEASURE_LOG_DIR=.tmp/api`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | the run failed |
| `2` | wrong usage |
| `130` | interrupted |

## Backends and fallback

A request goes to the first backend that answers. The list is ordered, and the next one takes
the request when the previous one fails, so a second system is a fallback system and not a
second choice:

```json
{
  "backends": [
    { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" },
    { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY" }
  ]
}
```

A backend may also declare what it serves and how a model is named there:

```json
{
  "modelsBackends": {
    "moonshotai/kimi-k3.1-pro": [
      { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" },
      { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY" }
    ]
  }
}
```

The Responses API is the first transport; a host that does not serve it is asked over Chat
Completions instead.

### The fallback of the models

When a model fails — it is gone, overloaded, or it refuses the request — the next model of the
chain answers the whole call again, from the first turn, with the picture in place:

```json
{
  "fallback": {
    "enabled": true,
    "models": {
      "moonshotai/kimi-k3.1-pro": ["moonshotai/kimi-k3", "openai/gpt-5.1"],
      "*": ["moonshotai/kimi-k3"]
    }
  }
}
```

The key `*` is the chain of every model that has no chain of its own. `fallback.enabled: false`
turns the chain off.

## Outputs

The artifacts land in `output.dir` (default `./measurements`):

| File | What it holds |
|------|---------------|
| `measurements.json` | The whole measurement sheet: the elements, the regions, the rules, the crops and the conclusion. |
| `palette.json` | The colours of the reference with their hex, OKLCH, HSL, luminance and confidence. |
| `tokens.css` | The colours and the repeated measures as CSS custom properties. |
| `DESIGN.md` | The same tokens as a document a person reads. |
| `report.md` | What was measured, how certain it is and which crops exist. |
| `crops/` | The fragments themselves: `NN-element-header.png`, `NN-region-logo.png`. |

The crops are cut into the work directory `.tmp/<id>/crops/` and copied next to the artifacts,
so the delivery is self-contained: the sheet, the report and the pictures travel together. The
paths inside `measurements.json` and `report.md` point at the copies.

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

## The context of the run

Every run keeps a context of its own: what it did, what it decided, and the answers the tools
already gave. The context lives in the work directory of the run — `.tmp/<id>/context/` — and
dies with it.

```
.tmp/<id>/context/
  journal.ndjson   what happened, one entry per line, in the order it happened
  state.json       what the run knows now: the pictures, the stages, the facts
  cache/           the answers the tools already gave, so nobody asks twice
  notes.md         the digest a person reads
```

The context is the primary knowledge of a run. It is not the permanent memory of the project: a
new run starts with a clean head, and an old run never gets in the way of a new one.

The roles read the context before they work. The brief of the context names the exact paths of
the pictures of the run, so a model never goes looking for a file that is not there:

```
# The context of this run

The pictures of this run — these paths are exact, do not look for them anywhere else:
- `landing.png` — the original picture

The stages of this run:
- segmentate: done — 4 zones found.
```

And the roles write into it: their answers, their decisions, the plans they made and the files
they wrote all land in the journal and in the state. The next stage starts from that instead of
asking the model the same thing again.

The answer of a picture tool is cached too, and the key of the cache carries the moment of the
last change of the file: a picture that changed is read again, a picture that did not is not.

A picture that is not where the model says it is does not throw an error — it answers with the
paths the run really has, including the hint of the same name:

```
There is no file at `.tmp/mwh9nzfw-30a179/landing.png`.
The picture of this run is `landing.png` — open it by that path.
```

## The map of the run

The map of a run is the index of the files of the working directory: their lines, their symbols,
their size and the moment they changed. It lives in `.tmp/<id>/map.json` and dies with the run.

```json
{
  "version": 1,
  "id": "mwh9nzfw-30a179",
  "files": {
    "src/app.js": {
      "bytes": 2048,
      "kind": "code",
      "mtimeMs": 1763170000000,
      "lineCount": 62,
      "eol": "\n",
      "partial": false,
      "lines": ["export function greet() {", "    return 'hello';", "}"],
      "symbols": [{ "name": "greet", "kind": "export", "line": 1 }]
    }
  }
}
```

The tools read through the map: `list_files` answers from it, `read_file` is served from the
lines it holds, and `search_files` searches them. A file that changed since the map was built is
read from the disk again — the map never serves a stale file.

The search knows three scopes: `path` looks at the names of the files, `content` at their text,
`symbol` at the names the code declares, `all` at everything.

The map does not read everything: it skips `.tmp`, `node_modules`, `.git` and the files with
secrets, it holds at most 2000 files, and a file longer than 400 lines or bigger than 32 KiB is
marked `partial` — for such a file the search goes to the disk.

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
  "reasoning": { "effort": "high", "summary": "auto" },
  "backends": [
    { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" }
  ],
  "agent": {
    "design": "off",
    "designerMaxTurns": 16
  },
  "stages": {
    "segmentate": { "enabled": true, "effort": "high", "maxTurns": 6 },
    "crop": { "enabled": true, "mode": "local", "effort": "medium", "maxTurns": 6 },
    "measure": { "enabled": true, "effort": "high", "maxTurns": 8 },
    "recognize": { "enabled": true, "effort": "high", "maxTurns": 8 },
    "sample": { "enabled": true, "mode": "local", "localEffort": "low", "aiEffort": "high" },
    "resolve": { "enabled": true, "mode": "local", "effort": "high" },
    "design": { "enabled": true, "effort": "high", "maxTurns": 16 }
  }
}
```

The knobs a user edits most often:

| Field | Meaning |
|-------|---------|
| `stages.<id>.enabled` | `false` switches the stage off for good: it does not run, even when it is named on the command line. |
| `stages.<id>.effort` | The effort the stage asks for. The ceiling of the run (`--effort`) and the ceiling of the role (`roles.<name>.maxEffort`) lower it, never raise it. |
| `stages.<id>.mode` | `local` (the harness does the work) or `ai` (the model does it) — for the stages that work in two ways: `crop`, `sample`, `resolve`. |
| `stages.<id>.maxTurns` | The tool turns the role of the stage may spend. |
| `stages.sample.localEffort` | The effort of the sampler when the harness read the colours: `low`. |
| `stages.sample.aiEffort` | The effort of the sampler when the model reads the colours itself: `xhigh`. |
| `stages.resolve.designMd` / `tokens` / `report` | Whether the resolve stage writes `DESIGN.md`, `tokens.css` and `report.md`. |
| `agent.design` | `off` \| `auto` \| `always` — when the design stage runs on its own. A stage named on the command line runs anyway. |
| `agent.designerMaxTurns` | The tool turns the designer may spend. |
| `output.dir` | Where the artifacts go. |
| `context.enabled` | `false` keeps no context of the run: the stages share nothing and every answer is read again. |
| `context.cache` | `false` keeps the journal but not the cache of the answers of the tools. |
| `context.maxBriefChars` | How long the brief of the context may be (default 4000). |
| `map.enabled` | `false` keeps no map of the run: the searches and the reads go to the disk every time. |
| `map.depth` | How deep the map walks into the directories (default 8). |
| `map.maxFiles` | How many files the map holds (default 2000). |
| `map.maxFileBytes` | The biggest file the map reads in full (default 32768). |
| `map.maxLines` | The most lines the map keeps of one file (default 400). |
| `timeoutMs` | The idle timeout of one request, in milliseconds (default 900000, maximum 1800000). |
| `roles.<name>.model` | The model of one role: `segmentator`, `cropper`, `measurer`, `recognizer`, `sampler`, `resolver`, `designer`. `roles.default` applies to every role without a model of its own. |
| `roles.<name>.effort` | The effort of one role. It wins over the effort of the stage. |
| `roles.<name>.maxEffort` | The ceiling of one role. |
| `documentation.roles` | The standards a role is given: `cssUnits`, `cssColors`, `cssDisplay`, `cssShapes`, `cssTransform`, `cssMotion`, `cssContain`, `cssImages`, `cssMasking`, `cssFonts`, `cssGrid`, `cssFlex`, `wcagColors`, `phosphorIcons`, `lucideIcons`, `googleFonts`. |
| `tools` | The switches of the tools: `read`, `write`, `list`, `search`, `image_view`, `image_crop`, `image_split`, `image_sample`, `color_parse`, `external_image`, `external_decompose`. |
| `mcp.servers` | The MCP tool servers: `{ name, url }` or `{ name, command, args }`. |
| `skills.dir` | Where the skill packs are; the default is `~/.ai-measure/skills`. |
| `fallback.models` | The chain of models to try when one fails; `*` is the chain of every other model. |

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

A pack may also be a directory: `SKILL.md` is the pack and the other markdown files of the
directory are its references. A frontmatter names the pack and the roles it belongs to:

```
~/.ai-measure/skills/
└── house-style/
    ├── SKILL.md
    └── references.md
```

```markdown
---
name: House style
description: The conventions of this project.
roles: measurer, designer
---

Measure the spacing on a 4px grid.
```

The text is appended to the instructions of the role, so it is part of the system prompt and
not something the model can be talked out of. The packs are read, never written. The fragment
pass inherits the packs of the measurer.

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
| `src/access/*` | The access layer: the files and the commands under one root, over a replaceable backend. |
| `src/roles/*` | The instructions of the roles and the loop that talks to the API. |
| `src/stages/*` | The stages of the pipeline, their files and the crops. |
| `src/shared/pipeline.js` | The orchestrator of the stages. |

### The access layer

`src/access` is the door between the model and the machine: the files and the commands under one
root. Both halves work through a backend, so the same rules hold on a native disk, in the memory,
or over a remote one.

```js
import { createAccess } from './src/access/index.js';

const access = createAccess({ root: process.cwd() });

await access.fs.writeText('notes/todo.md', '# todo');
const found = await access.fs.search({ query: 'todo' });

const listing = await access.fs.listFiles('src', { depth: 2, limit: 400 });
const copied = await access.fs.copy('src/app.js', 'lib/app.js');
const answer = await access.exec.run('node', ['--version']);
```

The rules of the paths live in one place and are never optional: a path may not leave the root —
neither through `..` nor through a symbolic link — the secret files and the secret directories are
never accessible, and the read-only directories may be read, but never written. `src/agent/paths.js`
keeps the words of the refusals and borrows the rules from `src/access/paths.js`.

`listFiles` returns the tree of a path as the model reads it: the noisy folders are marked and
not opened, the dot-files are hidden unless they are asked for, the sizes are in the text, and a
path that does not exist yet answers with the nearest existing parent. `copy` copies a file or a
tree under the same rules: no secret, no symbolic link, no directory into itself, and the
destination must not exist unless `overwrite` is asked for.

### The roles

| Role | Stage | Purpose |
|------|-------|---------|
| `measurer` | measure | The measurement sheet of the reference. |
| `measurerFragment` | measure | The second pass over the cut fragments. |
| `cropper` | — | The plan of the crops, when it is asked for one. |
| `designer` | design | The visual direction, the assets and the HTML skeleton. |

### How a role answers

A role that has both tools and a schema answers in two phases.

1. The model looks: it calls the tools, and every answer goes back into the conversation
   together with the picture and the question, because a model that has called a tool has to
   see the reference again.
2. The model writes: the harness asks for the answer and the API holds it to the JSON schema.

The order matters. A schema among the tools is one more reason to keep looking, and a model
that is fond of tools spends the whole budget on it and never answers. The two phases keep the
looking and the writing apart.

The picture is in the conversation of every turn of the first phase, and the notes of the
reference stay in the message of the second phase.

### The tools of the agent

`view_image`, `crop_image`, `split_image`, `sample_colors`, `parse_color`, `list_files`,
`read_file`, `write_file`, `search_files`, `call_ai_image`, `call_ai_decompose` — plus the tools
of the MCP servers. Every tool is bound to the working directory: a file may not be read outside
it, and a file may only be written into the directories the stage opened.

`sample_colors` reads the pixels; `parse_color` reads a colour out of a text — a hex, a
`rgb()`, an `oklch()`, a named colour — and gives it back in every notation, with its luminance
and its WCAG contrast against a second colour. The colour spaces come from
[culori](https://culorijs.org/): sRGB, Display-P3, HSL, HWB, OKLab, OKLCH, LAB, LCH and XYZ.

`search_files` greps the text of the files (`inContent=1`) or matches the paths of the files
(`inContent=0`). `glob` limits the files by their name before they are read (`*.png`,
`src/**/*.js`), and `regex` reads the query as a regular expression.

The external CLIs are called as subprocesses. The binary is looked up in `AI_IMAGE_BIN` (or
`AI_DECOMPOSE_BIN`), in the sibling checkout `u2ai-images` (or `u2ai-decomposer`) next to this
package, in `submodules/u2ai-images` (or `submodules/u2ai-decomposer`), in the installed package
`node_modules/@u2ai/images` (or `node_modules/@u2ai/decomposer`) and in `PATH`.

## Examples

`examples/` holds a run of the measurer over `examples/landing.png`:

| Path | What it is |
|------|------------|
| `examples/landing.png`, `examples/landing.jpg` | The reference picture. |
| `examples/measurements.json` | The measurement sheet of that picture. |
| `examples/crops/` | The fragments the harness cut out of the sheet. |
| `examples/skills/` | An example skill pack: copy it into `~/.ai-measure/skills`. |

```bash
node bin/ai-measure.js measure examples/landing.png --out examples
```

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
