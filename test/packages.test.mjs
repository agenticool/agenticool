import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/** @param {string} path */
const read = (path) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const names = readdirSync(new URL('../packages', import.meta.url));
const config = read('release-please-config.json');
const manifest = read('.release-please-manifest.json');

test('every package publishes publicly with provenance under @agenticool', () => {
  for (const name of names) {
    const pkg = read(`packages/${name}/package.json`);
    assert.equal(pkg.name, `@agenticool/${name}`);
    assert.equal(pkg.license, 'MIT', name);
    assert.equal(pkg.type, 'module', name);
    assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
    assert.equal(pkg.repository.directory, `packages/${name}`, name);
    assert.ok(pkg.files.includes('src'), name);
  }
});

test('the packages are agents, board, core, dispatch, and spec', () => {
  assert.deepEqual([...names].sort(), [
    'agents',
    'board',
    'core',
    'dispatch',
    'spec',
  ]);
});

test('release-please releases every package as its own component', () => {
  assert.deepEqual(
    Object.keys(config.packages).sort(),
    names.map((name) => `packages/${name}`).sort(),
  );
  assert.deepEqual(
    Object.keys(manifest).sort(),
    Object.keys(config.packages).sort(),
  );
  for (const name of names) {
    assert.equal(config.packages[`packages/${name}`].component, name);
    assert.equal(
      manifest[`packages/${name}`],
      read(`packages/${name}/package.json`).version,
    );
  }
  assert.equal(config['include-component-in-tag'], true);
  assert.equal(config['separate-pull-requests'], false);
  assert.deepEqual(config.plugins, [{ type: 'node-workspace' }]);
});

test('every package resolves by name through the workspace', async () => {
  for (const name of names) await import(`@agenticool/${name}`);
});
