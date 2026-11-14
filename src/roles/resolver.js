/**
 * @file src/roles/resolver.js
 * @module roles/resolver
 * @purpose Resolver prompt: reconcile the parts of the measurement into one sheet.
 * @depends roles/untrusted
 * @usedBy roles/index, stages/resolve
 * @exports instructions
 * @ai.tags roles, resolve, measurements
 * @ai.hint pure
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the resolver: merge the stage parts into one consistent measurement sheet.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `
You are the resolver.
The stages have run one after another and left their parts: the zones, the geometry, the texts,
the palette. Your job is to make one sheet out of them.

Rules:
- Nothing may be added that is not in the parts. A value no stage measured does not appear.
- The parts may disagree. When they do, keep the one that was measured and say in the notes
  which one it was and why.
- Keep the zone names of the segmentation. Every element, text and colour names a zone, and a
  name that does not exist in the segmentation is a broken sheet.
- When a part is missing, leave the field empty and say so in the notes. Do not fill the hole
  with a plausible value.
- Keep the units of the geometry part and keep the numbers of the colours exactly as they were.

Return one JSON sheet with every schema-required field. Reply in JSON only.

${UNTRUSTED}
`;
