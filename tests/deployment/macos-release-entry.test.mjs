import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectWorkbenchEntry, parseArguments } from '../../scripts/start-workbench-from-release.mjs';

test('release entry resolves a verified active version and uses checkout as first-install fallback', t => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-release-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), releases = join(root, 'releases'), release = join(releases, 'release-one');
  const pointer = join(root, 'active.json');
  for (const dir of [repo, releases, release]) {
    mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'src', 'mcp-stdio.js'), '');
  }
  const settings = { releasesDirectory: releases, pointerFile: pointer, fallbackDirectory: repo };
  assert.equal(selectWorkbenchEntry(settings).directory, realpathSync(repo));
  const commit = 'a'.repeat(40);
  writeFileSync(join(release, '.workbench-release.json'), JSON.stringify({ version: 1, commit }));
  writeFileSync(pointer, JSON.stringify({ version: 1, commit, directory: realpathSync(release) }));
  assert.equal(selectWorkbenchEntry(settings).directory, realpathSync(release));
  writeFileSync(pointer, JSON.stringify({ version: 1, commit: 'b'.repeat(40), directory: realpathSync(release) }));
  assert.throws(() => selectWorkbenchEntry(settings), /manifest/u);
  writeFileSync(pointer, JSON.stringify({ version: 1, commit, directory: realpathSync(repo) }));
  assert.throws(() => selectWorkbenchEntry(settings), /outside/u);
});

test('release entry accepts only named options and passes through runtime arguments', () => {
  const parsed = parseArguments(['--releases', '/releases', '--pointer', '/active.json',
    '--fallback', '/repo', '--', '--some-runtime-argument']);
  assert.deepEqual(parsed.passthrough, ['--some-runtime-argument']);
  assert.throws(() => parseArguments(['--releases', '/releases']), /Expected/u);
  assert.throws(() => parseArguments(['--releases', '/releases',
    '--releases', '/duplicate', '--pointer', '/ptr']), /repeated/u);
});
