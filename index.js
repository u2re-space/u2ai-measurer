/**
 * @file index.js
 * @module index
 * @purpose Public entry of the package: the CLI entry and the programmatic API.
 * @ai.hint keep
 */
export { main, parseArgv } from './src/cli.js';
export { HELP } from './src/help.js';
export * from './src/config.js';
export * from './src/image/colors.js';
export * from './src/image/quantizer.js';
export * from './src/image/crop.js';
export * from './src/image/sharp.js';
export * from './src/openai/responses.js';
export * from './src/model/profiles.js';
export * from './src/roles/index.js';
export * from './src/agent/tool-specs.js';
export * from './src/agent/skills.js';
export * from './src/agent/schemas.js';
export * from './src/stages/index.js';
export * from './src/shared/pipeline.js';
