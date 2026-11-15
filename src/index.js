/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

export * from './openai/client.js';
export * from './openai/errors.js';
export * from './openai/responses.js';
export * from './openai/fallback.js';
export * from './openai/chat.js';
export * from './config.js';
export * from './image/sharp.js';
export * from './image/crop.js';
export * from './image/colors.js';
export * from './image/quantizer.js';
export * from './model/profiles.js';
export * from './model/trust.js';
export * from './roles/index.js';
export * from './agent/tools.js';
export * from './agent/tool-specs.js';
export * from './agent/mcp.js';
export * from './agent/skills.js';
export * from './agent/schemas.js';
export * from './agent/documentation.js';
export * from './agent/paths.js';
export * from './shared/pipeline.js';
export * from './stages/index.js';
export * from './stages/artifacts.js';
export * from './stages/references.js';
export * from './stages/cropper.js';
export * from './stages/segmentate.js';
export * from './stages/recognize.js';
export * from './stages/sample.js';
export * from './stages/measure.js';
export * from './stages/design.js';
export * from './stages/resolve.js';
export * from './stages/publish.js';
export * from './shared/house.js';
export * from './shared/child-log.js';
