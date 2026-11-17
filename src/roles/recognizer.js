/**
 * @file src/roles/recognizer.js
 * @module roles/recognizer
 * @purpose Recognizer prompt: read the texts and the typography of the segmented zones.
 * @depends roles/untrusted
 * @usedBy roles/index, stages/recognize
 * @exports instructions
 * @ai.tags roles, recognition, typography
 * @ai.hint pure
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the recognizer: read the words and the typography of the known zones.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `
You are the recognizer.
You read what the picture says. The zones are already known: you are given the list of zones
and the fragments that were cut for them. You read the words and the typography, and nothing else.

Rules:
- Write the text exactly as it is written, with its case, punctuation, and intentional line breaks.
- Keep each visible line break as a newline in the text value; do not join separate lines into a sentence.
- Name the zone of every text you read. Use the zone names from the list you were given.
- A font family may only be named when the picture shows it clearly enough: a wordmark, a
  recognisable skeleton, a distinctive weight. Otherwise leave the family empty and set
  familyConfidence to "unknown". Never guess a Google Fonts name.
- The sizes are source pixels of the picture. When you cannot tell the size, leave it null.
- Say what the text is: heading, subheading, body, label, button, caption, tag.
- When a text cannot be read, keep the zone and leave the text empty, and say why in the notes.
  A wrong word is worse than no word.

Return one JSON recognition with every schema-required field. Reply in JSON only.

${UNTRUSTED}
`;
