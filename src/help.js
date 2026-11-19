/**
 * @file src/help.js
 * @module help
 * @purpose The help text of the CLI. English, because the CLI speaks to every project.
 * @exports HELP, COMMAND_NAMES
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

/** The commands the CLI answers to. */
export const COMMAND_NAMES = Object.freeze([
    'measure',
    'design',
    'palette',
    'crop',
    'split',
    'tokens',
    'docs',
    'config',
    'skills',
]);

/**
 * The help text.
 * @type {string}
 * @exports
 * @ai.hint pure
 */
export const HELP = `ai-measure — turn a reference picture into CSS-ready numbers.

Usage:
  ai-measure <command> [options]

Interface:
  In a terminal, ai-measure opens the graphical dashboard of the house: the stages,
  the progress, the live log and the operator line. The internal worker is
  ai-measure-worker; it owns the ordinary stdout and stderr and talks to the shell
  over a versioned IPC protocol.

  A pipe, a redirect, --json, --quiet and --headless use the worker directly. The
  machine output stays the same: --json prints one json object per line on stdout.

Commands:
  measure <image...>   Measure the references and write the artifacts.
  design <image...>    Produce the visual design direction only.
  palette <image>      Sample the colours of a picture. Local: no model, no API key.
  crop <image>         Cut a rectangle out of a picture. Local.
  split <image>        Split a picture into a grid of tiles. Local.
  tokens [file]        Print the CSS tokens of a measurements.json.
  docs [name...]       Print the standards documentation (cssUnits, wcagColors, ...).
  config               Print the resolved configuration.
  skills               List the skill packs of ~/.ai-measure/skills.

Options:
  -i, --image <path>    A reference picture. May be repeated.
  -o, --out <dir>       Where the artifacts go (default: ./measurements).
      --stages <list>   The stages to run: segmentate, crop, measure, recognize, sample, resolve,
                        design. Every stage may run alone; the work of a stage is written to the
                        output directory, so the stage after it reads the file of the stage before.
  -m, --model <id>      The model of the roles. May be a family of models: family:<name>
                        takes the cheapest member of the family.
      --effort <level>  The ceiling of the run: low, medium, high, xhigh. It lowers the effort
                         a stage asks for, never raises it.
      --task <text>     The task the design direction answers.
  -c, --config <file>   The config file to use.
  -k, --colors <n>      How many colours the palette holds (default 5).
  -x, --x <px>          The left edge of the crop.
  -y, --y <px>          The top edge of the crop.
  -w, --width <px>      The width of the crop.
      --height <px>     The height of the crop.
      --output <file>   Where the crop or the token file is written.
      --rows <n>        The rows of the split grid.
      --cols <n>        The columns of the split grid.
      --out-dir <dir>   Where the tiles are written.
      --dry-run         Print the plan and stop.
      --verbose         Print more.
      --json            One json object per line on stdout.
      --quiet           Only the result of the run.
      --headless        The worker without the graphical shell.
      --ascii           The symbols of the terminal without the unicode ones.
  -h, --help            This text.
  -v, --version         The version of the package.

Exit codes:
  0    success
  1    the run failed
  2    wrong usage
  130  interrupted

Examples:
  ai-measure measure screen.png
  ai-measure measure screen.png --stages segmentate
  ai-measure measure screen.png --out ./tokens --task "a pricing page"
  ai-measure measure screen.png --effort medium
  ai-measure palette screen.png --colors 6
  ai-measure crop screen.png --x 0 --y 0 --width 320 --height 80 --output top.png
  ai-measure split screen.png --rows 2 --cols 3 --out-dir tiles
  ai-measure tokens ./measurements/measurements.json
  ai-measure docs cssUnits wcagColors
`;
