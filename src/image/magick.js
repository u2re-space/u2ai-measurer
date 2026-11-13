/**
 * @file src/image/magick.js
 * @module image/magick
 * @purpose The optional ImageMagick engine.
 *
 * The CLI does not need ImageMagick: sharp reads every picture the measurer
 * works with. It stays as a fallback for the hosts where the native sharp
 * binary cannot be installed, and as a faster path for very large crops.
 *
 * @depends node:child_process, node:path
 * @usedBy image/sharp (fallback), stages/crop
 * @exports detectMagick, magickIdentify, magickCrop, magickConvert
 * @ai.tags image, magick
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Run one ImageMagick command.
 * @param {string} exe the binary
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 * @ai.hint io
 */
function run(exe, args, { cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = String(stderr ?? '');
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}

/**
 * Find the ImageMagick binary, if there is one.
 * @param {{ magickPath?: string|null }} [options]
 * @returns {Promise<{ exe: string, kind: 'magick'|'convert' }|null>}
 * @ai.hint io
 */
export async function detectMagick({ magickPath = null } = {}) {
    const candidates = [];
    if (magickPath) candidates.push({ exe: magickPath, kind: path.basename(magickPath).startsWith('convert') ? 'convert' : 'magick' });
    candidates.push({ exe: 'magick', kind: 'magick' }, { exe: 'convert', kind: 'convert' });
    for (const candidate of candidates) {
        const version = await run(candidate.exe, ['--version'], { timeoutMs: 5_000 }).catch(() => null);
        if (version) return candidate;
    }
    return null;
}

/**
 * The size of a picture, as ImageMagick sees it.
 * @param {{ exe: string, input: string, cwd?: string }} params
 * @returns {Promise<{ width: number, height: number, format: string }>}
 * @ai.hint io
 */
export async function magickIdentify({ exe, input, cwd = process.cwd() }) {
    const isConvert = exe.endsWith('convert') || exe.endsWith('convert.exe');
    const args = isConvert
        ? [input, '-format', '%w %h %m', 'info:']
        : ['identify', input, '-format', '%w %h %m', 'info:'];
    const { stdout } = await run(exe, args, { cwd });
    const [width, height, format] = stdout.trim().split(/\s+/);
    return { width: Number(width) || 0, height: Number(height) || 0, format: String(format ?? '').toLowerCase() };
}

/**
 * Cut a rectangle out of a picture with ImageMagick.
 * @param {{ exe: string, input: string, output: string, x: number, y: number, width: number, height: number, cwd?: string }} params
 * @returns {Promise<{ bytes: number }>}
 * @ai.hint io
 */
export async function magickCrop({ exe, input, output, x = 0, y = 0, width, height, cwd = process.cwd() }) {
    const geometry = `${Math.trunc(width)}x${Math.trunc(height)}+${Math.trunc(x)}+${Math.trunc(y)}`;
    const args = exe.endsWith('convert') || exe.endsWith('convert.exe')
        ? [input, '-crop', geometry, '+repage', output]
        : [input, '-crop', geometry, '+repage', output];
    await run(exe, args, { cwd });
    const { stat } = await import('node:fs/promises');
    const info = await stat(output).catch(() => null);
    return { bytes: info?.size ?? 0 };
}

/**
 * Convert a picture into another format with ImageMagick.
 * @param {{ exe: string, input: string, output: string, format?: string, quality?: number, cwd?: string }} params
 * @returns {Promise<{ bytes: number }>}
 * @ai.hint io
 */
export async function magickConvert({ exe, input, output, format = 'png', quality = 90, cwd = process.cwd() }) {
    const args = [input, '-quality', String(quality), output];
    await run(exe, args, { cwd });
    const { stat } = await import('node:fs/promises');
    const info = await stat(output).catch(() => null);
    return { bytes: info?.size ?? 0 };
}
