/**
 * @file src/agent/tool-specs.js
 * @module agent/tool-specs
 * @purpose The catalogue of the tools the roles may call: their names, their parameters and the
 *          config switch that turns each of them off.
 *
 *   The catalogue lives apart from the executor on purpose. The executor knows what a crop does;
 *   the catalogue knows what the model is told about it. The description the model reads is part
 *   of the behaviour of a tool: a vague description makes the model guess the arguments, and the
 *   guess is paid for in a failed call and a wasted turn.
 *
 *   The config switches are named after the domain (`image_crop`), not after the wire name
 *   (`crop_image`), because the switches describe what a user turns off, and a user thinks in
 *   domains. The mapping lives here, in one place.
 *
 * @exports TOOL_SPECS, TOOL_NAMES, CONFIG_KEYS, toolSpecs, enabledToolNames, configKeyFor, toolEnabled
 * @ai.tags tools, specs, config
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

/**
 * Every tool the measurer knows, with the schema of its arguments.
 *
 * `configKey` is the switch in `config.tools` that disables the tool; `roles` lists the roles the
 * tool belongs to (an empty list means every role may use it).
 * @type {Readonly<Record<string, {configKey: string, description: string, parameters: object, required: string[], roles: string[]}>>}
 */
export const TOOL_SPECS = Object.freeze({
    view_image: {
        configKey: 'image_view',
        description: 'Look at an image file and read its pixel size. Use it before cropping or projecting a picture.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the image file, relative to the working directory.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: ['segmentator', 'measurer', 'measurerFragment', 'cropper', 'recognizer', 'sampler', 'designer'],
    },
    crop_image: {
        configKey: 'image_crop',
        description: 'Cut a rectangle out of an image and write it to a file. The rectangle is clamped to the picture.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                x: int('Left edge of the rectangle in pixels.'),
                y: int('Top edge of the rectangle in pixels.'),
                width: int('Width of the rectangle in pixels.'),
                height: int('Height of the rectangle in pixels.'),
                output: str('Path of the written file. Empty = next to the source with a -crop suffix.'),
            },
            required: ['path', 'x', 'y', 'width', 'height'],
            additionalProperties: false,
        },
        required: ['path', 'x', 'y', 'width', 'height'],
        roles: ['segmentator', 'measurer', 'measurerFragment', 'cropper', 'recognizer', 'sampler'],
    },
    split_image: {
        configKey: 'image_split',
        description: 'Cut an image into a grid of equal tiles. Use it for a regular grid of frames, not for free-form screens.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                rows: int('Number of rows in the grid.'),
                cols: int('Number of columns in the grid.'),
                outputDir: str('Directory the tiles are written to. Empty = the working directory.'),
            },
            required: ['path', 'rows', 'cols'],
            additionalProperties: false,
        },
        required: ['path', 'rows', 'cols'],
        roles: ['measurer', 'measurerFragment'],
    },
    sample_colors: {
        configKey: 'image_sample',
        description: 'Deterministically sample the dominant colours of an image file or of one box inside it. '
            + 'Returns a palette of hex, RGB, HSL and OKLCH values with their coverage share, the plate colour '
            + 'of the border and the WCAG contrast ratio. Unlike model perception, this reads actual pixel values — '
            + 'no gamma or brightness guesswork. Use it for ground-truth colour measurement.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the image file, relative to the working directory.'),
                x: int('Left edge of the sampled region in pixels.'),
                y: int('Top edge of the sampled region in pixels.'),
                width: int('Width of the sampled region in pixels.'),
                height: int('Height of the sampled region in pixels.'),
                k: int('Number of colours in the palette. Default 5.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: ['sampler', 'designer'],
    },
    parse_color: {
        configKey: 'color_parse',
        description: 'Read a CSS colour and return it in every notation: hex, rgb, hsl, hwb, oklab, oklch, lab, lch, '
            + 'Display-P3 and XYZ, with its luminance and its WCAG contrast against a second colour. '
            + 'Use it when a colour arrives as text (a mockup quote, a design token, a stylesheet value) '
            + 'and the sheet has to carry the exact value in every notation.',
        parameters: {
            type: 'object',
            properties: {
                color: str('The colour as CSS writes it: #f1463f, rgb(241 70 63), hsl(2 86% 60%), oklch(0.64 0.21 27), a named colour.'),
                against: str('A second colour to measure the WCAG contrast against. Empty = only the notations.'),
            },
            required: ['color'],
            additionalProperties: false,
        },
        required: ['color'],
        roles: ['measurer', 'measurerFragment', 'sampler', 'designer'],
    },
    list_files: {
        configKey: 'list',
        description: 'List the files of a directory of the working directory.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Directory to list. Empty = the working directory.'),
                depth: int('How deep to descend. Default 1.'),
            },
            required: [],
            additionalProperties: false,
        },
        required: [],
        roles: ['segmentator', 'measurer', 'measurerFragment', 'recognizer', 'sampler', 'resolver', 'designer'],
    },
    read_file: {
        configKey: 'read',
        description: 'Read a text file from the working directory.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the file, relative to the working directory.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: ['measurer', 'measurerFragment', 'recognizer', 'sampler', 'resolver', 'designer'],
    },
    write_file: {
        configKey: 'write',
        description: 'Write a text file into the working directory.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the file, relative to the working directory.'),
                content: str('The text to write.'),
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        required: ['path', 'content'],
        roles: ['designer'],
    },
    search_files: {
        configKey: 'search',
        description: 'Find files of the working directory. With inContent=1 it greps the content of the text '
            + 'files; with inContent=0 it matches the paths of the files. The glob limits the files by their name.',
        parameters: {
            type: 'object',
            properties: {
                query: str('The text to look for.'),
                path: str('Directory to search in. Empty = the working directory.'),
                inContent: int('1 to search the file content, 0 to search the file names only.'),
                regex: int('1 to read the query as a regular expression.'),
                glob: str('The names of the files to search in, like `*.png`. Empty = every file.'),
            },
            required: ['query'],
            additionalProperties: false,
        },
        required: ['query'],
        roles: ['measurer', 'measurerFragment', 'designer'],
    },
    call_ai_image: {
        configKey: 'external_image',
        description: 'Call the external `ai-image` CLI to generate or edit a picture. '
            + 'This CLI has no image generator of its own: the work is delegated to @u2ai/images.',
        parameters: {
            type: 'object',
            properties: {
                args: str('JSON array of the arguments of `ai-image`, as strings.'),
            },
            required: ['args'],
            additionalProperties: false,
        },
        required: ['args'],
        roles: ['designer'],
    },
    call_ai_decompose: {
        configKey: 'external_decompose',
        description: 'Call the external `ai-decompose` CLI to decompose a picture into flat screen references. '
            + 'This CLI has no decomposer of its own: the work is delegated to @u2ai/decomposer.',
        parameters: {
            type: 'object',
            properties: {
                args: str('JSON array of the arguments of `ai-decompose`, as strings.'),
            },
            required: ['args'],
            additionalProperties: false,
        },
        required: ['args'],
        roles: ['measurer', 'measurerFragment'],
    },
});

