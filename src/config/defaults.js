/**
 * Default configuration of the measurer CLI.
 *
 * Shape mirrors the monolith's config minus everything this CLI does not have
 * (image generation, decomposition, agent transport fields). Every section
 * listed here is also the allow-list for user config files.
 *
 * @ai.hint legacy-0.2
 */

import { ENUMS } from './constants.js';

export const defaults = {
  // --- API -----------------------------------------------------------------
  /** Text model for the role agents. */
  model: 'moonshotai/kimi-k3.1-pro',
  /** Endpoint of the text API; backends[] below can override it. */
  baseURL: 'https://routerai.ru/api/v1',
  apiKey: null,
  organization: null,
  project: null,
  /** Send `store: true` on API calls. */
  store: false,
  truncation: 'auto',
  verbosity: null,
  temperature: null,
  maxOutputTokens: null,
  /** Per-model ceilings: { "<model>": { window, maxOutput, ceiling } }. */
  models: {},
  reasoning: { effort: 'medium', summary: 'auto', mode: null },
  retries: 3,
  timeoutMs: 120_000,

  // --- HTTP backends -------------------------------------------------------
  /**
   * Ordered text-API hosts; the first usable one becomes the primary.
   * Entry: { baseURL, apiKey?, env?, headers?, body?, supports? }.
   * `env` is the environment variable name for the key (checked when apiKey
   * is not set).
   */
  backends: [
    { baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' },
    { baseURL: 'https://api.proxyapi.ru/v1', env: 'PROXYAPI_API_KEY' },
    { baseURL: 'https://sprutdock.ru/v1', env: 'SPRUTDOCK_API_KEY' },
    { baseURL: 'https://gptunnel.ru/v1', env: 'GPTUNNEL_API_KEY' },
  ],
  /** Per-model host lists: { "<model>": [{ baseURL, apiKey?, prefix?, vendor?, suffix?, type? }] }. */
  modelsBackends: {},
  /**
   * Model fallback: when a model fails, the next one of the chain answers instead.
   * `models` maps a model to the models to try after it; the key `*` is the chain for every
   * other model.
   */
  fallback: {
    enabled: true,
    models: {
      'moonshotai/kimi-k3.1-pro': ['moonshotai/kimi-k3', 'openai/gpt-5.1', 'anthropic/claude-sonnet-5'],
      '*': ['moonshotai/kimi-k3', 'openai/gpt-5.1'],
    },
  },

  // --- limits ---------------------------------------------------------------
  limits: {
    /** Wall-clock budget per stage. */
    stageTimeoutMs: 15 * 60_000,
    /** Agent-loop turns per role call. */
    maxTurns: 24,
    /** Retries per API request. */
    requestRetries: 3,
    /** Max raster bytes an image tool may return into the context. */
    maxImageBytes: 8 * 1024 * 1024,
    /** Cap for {{file:...}} substitutions in config strings. */
    maxFileReadBytes: 256 * 1024,
  },

  // --- tools ----------------------------------------------------------------
  tools: {
    read: true,
    write: true,
    list: true,
    search: true,
    image_view: true,
    image_crop: true,
    image_split: true,
    image_sample: true,
    /** Read a CSS colour and return it in every notation. */
    color_parse: true,
    /** Call the external `ai-image` CLI. */
    external_image: true,
    /** Call the external `ai-decompose` CLI. */
    external_decompose: true,
  },

  // --- raster ----------------------------------------------------------------
  raster: {
    /** sharp -> canvas -> ImageMagick fallback chain. */
    engine: 'auto',
    /** ImageMagick binary when the engine is magick/auto. */
    magickPath: null,
  },

  // --- image knobs -----------------------------------------------------------
  image: {
    format: 'png',
    quality: 'high',
    background: 'auto',
    /** Downscale cap for images sent to the model, longest edge px. */
    maxSide: 1536,
    /** JPEG quality (0..100) for model-bound copies when format is jpeg. */
    jpegQuality: 90,
    /** Max decoded megapixels before a raster op refuses (canvas bomb cap). */
    maxMegapixels: 100,
    /** Alpha threshold 0..1: pixels below it count as erased. */
    alphaThreshold: 0.05,
  },

  // --- agent knobs -----------------------------------------------------------
  agent: {
    /** When the measurement stage runs: off | auto | always. */
    measure: 'auto',
    /** Which pictures the measurer measures: auto | subrefs | original. */
    measureSource: 'auto',
    /** 1 = one overview sheet; 2 = whole reference, then staged fragments. */
    measurerPasses: 1,
    /** Total tool turns for the measurement passes. */
    measurerMaxTurns: 16,
    /** Context budget of the measurer: a word level or bytes. */
    measurerMaxContextBytes: 'large',
    /** Cap of automatic crops per measurement sheet; 0 lifts the cap. */
    maxCrops: 192,
    /** When the design stage runs: off | auto | always. */
    design: 'off',
    /** Tool turns the designer may spend producing the design direction. */
    designerMaxTurns: 16,
  },

  // --- stages -----------------------------------------------------------------
  stages: {
    crop: {
      enabled: true,
      /** Cut the crops the sheet names after the overview pass. */
      autoCrops: true,
    },
    measure: {
      enabled: true,
      /** Max agent turns for the overview pass. */
      maxTurns: 16,
      /** Max agent turns for the fragment pass. */
      maxFragmentTurns: 8,
    },
    design: {
      enabled: true,
      /** Max agent turns for the designer role. */
      maxTurns: 16,
      /** Write an HTML skeleton next to the design direction. */
      template: true,
    },
    resolve: {
      enabled: true,
      /** Write DESIGN.md next to the measurements. */
      designMd: true,
      /** Write a CSS token file next to the measurements. */
      tokens: true,
      /** Write a markdown report next to the measurements. */
      report: true,
    },
  },

  /** Where pipeline artifacts are written, relative to cwd. */
  output: { dir: './measurements', file: './measurements.json' },

  // --- roles ----------------------------------------------------------------
  /**
   * Per-role overrides. Model/effort resolution chain:
   * role -> roles.default -> top level. `instructions` are appended to the
   * role prompt; `tools` limits the tools of that role.
   */
  roles: {
    default: { model: null, effort: null, summary: null, maxEffort: null, context: null, temperature: null, maxOutputTokens: null, instructions: null, tools: null },
    measurer: {},
    cropper: {},
    designer: {},
  },

  /** Extra named roles merged into the role registry at load. */
  customRoles: {},

  // --- documentation ----------------------------------------------------------
  /**
   * The standards a role is given as documentation: CSS units, CSS shapes,
   * icon sets, the WCAG colour rules. The measurer needs them to write
   * CSS-ready values; the designer needs them to name tokens.
   */
  documentation: {
    roles: {
      measurer: ['cssUnits', 'cssColors', 'cssDisplay', 'cssShapes', 'cssTransform', 'cssFonts', 'cssGrid', 'cssFlex', 'wcagColors'],
      designer: ['cssUnits', 'cssColors', 'cssDisplay', 'cssShapes', 'cssFonts', 'cssGrid', 'cssFlex', 'phosphorIcons', 'lucideIcons', 'googleFonts'],
    },
  },

  // --- MCP ------------------------------------------------------------------
  /**
   * External tool servers. Each entry is either `{ name, url }` for an HTTP
   * server or `{ name, command, args }` for a server started over stdio.
   */
  mcp: { servers: [] },

  /** Output root for role skills (read-only skill packs per role). */
  skills: { dir: null },
};

/** Allowed fields of one `roles.<name>` entry (null = inherited). */
export const ROLE_FIELDS = Object.freeze([
  'model', 'effort', 'summary', 'maxEffort', 'context', 'temperature',
  'maxOutputTokens', 'instructions', 'tools',
]);

export function cloneDefaults() {
  return structuredClone(defaults);
}

/**
 * Starter file written to ~/.ai-measure/config.json on first run: only the
 * fields a user is expected to edit; everything else stays on the defaults.
 */
export function defaultConfigText() {
  const starter = {
    model: defaults.model,
    reasoning: { effort: 'xhigh', summary: 'auto' },
    backends: structuredClone(defaults.backends),
    agent: {
      measure: defaults.agent.measure,
      measureSource: defaults.agent.measureSource,
      measurerPasses: defaults.agent.measurerPasses,
      measurerMaxTurns: defaults.agent.measurerMaxTurns,
      design: defaults.agent.design,
    },
    stages: {
      crop: { enabled: true },
      measure: { enabled: true },
      design: { enabled: true },
      resolve: { enabled: true },
    },
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}
