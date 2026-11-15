/**
 * @file test/house.test.js
 * @purpose Тесты закона дома: где живёт состояние прогона, как измеритель подписывает контракт
 *          проекта и как другая система находит его работу.
 *
 * Дом проекта — `.ai/`: состояние прогона в `.ai/tmp/<id>/`, ассеты в `.ai/assets/`, логи в
 * `.ai/logs/`, контракт в `.ai/manifest.json`. Поставка остаётся на месте: измерения в
 * `measurements/`, а путь любого фрагмента считается от корня проекта.
 *
 * @depends node:test, shared/house, stages/artifacts, stages/publish, agent/context, agent/run-map
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import {
    HOUSE_ASSETS,
    HOUSE_DIR,
    HOUSE_SYSTEMS,
    HOUSE_WORK,
    assetsDir,
    findGenerated,
    houseDir,
    logsDir,
    manifestPath,
    publish,
    readManifest,
    runStateDir,
    toProjectPath,
    workDir,
    workRel,
    writeFileAtomic,
    writeManifest,
} from '../src/shared/house.js';
import { cropRelPath, deliveryRel } from '../src/stages/artifacts.js';
import { publishDelivery } from '../src/stages/publish.js';
import { contextDirectory, contextRel } from '../src/agent/context.js';
import { runMapFile, runMapRel } from '../src/agent/run-map.js';

/**
 * Пустой проект во временном каталоге.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function project() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-measure-house-'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// --- закон дома --------------------------------------------------------------

test('состояние прогона живёт в доме проекта', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(HOUSE_DIR, '.ai');
        assert.equal(HOUSE_WORK, '.ai/tmp');
        assert.equal(workRel({}), '.ai/tmp');
        assert.equal(workRel({ output: { work: './.ai/tmp' } }), '.ai/tmp');
        assert.equal(workRel({ output: { work: './build' } }), 'build');
        assert.equal(workDir(root), path.join(root, '.ai', 'tmp'));
        assert.equal(runStateDir(root, 'run-1'), path.join(root, '.ai', 'tmp', 'run-1'));
        assert.equal(contextDirectory(root, 'run-1'), path.join(root, '.ai', 'tmp', 'run-1', 'context'));
        assert.equal(contextRel('run-1'), '.ai/tmp/run-1/context');
        assert.equal(runMapFile(root, 'run-1'), path.join(root, '.ai', 'tmp', 'run-1', 'map.json'));
        assert.equal(runMapRel('run-1'), '.ai/tmp/run-1/map.json');
    } finally {
        await cleanup();
    }
});

test('конфигурация может увести состояние прогона из дома', async () => {
    const { root, cleanup } = await project();
    try {
        const config = { output: { work: './build/runs' } };
        assert.equal(workRel(config), 'build/runs');
        assert.equal(runStateDir(root, 'run-1', config), path.join(root, 'build', 'runs', 'run-1'));
        assert.equal(contextRel('run-1', config), 'build/runs/run-1/context');
        assert.equal(runMapRel('run-1', config), 'build/runs/run-1/map.json');
    } finally {
        await cleanup();
    }
});

test('ассеты и логи дома лежат в своих каталогах', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(assetsDir(root), path.join(root, '.ai', 'assets'));
        assert.equal(logsDir(root), path.join(root, '.ai', 'logs'));
        assert.equal(HOUSE_ASSETS, 'assets');
        assert.equal(manifestPath(root), path.join(root, '.ai', 'manifest.json'));
        assert.equal(houseDir(root), path.join(root, '.ai'));
    } finally {
        await cleanup();
    }
});

test('путь файла проекта — относительный, чужой — абсолютный', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(toProjectPath(root, path.join(root, '.ai', 'manifest.json')), '.ai/manifest.json');
        assert.equal(toProjectPath(root, path.join(root, 'measurements', 'measurements.json')), 'measurements/measurements.json');
        assert.equal(toProjectPath(root, path.resolve(root, '..', 'outside.json')), path.resolve(root, '..', 'outside.json'));
    } finally {
        await cleanup();
    }
});

// --- поставка ----------------------------------------------------------------

test('путь поставки и путь фрагмента считаются от корня проекта', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(deliveryRel(root, path.join(root, 'measurements')), 'measurements');
        assert.equal(deliveryRel(root, null), '.');
        assert.equal(
            cropRelPath({ root, outDir: path.join(root, 'measurements'), crop: 'crops/01-badge.png' }),
            'measurements/crops/01-badge.png',
        );
        // A path that already counts from the root stays as it is.
        assert.equal(
            cropRelPath({ root, outDir: path.join(root, 'measurements'), crop: 'measurements/crops/01-badge.png' }),
            'measurements/crops/01-badge.png',
        );
    } finally {
        await cleanup();
    }
});

// --- контракт проекта --------------------------------------------------------

test('контракт проекта пишется и читается', async () => {
    const { root, cleanup } = await project();
    try {
        await writeManifest(root, { systems: { webdev: { delivery: '.' } } });
        const manifest = await readManifest(root);
        assert.equal(manifest.manifestVersion, 1);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.ok(manifest.updatedAt);
    } finally {
        await cleanup();
    }
});

test('сломанный контракт читается как пустой, а не как ошибка', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.ai'), { recursive: true });
        await writeFile(manifestPath(root), '{ this is not json', 'utf8');
        const manifest = await readManifest(root);
        assert.deepEqual(manifest.systems, {});
        assert.equal(manifest.manifestVersion, 1);
    } finally {
        await cleanup();
    }
});

test('система подписывает только свою часть контракта', async () => {
    const { root, cleanup } = await project();
    try {
        await publish(root, HOUSE_SYSTEMS.webdev, { delivery: '.', artifacts: { site: '.' } });
        await publish(root, HOUSE_SYSTEMS.measurer, { delivery: 'measurements/', artifacts: { measurements: 'measurements/measurements.json' } });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.equal(manifest.systems.measurer.delivery, 'measurements/');
        assert.equal(manifest.systems.measurer.artifacts.measurements, 'measurements/measurements.json');
    } finally {
        await cleanup();
    }
});

test('работа другой системы находится через контракт', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, 'measurements'), { recursive: true });
        await writeFile(path.join(root, 'measurements', 'measurements.json'), '{}\n', 'utf8');
        await publish(root, HOUSE_SYSTEMS.measurer, { artifacts: { measurements: 'measurements/measurements.json' } });
        const found = await findGenerated(root, 'measurements', ['nowhere/sheet.json']);
        assert.equal(found, 'measurements/measurements.json');
    } finally {
        await cleanup();
    }
});

// --- атомарная запись --------------------------------------------------------

test('файл пишется целиком: временного файла не остаётся', async () => {
    const { root, cleanup } = await project();
    try {
        const file = path.join(root, '.ai', 'tmp', 'run-1', 'design.json');
        await writeFileAtomic(file, '{"a":1}\n');
        assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
        const left = await readdir(path.dirname(file));
        assert.deepEqual(left, ['design.json']);
    } finally {
        await cleanup();
    }
});

test('упавшая запись не оставляет временного файла', async () => {
    const { root, cleanup } = await project();
    try {
        const target = path.join(root, 'locked');
        await mkdir(target, { recursive: true });
        await assert.rejects(async () => writeFileAtomic(target, 'new\n'));
        const left = await readdir(root);
        assert.ok(!left.some((name) => name.includes('.tmp-')), 'временный файл не остался');
    } finally {
        await cleanup();
    }
});

// --- подпись поставки --------------------------------------------------------

test('измеритель подписывает контракт проекта', async () => {
    const { root, cleanup } = await project();
    try {
        const delivery = path.join(root, 'measurements');
        await mkdir(path.join(delivery, 'crops'), { recursive: true });
        await mkdir(path.join(delivery, 'design-assets'), { recursive: true });
        await writeFile(path.join(delivery, 'measurements.json'), '{}\n', 'utf8');
        await writeFile(path.join(delivery, 'palette.json'), '{}\n', 'utf8');
        await writeFile(path.join(delivery, 'tokens.css'), ':root {}\n', 'utf8');
        await writeFile(path.join(delivery, 'DESIGN.md'), '# Design\n', 'utf8');
        await writeFile(path.join(delivery, 'report.md'), '# Report\n', 'utf8');

        await publishDelivery(root, { output: { dir: './measurements' } }, { outDir: delivery, workId: 'w1' });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.measurer.delivery, 'measurements/');
        assert.equal(manifest.systems.measurer.artifacts.measurements, 'measurements/measurements.json');
        assert.equal(manifest.systems.measurer.artifacts.palette, 'measurements/palette.json');
        assert.equal(manifest.systems.measurer.artifacts.tokens, 'measurements/tokens.css');
        assert.equal(manifest.systems.measurer.artifacts.design, 'measurements/DESIGN.md');
        assert.equal(manifest.systems.measurer.artifacts.report, 'measurements/report.md');
        assert.equal(manifest.systems.measurer.artifacts.crops, 'measurements/crops/');
        assert.equal(manifest.systems.measurer.artifacts.designAssets, 'measurements/design-assets/');
        assert.equal(manifest.systems.measurer.workId, 'w1');
    } finally {
        await cleanup();
    }
});

test('поставка без файлов не подписывает лишнего', async () => {
    const { root, cleanup } = await project();
    try {
        await publishDelivery(root, { output: { dir: './measurements' } }, { outDir: path.join(root, 'measurements') });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.measurer.delivery, 'measurements/');
        assert.deepEqual(manifest.systems.measurer.artifacts, {});
    } finally {
        await cleanup();
    }
});
