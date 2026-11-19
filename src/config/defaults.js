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
  model: 'family:gpt',
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

  // --- the house of the run ----------------------------------------------------
  /**
   * The house of the run: the models that the house trusts with the roles of a run.
   *
   * `models` is the model of the house for the roles that have one: a role that is named
   * here does not answer on the model of the run, it answers on the model of the house. The
   * config may change every name of the map and may put a family of models in its place
   * (`family:gpt`); a role that is named with an empty value has no model of its own.
   *
   * `safe` is the model the house trusts with the roles that the model of the run is not
   * trusted with, and the effort that model works on.
   *
   * `untrusted` is the table of the trust: the key is the model (or a family of models) and
   * the value is the list of the roles that move to the safe model.
   */
  house: {
    models: {},
    safe: { model: 'moonshotai/kimi-k3.1-pro', effort: 'high' },
    untrusted: { 'google/gemini-4-hydrogen': ['segmentator', 'cropper', 'recognizer'] },
    /**
     * The paths of the ranks of the models of the house in their families.
     *
     * A path is a list of the places of the family: the role answers on the first place and
     * steps down to the next one when its work is done.
     */
    ranks: { roles: {}, stages: {} },
  },
  /**
   * The families of models: a named list of interchangeable models, from the cheapest to
   * the most expensive.
   *
   * A family is named where a model is expected with the prefix `family:`: the run answers
   * with the cheapest member of the family that takes the effort of the role, and the rest
   * of the list is the ladder of the budget — the next member answers when the first one
   * refuses.
   */
  modelFamilies: {
    gpt: ['openai/gpt-6.1-terra', 'openai/gpt-6.2-sol'],
    gemini: ['google/gemini-4-hydrogen', 'google/gemini-4-neon'],
    claude: ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5'],
  },
  /**
   * The groups of models: a named list of models of one kind.
   *
   * The members of a group are peers: the one that fits the work answers. A member may name
   * the limit of the context it is trusted with (`maxContext`, in tokens): the member is not
   * asked when the context of the role is bigger than the limit.
   *
   * A group is named where a model is expected with the prefix `group:`. The house of the
   * measurer names no group of its own: the work of the measurer is a measurement, and a
   * measurement wants the eye, not the price.
   */
  modelGroups: {},

  reasoning: { effort: 'high', summary: 'auto', mode: null },
  retries: 3,
  /**
   * The idle timeout of a request, in milliseconds.
   *
   * A thinking model works for minutes without a word, and the answer comes in one piece:
   * the timeout has to be longer than the longest thinking, or the request is cut off and
   * repeated for nothing.
   */
  timeoutMs: 900_000,

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
   * other model. The chain of the house is the Kimi: it answers with the reasoning off in a
   * fraction of the time, so a run that met a refusal keeps going.
   */
  fallback: {
    enabled: true,
    models: {
      'google/gemini-4-hydrogen': [
        'moonshotai/kimi-k3.1-pro',
        'openai/gpt-6.1-terra',
        'anthropic/claude-sonnet-5.5',
      ],
      'moonshotai/kimi-k3.1-pro': ['openai/gpt-6.1-terra', 'anthropic/claude-sonnet-5.5'],
      '*': ['moonshotai/kimi-k3.1-pro', 'openai/gpt-6.1-terra'],
    },
  },

  // --- logging ---------------------------------------------------------------
  /**
   * The log of the API calls: one JSON record per request.
   *
   * Off by default — the records are big, and a run that works does not need them. When a
   * chain misbehaves, they are the only witness: which host was asked, what went out, what
   * came back and where it broke.
   */
  logging: {
    enabled: false,
    /** Where the records are written, relative to the working directory. */
    dir: '.ai/logs/api',
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

  // --- context of the run ----------------------------------------------------
  /**
   * The context of a run: what it did, what it decided and the answers it already has.
   *
   * The context lives in `.tmp/<id>/context/` and dies with the run. It is the primary knowledge
   * of a run: a new run starts with a clean head, and an old run never gets in the way of a new
   * one. The permanent memory of the project is a different thing — this is what *this* run knows.
   */
  context: {
    /** Keep the context of the run. */
    enabled: true,
    /** Remember the answers of the tools, so nobody asks the same thing twice. */
    cache: true,
    /** How long the brief of the context may be, in characters. */
    maxBriefChars: 4000,
  },

  // --- map of the run --------------------------------------------------------
  /**
   * The map of a run: the index of the files of the working directory, with their lines and their
   * symbols. The searches and the reads of the files the map knows do not touch the disk.
   *
   * The map lives in `.tmp/<id>/map.json` and dies with the run: a new run builds a new map, and
   * nothing of the old one leaks into it.
   */
  map: {
    /** Build and keep the map of the run. */
    enabled: true,
    /** How deep the map walks into the directories. */
    depth: 8,
    /** How many files the map holds. */
    maxFiles: 2000,
    /** The biggest file the map reads in full; a bigger one is searched on the disk. */
    maxFileBytes: 32 * 1024,
    /** The most lines the map keeps of one file; a longer one is searched on the disk. */
    maxLines: 400,
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
    /** When the design stage runs: off | auto | always. */
    design: 'off',
    /** Tool turns the designer may spend producing the design direction. */
    designerMaxTurns: 16,
  },

  // --- stages -----------------------------------------------------------------
  /**
   * The stages of the pipeline. Every stage may run alone, and every stage may be switched off:
   * the work of a stage is written to the output directory, so the stage after it reads the file
   * of the stage before — even when they ran in different processes.
   */
  stages: {
    segmentate: {
      enabled: true,
      /** Max agent turns the segmentator may spend. */
      maxTurns: 6,
      /** The effort the stage asks for. The ceiling of the run may lower it, never raise it. */
      effort: 'max',
    },
    crop: {
      enabled: true,
      /** local: the harness cuts the fragments the segmentation names. ai: the cropper picks them. */
      mode: 'local',
      /** Max agent turns the cropper may spend in the ai mode. */
      maxTurns: 12,
      /** Cap of the fragments one run cuts; 0 lifts the cap. */
      maxCrops: 192,
      /** The effort the stage asks for. */
      effort: 'high',
    },
    measure: {
      enabled: true,
      /** Max agent turns the measurer may spend. */
      maxTurns: 8,
      /** The effort the stage asks for: the geometry is a style decision, so it asks for a lot. */
      effort: 'high',
    },
    recognize: {
      enabled: true,
      /** Max agent turns the recognizer may spend. */
      maxTurns: 12,
      /** The effort the stage asks for: the typography is a style decision, so it asks for a lot. */
      effort: 'xhigh',
    },
    sample: {
      enabled: true,
      /** local: the harness reads the pixels, the model only names the colours. ai: the model samples itself. */
      mode: 'local',
      /** The effort of the local mode: the colours are read by the harness, the model only names them. */
      localEffort: 'high',
      /** The effort of the ai mode: the model reads the pixels itself and has to be sharp. */
      aiEffort: 'high',
      /** Max agent turns the sampler may spend. */
      maxTurns: 8,
    },
    resolve: {
      enabled: true,
      /** local: the harness merges the parts. ai: the resolver reconciles them. */
      mode: 'local',
      /** Max agent turns the resolver may spend in the ai mode. */
      maxTurns: 8,
      /** The effort the stage asks for in the ai mode. */
      effort: 'xhigh',
      /** Write DESIGN.md next to the measurements. */
      designMd: true,
      /** Write a CSS token file next to the measurements. */
      tokens: true,
      /** Write a markdown report next to the measurements. */
      report: true,
    },
    design: {
      enabled: true,
      /** Max agent turns for the designer role. */
      maxTurns: 16,
      /** The effort the stage asks for: the direction is a style decision, so it asks for a lot. */
      effort: 'high',
      /** Write an HTML skeleton next to the design direction. */
      template: true,
    },
  },

  /**
   * Where the artifacts of a run are written, relative to cwd.
   *
   * `dir` is the delivery of the run: it stays where the user expects it. `work` is the state
   * of the run: it lives in the house of the project (`.ai/tmp/`) and dies with the run. The
   * path is computed in one place — `shared/house.js`.
   */
  output: { dir: './measurements', file: './measurements.json', work: './.ai/tmp' },

  // --- roles ----------------------------------------------------------------
  /**
   * Per-role overrides. Model/effort resolution chain:
   * role -> roles.default -> top level. `instructions` are appended to the
   * role prompt; `tools` limits the tools of that role.
   */
  roles: {
    default: { model: null, effort: null, summary: null, maxEffort: null, context: null, temperature: null, maxOutputTokens: null, instructions: null, tools: null },
    segmentator: {},
    cropper: {},
    measurer: {},
    recognizer: {},
    sampler: {},
    resolver: {},
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
      segmentator: [],
      cropper: [],
      measurer: ['cssUnits', 'cssDisplay', 'cssShapes', 'cssTransform', 'cssGrid', 'cssFlex'],
      recognizer: ['cssFonts', 'cssColors'],
      sampler: ['cssColors', 'wcagColors'],
      resolver: ['cssUnits', 'cssColors'],
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
    reasoning: { effort: 'medium', summary: 'auto' },
    backends: structuredClone(defaults.backends),
    agent: {
      design: defaults.agent.design,
    },
    stages: {
      segmentate: { enabled: true },
      crop: { enabled: true, mode: defaults.stages.crop.mode },
      measure: { enabled: true },
      recognize: { enabled: true },
      sample: { enabled: true, mode: defaults.stages.sample.mode },
      resolve: { enabled: true, mode: defaults.stages.resolve.mode },
      design: { enabled: true },
    },
    house: {
      models: structuredClone(defaults.house.models),
      safe: structuredClone(defaults.house.safe),
      untrusted: structuredClone(defaults.house.untrusted),
    },
    modelFamilies: structuredClone(defaults.modelFamilies),
    modelGroups: structuredClone(defaults.modelGroups),
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}
