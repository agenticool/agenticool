import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Tests and fixtures use neutral sample consumers, never a real consuming
// repository. The names are split so this file does not match itself.
const NAMES = ['m' + 'cc', 'pris' + 'matic', 'sam' + 'levin'];
const PATTERN = new RegExp(
  `(?<![a-z0-9])(?:${NAMES.join('|')})(?![a-z0-9])`,
  'i',
);
// Generated release records may name any contributor or link.
const SKIPPED = new Set(['package-lock.json', 'CHANGELOG.md']);

test('no tracked file names a real consuming repository', () => {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file && !SKIPPED.has(basename(file)));
  assert.ok(files.length > 0);
  const named = files.filter(
    (file) =>
      PATTERN.test(file) ||
      PATTERN.test(readFileSync(join(ROOT, file), 'utf8')),
  );
  assert.deepEqual(named, []);
});