/** The names of every tool, in catalogue order. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));

/** The config switches of the tools, in catalogue order. */
export const CONFIG_KEYS = Object.freeze(TOOL_NAMES.map((name) => TOOL_SPECS[name].configKey));

/**
 * The config switch that belongs to a tool.
 * @param {string} name tool name
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function configKeyFor(name) {
    return TOOL_SPECS[name]?.configKey ?? null;
}

/**
 * Whether a tool is switched on in the config.
 *
 * A tool that is not mentioned in `config.tools` is on: the config lists the exceptions, not the
 * permissions.
 * @param {object} tools the `tools` section of the config
 * @param {string} name tool name
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function toolEnabled(tools, name) {
    const key = configKeyFor(name);
    if (!key) return false;
    return tools?.[key] !== false;
}

/**
 * Build the tool definitions in the Responses API shape.
 * @param {object} [tools] the `tools` section of the config; a false value switches the tool off
 * @param {{ names?: string[]|null, role?: string|null }} [options]
 *   `names` limits the list to these tools, `role` limits it to the tools of that role.
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function toolSpecs(tools = {}, { names = null, role = null } = {}) {
    const wanted = new Set(names ?? TOOL_NAMES);
    const out = [];
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
        if (!wanted.has(name)) continue;
        if (!toolEnabled(tools, name)) continue;
        if (spec.roles.length && role && !spec.roles.includes(role)) continue;
        out.push({
            type: 'function',
            name,
            description: spec.description,
            parameters: spec.parameters,
        });
    }
    return out;
}

/**
 * The names of the tools that are switched on for a role.
 * @param {object} tools the `tools` section of the config
 * @param {{ role?: string|null }} [options]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function enabledToolNames(tools = {}, { role = null } = {}) {
    return toolSpecs(tools, { role }).map((spec) => spec.name);
}
