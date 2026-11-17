/**
 * Allowed values and shared literals of the configuration system.
 *
 * These enums are the contract between the parser, the validator and the
 * stages: a config value outside them is a user error and fails the load.
 *
 * @ai.hint legacy-0.2
 */

export const KiB = 1024;
export const MiB = 1024 * KiB;

/** Env prefix of this CLI (the monolith uses AI_*, ours is namespaced). */
export const ENV_PREFIX = 'AI_MEASURE_';

export const ENUMS = Object.freeze({
  reasoningEfforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  reasoningSummaries: Object.freeze(['auto', 'concise', 'detailed']),
  reasoningModes: Object.freeze(['off', 'priority']),
  /** Word context levels; resolved to bytes by the model profile at load time. */
  contextLevels: Object.freeze({ small: 16 * KiB, normal: 96 * KiB, large: 512 * KiB, max: 8 * MiB }),
  contextWords: Object.freeze(['auto', 'small', 'normal', 'large', 'max']),
  /** Backend entries may declare which API routes the host serves. */
  backendRoutes: Object.freeze(['responses', 'chat']),
  imageFormats: Object.freeze(['png', 'jpeg', 'webp']),
  imageQualities: Object.freeze(['low', 'medium', 'high', 'auto']),
  imageBackgrounds: Object.freeze(['auto', 'transparent', 'opaque']),
  /** Pipeline stages in execution order. */
  stages: Object.freeze(['segmentate', 'crop', 'measure', 'recognize', 'sample', 'resolve', 'design']),
  /** How a stage may work: local (the harness does it) or ai (the model does it). */
  stageModes: Object.freeze(['local', 'ai']),
  /** When the design stage runs. */
  measureModes: Object.freeze(['off', 'auto', 'always']),
  /** How sure a measurement may be. */
  confidenceLevels: Object.freeze(['high', 'medium', 'low', 'unknown']),
  rasterEngines: Object.freeze(['auto', 'sharp', 'canvas', 'magick']),
  /** The documentation sources a role may be given. */
  documentationSources: Object.freeze([
    'cssColors',
    'cssUnits', 'cssColors', 'cssDisplay', 'cssShapes', 'cssTransform', 'cssMotion', 'cssContain',
    'cssImages', 'cssMasking', 'cssFonts', 'cssGrid', 'cssFlex',
    'phosphorIcons', 'lucideIcons', 'googleFonts', 'wcagColors',
  ]),
});

/** Role names that always exist; user roles are validated against the schema only. */
export const BUILTIN_ROLE_NAMES = Object.freeze([
  'default', 'segmentator', 'cropper', 'measurer', 'recognizer', 'sampler', 'resolver', 'designer',
]);

/** Alias spellings accepted in backend `supports` maps. */
export const SUPPORT_ALIASES = Object.freeze({
  responseapi: 'responses', responses: 'responses',
  chatapi: 'chat', chat: 'chat', chatcompletions: 'chat', completions: 'chat',
});

/** RFC 7230 token characters for header names in backend entries. */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
