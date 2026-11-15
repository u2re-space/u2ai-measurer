/**
 * @file src/agent/context.js
 * @module agent/context
 * @purpose The context of a run: what it did, what it decided and the answers it already has.
 *
 *   The context lives in the directory of the run — `.tmp/<id>/context/` — and dies with it.
 *   It is not the permanent memory of the project: it holds what *this* run knows, so a new
 *   run starts with a clean head and an old run never pollutes the new one.
 *
 *   Four things live there:
 *
 *     journal.ndjson  what happened, one entry per line, in the order it happened;
 *     state.json      what the run knows now: the pictures, the stages, the facts;
 *     cache/          the answers the tools already gave, so nobody asks twice;
 *     notes.md        the digest a person reads.
 *
 *   The context is also what the roles read: the brief of the context names the exact paths
 *   of the pictures of the run, so a model never goes looking for a file that is not there.
 *
 * @depends node:path, node:crypto, node:fs/promises
 * @usedBy shared/pipeline, roles/index, agent/tools, stages
 * @exports CONTEXT_DIR, JOURNAL_FILE, STATE_FILE, NOTES_FILE, CACHE_DIR, openContext,
 *          contextDirectory, contextRel, cacheKeyFor
 * @ai.tags context, cache, journal
 * @ai.hint io
 * @changed 2026-11-15 The context of a run: the journal, the state, the cache and the brief.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

/** The name of the directory of the context inside the directory of the run. */
export const CONTEXT_DIR = 'context';

/** The journal of the run: one entry per line, in the order the entries happened. */
export const JOURNAL_FILE = 'journal.ndjson';

/** The state of the run: what it knows now. */
export const STATE_FILE = 'state.json';

/** The digest of the run: what a person reads. */
export const NOTES_FILE = 'notes.md';

/** The answers the tools already gave. */
export const CACHE_DIR = 'cache';

/** The longest text one entry of the journal may hold. */
const MAX_TEXT = 4000;

/** The longest brief that goes into the prompt of a role. */
const MAX_BRIEF = 4000;

/**
 * The directory of the context of a run.
 * @param {string} root the working directory of the run
 * @param {string} workId the id of the run
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function contextDirectory(root, workId) {
    return path.join(path.resolve(String(root ?? '.')), '.tmp', String(workId ?? ''), CONTEXT_DIR);
}

/**
 * The path of the context of a run, the way the model reads it.
 * @param {string} workId the id of the run
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function contextRel(workId) {
    return `.tmp/${String(workId ?? '')}/${CONTEXT_DIR}`;
}

/**
 * The key of a cache entry: the name of the file that holds it.
 * @param {unknown} value whatever identifies the answer
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function cacheKeyFor(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/**
 * A text that is not longer than the limit.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 * @ai.hint pure
 */
function clip(value, max = MAX_TEXT) {
    const text = String(value ?? '');
    if (text.length <= max) return text;
    return `${text.slice(0, max)}… (${text.length} chars)`;
}

/**
 * The empty state of a run.
 * @param {string} id
 * @returns {object}
 * @ai.hint pure
 */
function emptyState(id) {
    return {
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        references: [],
        stages: {},
        facts: {},
        files: [],
    };
}

/**
 * The brief of the context: what the roles of the run have to know.
 *
 * The paths of the pictures are the point of it: a model that is told where the picture is
 * does not go looking for it in the working directory of the run.
 * @param {object} state
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 * @ai.hint pure
 */
