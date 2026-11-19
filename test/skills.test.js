/**
 * @file test/skills.test.js
 * @purpose Tests of the skill packs: the files, the directories, the frontmatter and the roles.
 * @depends node:test, node:fs/promises, node:path, agent/skills
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
    buildSkillInstructions,
    discoverSkills,
    listSkillPacks,
    loadSkills,
    parseFrontmatter,
    readSkill,
    skillsForRole,
} from '../src/agent/skills.js';

const dir = async () => await mkdtemp(path.join(tmpdir(), 'ai-measure-skills-'));

test('the frontmatter is split from the body', () => {
    const { meta, body } = parseFrontmatter('---\nname: Pack\nroles: measurer, designer\n---\nThe text.');
    assert.equal(meta.name, 'Pack');
    assert.equal(meta.roles, 'measurer, designer');
    assert.equal(body.trim(), 'The text.');
});

test('a file without a frontmatter is all body', () => {
    const { meta, body } = parseFrontmatter('Just text.');
    assert.deepEqual(meta, {});
    assert.equal(body, 'Just text.');
});

test('a block scalar keeps the full description', () => {
    const { meta } = parseFrontmatter('---\nname: Pack\ndescription: >\n  The first line.\n  The second line.\n---\nThe text.');
    assert.equal(meta.description, 'The first line. The second line.');
});

test('a pack of the measurer reaches the measurer and not the designer', async () => {
    const root = await dir();
    await writeFile(path.join(root, 'measurer.md'), 'Measure on a 4px grid.');
    await writeFile(path.join(root, 'designer.md'), 'Name the tokens.');

    const measurer = await loadSkills({ dir: root, role: 'measurer' });
    assert.equal(measurer.length, 1);
    assert.match(measurer[0].content, /4px grid/);

    const designer = await loadSkills({ dir: root, role: 'designer' });
    assert.equal(designer.length, 1);
    assert.match(designer[0].content, /Name the tokens/);
});

test('a shared pack reaches every role', async () => {
    const root = await dir();
    await writeFile(path.join(root, 'shared.md'), 'Shared rule.');
    for (const role of ['measurer', 'designer', 'cropper']) {
        const packs = await loadSkills({ dir: root, role });
        assert.equal(packs.length, 1, `${role} got no shared pack`);
    }
});

test('a pack may be a directory with references', async () => {
    const root = await dir();
    const pack = path.join(root, 'house-style');
    await mkdir(pack, { recursive: true });
    await writeFile(path.join(pack, 'SKILL.md'), '---\nname: House style\nroles: measurer\n---\nThe rules.');
    await writeFile(path.join(pack, 'references.md'), 'The colours.');

    const packs = await loadSkills({ dir: root, role: 'measurer' });
    assert.equal(packs.length, 1);
    assert.equal(packs[0].name, 'House style');
    assert.match(packs[0].content, /The rules/);
    assert.match(packs[0].content, /The colours/);
    assert.deepEqual(packs[0].files, ['SKILL.md', 'references.md']);

    assert.equal((await loadSkills({ dir: root, role: 'designer' })).length, 0);
});

test('the text of the packs is ready for the instructions', async () => {
    const root = await dir();
    await writeFile(path.join(root, 'measurer.md'), 'Measure on a 4px grid.');
    const text = await skillsForRole({ dir: root, role: 'measurer' });
    assert.match(text, /## Skill pack: measurer/);
    assert.match(text, /4px grid/);
});

test('the packs of a directory are listed', async () => {
    const root = await dir();
    await writeFile(path.join(root, 'shared.md'), 'x');
    const packs = await listSkillPacks({ dir: root });
    assert.equal(packs.length, 1);
    assert.equal(packs[0].name, 'shared');
    assert.ok(packs[0].bytes > 0);
});

test('a directory without packs is not an error', async () => {
    assert.deepEqual(await loadSkills({ dir: path.join(tmpdir(), 'ai-measure-nothing-here') }), []);
});

test('standard Agent Skills are discovered in the project and the global home', async () => {
    const root = await dir();
    const home = await dir();
    await mkdir(path.join(root, '.agents', 'skills', 'project-skill'), { recursive: true });
    await writeFile(
        path.join(root, '.agents', 'skills', 'project-skill', 'SKILL.md'),
        '---\nname: project-skill\ndescription: A project skill.\n---\nProject rules.',
    );
    await mkdir(path.join(home, '.agents', 'skills', 'global-skill'), { recursive: true });
    await writeFile(
        path.join(home, '.agents', 'skills', 'global-skill', 'SKILL.md'),
        '---\nname: global-skill\ndescription: A global skill.\n---\nGlobal rules.',
    );

    const skills = await discoverSkills(root, { env: { HOME: home } });
    const names = skills.map((skill) => skill.name);
    assert.ok(names.includes('project-skill'));
    assert.ok(names.includes('global-skill'));

    const catalogue = buildSkillInstructions(skills);
    assert.match(catalogue, /global-skill/);
    assert.match(catalogue, /read_skill/);
});

test('a global Agent Skill is read by name', async () => {
    const root = await dir();
    const home = await dir();
    await mkdir(path.join(home, '.agents', 'skills', 'oil-ui'), { recursive: true });
    await writeFile(
        path.join(home, '.agents', 'skills', 'oil-ui', 'SKILL.md'),
        '---\nname: oil-ui\ndescription: UI design workflow.\n---\nChoose a visual direction.',
    );

    const skill = await readSkill('oil-ui', root, { env: { HOME: home } });
    assert.equal(skill.name, 'oil-ui');
    assert.match(skill.body, /visual direction/);
    assert.equal(await readSkill('../outside', root, { env: { HOME: home } }), null);
});
