#!/usr/bin/env node
/**
 * @file bin/ai-measure.js
 * @module bin/ai-measure
 * @purpose Process entry for the `ai-measure` command. Forwards every argument to `cli.main`.
 * @depends cli
 * @usedBy package bin
 * @ai.tags cli
 * @ai.hint io
 */
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