export function buildBrief(state, { maxChars = MAX_BRIEF } = {}) {
    const lines = ['# The context of this run'];
    const references = Array.isArray(state?.references) ? state.references : [];
    if (references.length) {
        lines.push('', 'The pictures of this run — these paths are exact, do not look for them anywhere else:');
        for (const item of references) {
            const kind = item?.kind === 'subref' ? 'a sub-reference' : 'the original picture';
            lines.push(`- \`${item?.rel ?? ''}\` — ${kind}`);
        }
    }
    const stages = Object.values(state?.stages ?? {});
    if (stages.length) {
        lines.push('', 'The stages of this run:');
        for (const stage of stages) {
            const status = stage?.status === 'failed' ? 'failed' : 'done';
            const summary = stage?.summary ? ` — ${stage.summary}` : '';
            lines.push(`- ${stage?.id ?? 'stage'}: ${status}${summary}`);
        }
    }
    const facts = state?.facts ?? {};
    for (const [key, value] of Object.entries(facts)) {
        if (key === 'notes') continue;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (!text) continue;
        lines.push('', `## ${key}`, text);
    }
    const files = Array.isArray(state?.files) ? state.files : [];
    if (files.length) {
        lines.push('', 'The files the run wrote:');
        for (const file of files.slice(-24)) lines.push(`- ${file}`);
    }
    const text = lines.join('\n');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n… (the context is longer: ${text.length} chars)`;
}

/**
 * Open the context of a run.
 *
 * A context that is switched off is still an object: every method of it does nothing and
 * never fails, so the caller needs no branches.
 * @param {{ root: string, workId: string, enabled?: boolean, cache?: boolean, maxBriefChars?: number }} options
 * @returns {Promise<object>} the context of the run
 * @exports
 * @ai.hint io
 */
export async function openContext({
    root,
    workId,
    enabled = true,
    cache = true,
    maxBriefChars = MAX_BRIEF,
} = {}) {
    const id = String(workId ?? '');
    const dir = contextDirectory(root, id);
    const rel = contextRel(id);

    const state = emptyState(id);
    const entries = [];

    if (!enabled) {
        return disabledContext({ id, dir, rel, state });
    }

    await mkdir(path.join(dir, CACHE_DIR), { recursive: true });

    // The state of an earlier run of the same id: a continued run keeps what it knows.
    const stored = await readFile(path.join(dir, STATE_FILE), 'utf8').catch(() => null);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (parsed && typeof parsed === 'object') Object.assign(state, parsed, { id });
        } catch { /* a broken state is a hint, not a reason to fail */ }
    }

    /**
     * Write the state to the disk.
     * @returns {Promise<void>}
     */
    const saveState = async () => {
        state.updatedAt = new Date().toISOString();
        await writeFile(path.join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    };

    const context = {
        enabled: true,
        id,
        dir,
        rel,
        state,

        /**
         * Put an entry into the journal of the run.
         * @param {string} kind what happened
         * @param {object} [payload] the detail of it
         * @param {object} [meta] the stage and the role it belongs to
         * @returns {Promise<object|null>} the entry
         * @ai.hint io
         */
        async record(kind, payload = {}, meta = {}) {
            try {
                const entry = {
                    at: new Date().toISOString(),
                    kind: String(kind ?? 'note'),
                    stage: meta?.stage ? String(meta.stage) : null,
                    role: meta?.role ? String(meta.role) : null,
                    ...payload,
                };
                if (typeof entry.text === 'string') entry.text = clip(entry.text);
                entries.push(entry);
                await mkdir(dir, { recursive: true });
                await appendFile(path.join(dir, JOURNAL_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
                return entry;
            } catch {
                // The context is a witness: a run that cannot write it still runs.
                return null;
            }
        },

        /**
         * A note of the run.
         * @param {string} text
         * @param {object} [meta]
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async note(text, meta = {}) {
            return await context.record('note', { text: String(text ?? '') }, meta);
        },

        /**
         * A decision of the run: the answer of a stage that the later stages build on.
         * @param {string} text
         * @param {object} [meta]
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async decision(text, meta = {}) {
            return await context.record('decision', { text: String(text ?? '') }, meta);
        },

        /**
         * The plan of the run.
         * @param {string} text
         * @param {object} [meta]
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async plan(text, meta = {}) {
            return await context.record('plan', { text: String(text ?? '') }, meta);
        },

        /**
         * The answer of a role or a stage.
         * @param {string} text
         * @param {object} [meta]
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async answer(text, meta = {}) {
            return await context.record('answer', { text: String(text ?? '') }, meta);
        },

        /**
         * An action of a role: a tool call, a file it wrote.
         * @param {string} text
         * @param {object} [meta]
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async action(text, meta = {}) {
            return await context.record('action', { text: String(text ?? '') }, meta);
        },

        /**
         * The state of a stage of the run.
         * @param {string} stageId the id of the stage
         * @param {string} status done or failed
         * @param {string} [summary] what the stage did, in one sentence
         * @param {object} [meta]
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async stage(stageId, status = 'done', summary = '', meta = {}) {
            const id_ = String(stageId ?? '');
            state.stages[id_] = {
                id: id_,
                status: String(status ?? 'done'),
                summary: clip(summary, 400),
                at: new Date().toISOString(),
            };
            await saveState().catch(() => {});
            return await context.record('stage', { stage: id_, status: String(status ?? 'done'), summary: clip(summary, 400) }, meta);
        },

        /**
         * Remember a fact of the run.
         * @param {string} key
         * @param {unknown} value
         * @returns {Promise<void>}
         * @ai.hint io
         */
        async set(key, value) {
            state.facts[String(key ?? '')] = value;
            await saveState().catch(() => {});
        },

        /**
         * A fact of the run.
         * @param {string} key
         * @returns {unknown}
         * @ai.hint pure
         */
        get(key) {
            return state.facts?.[String(key ?? '')];
        },

        /**
         * The pictures of the run: the exact paths the roles have to use.
         * @param {Array<{ rel: string, kind?: string }>} references
         * @returns {Promise<void>}
         * @ai.hint io
         */
        async references(references = []) {
            state.references = (Array.isArray(references) ? references : []).map((item) => ({
                rel: String(item?.rel ?? ''),
                kind: String(item?.kind ?? 'original'),
            }));
            await saveState().catch(() => {});
        },

        /**
         * A file the run wrote.
         * @param {string} file the path of the file
         * @returns {Promise<void>}
         * @ai.hint io
         */
        async file(file) {
            const rel = String(file ?? '');
            if (!rel) return;
            if (!state.files.includes(rel)) state.files.push(rel);
            await saveState().catch(() => {});
        },

        /**
         * The answer that is already in the cache.
         * @param {string} key
         * @returns {Promise<object|null>}
         * @ai.hint io
         */
        async cached(key) {
            if (!cache) return null;
            const text = await readFile(path.join(dir, CACHE_DIR, `${cacheKeyFor(key)}.json`), 'utf8').catch(() => null);
            if (text === null) return null;
            try {
                const parsed = JSON.parse(text);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
                return null;
            }
        },

        /**
         * Put an answer into the cache.
         * @param {string} key
         * @param {unknown} value
         * @returns {Promise<void>}
         * @ai.hint io
         */
        async put(key, value) {
            if (!cache) return;
            try {
                await mkdir(path.join(dir, CACHE_DIR), { recursive: true });
                await writeFile(
                    path.join(dir, CACHE_DIR, `${cacheKeyFor(key)}.json`),
                    `${JSON.stringify(value ?? null)}\n`,
                    'utf8',
                );
            } catch { /* a cache that cannot be written is only slower */ }
        },

        /**
         * The brief of the context: what the roles of the run read.
         * @param {{ maxChars?: number }} [options]
         * @returns {string}
         * @ai.hint pure
         */
        brief(options = {}) {
            return buildBrief(state, { maxChars: options?.maxChars ?? maxBriefChars });
        },

        /**
         * The entries of the journal.
         * @param {{ kind?: string|null, stage?: string|null, limit?: number }} [filter]
         * @returns {Promise<object[]>}
         * @ai.hint io
         */
        async journal(filter = {}) {
            const text = await readFile(path.join(dir, JOURNAL_FILE), 'utf8').catch(() => '');
            const list = text
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                    try { return JSON.parse(line); }
                    catch { return null; }
                })
                .filter(Boolean);
            let out = list;
            if (filter?.kind) out = out.filter((entry) => entry.kind === filter.kind);
            if (filter?.stage) out = out.filter((entry) => entry.stage === filter.stage);
            const limit = Number.isSafeInteger(filter?.limit) ? filter.limit : out.length;
            return out.slice(-Math.max(0, limit));
        },

        /**
         * Write the digest of the run: what a person reads after it.
         * @returns {Promise<string|null>} the path of the file
         * @ai.hint io
         */
        async digest() {
            try {
                const list = await context.journal();
                const lines = [
                    `# The context of the run ${id}`,
                    '',
                    `Created: ${state.createdAt}`,
                    `Updated: ${state.updatedAt}`,
                    '',
                ];
                if (state.references.length) {
                    lines.push('## The pictures', '');
                    for (const item of state.references) lines.push(`- \`${item.rel}\` — ${item.kind}`);
                    lines.push('');
                }
                const stages = Object.values(state.stages ?? {});
                if (stages.length) {
                    lines.push('## The stages', '');
                    for (const stage of stages) lines.push(`- ${stage.id}: ${stage.status}${stage.summary ? ` — ${stage.summary}` : ''}`);
                    lines.push('');
                }
                if (list.length) {
                    lines.push('## What happened', '');
                    for (const entry of list) {
                        const where = [entry.stage, entry.role].filter(Boolean).join('/');
                        lines.push(`- ${entry.at} · ${entry.kind}${where ? ` · ${where}` : ''}${entry.text ? ` — ${entry.text}` : ''}`);
                    }
                    lines.push('');
                }
                if (state.files.length) {
                    lines.push('## The files', '');
                    for (const file of state.files) lines.push(`- ${file}`);
                    lines.push('');
                }
                await mkdir(dir, { recursive: true });
                const file = path.join(dir, NOTES_FILE);
                await writeFile(file, lines.join('\n'), 'utf8');
                return file;
            } catch {
                return null;
            }
        },

        /**
         * Nothing to close: every write of the context is finished when it returns.
         * @returns {Promise<void>}
         * @ai.hint io
         */
        async close() {},
    };

    return context;
}

/**
 * A context that is switched off: the same shape, without the disk.
 * @param {{ id: string, dir: string, rel: string, state: object }} options
 * @returns {object}
 * @ai.hint pure
 */
function disabledContext({ id, dir, rel, state }) {
    const nothing = async () => null;
    return {
        enabled: false,
        id,
        dir,
        rel,
        state,
        record: nothing,
        note: nothing,
        decision: nothing,
        plan: nothing,
        answer: nothing,
        action: nothing,
        stage: nothing,
        set: nothing,
        get: () => undefined,
        references: nothing,
        file: nothing,
        cached: async () => null,
        put: nothing,
        brief: () => '',
        journal: async () => [],
        digest: async () => null,
        close: nothing,
    };
}
