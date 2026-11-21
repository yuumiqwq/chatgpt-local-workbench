import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareInstall, renderLaunchAgent } from '../../scripts/install-macos-auto-update.mjs';

test('macOS launchd updater has bounded intervals and escapes XML safely', () => {
  const input = {
    nodePath: '/opt/homebrew/bin/node',
    runner: '/Users/a & b/repo/scripts/auto-deploy-windows.mjs',
    configFile: '/Users/a & b/config/auto.json',
    workingDirectory: '/Users/a & b/repo'
  };
  const plist = renderLaunchAgent(input);
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/u);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(plist, /a &amp; b/u);
  assert.match(renderLaunchAgent({ ...input, nodePath: '/private/tooling/node/bin/node' }), /\/private\/tooling\/node\/bin:\/opt\/homebrew\/bin/u);
  assert.doesNotMatch(plist, /a & b/u);
  assert.match(plist, /com\.yuumi\.workbench\.auto-update/u);
  assert.throws(() => renderLaunchAgent({ ...input, intervalSeconds: 15 }), /interval/u);
  assert.throws(() => renderLaunchAgent({ ...input, runner: 'relative/runner' }), /absolute/u);
  assert.throws(() => renderLaunchAgent({ ...input, label: 'bad label' }), /label/u);
});

test('macOS installer requires macOS and matching private host configuration', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'workbench-macos-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const registry = join(tmp, 'registry.json');
  const policy = join(tmp, 'policy.json');
  writeFileSync(registry, '{}');
  writeFileSync(policy, '{}');
  const deployPath = join(tmp, 'deploy.json');
  const autoPath = join(tmp, 'auto.json');
  const command = { executable: process.execPath, args: ['--version'] };
  const deploy = {
    version: 1, repository: resolve('.'), state_directory: join(tmp, 'state'),
    npm_cli: process.execPath,
    work_registries: [registry], protected_files: [policy],
    tunnel: { id: 'test-tunnel', status: command, stop: command, start: command },
    releases: { directory: join(tmp, 'releases'), pointer: join(tmp, 'active-release.json') }
  };
  writeFileSync(deployPath, JSON.stringify(deploy));
  writeFileSync(autoPath, JSON.stringify({ version: 1, hostname: 'test-mac', deployment_config: deployPath }));
  assert.throws(() => prepareInstall(autoPath, { platform: 'win32' }), /macOS/u);
  assert.throws(() => prepareInstall(autoPath, { platform: 'darwin', machine: 'other' }), /belong/u);
  const prepared = prepareInstall(autoPath, { platform: 'darwin', machine: 'test-mac', home: tmp });
  assert.equal(prepared.plistFile, join(tmp, 'Library', 'LaunchAgents', 'com.yuumi.workbench.auto-update.plist'));
  assert.match(prepared.content, /auto-deploy-windows\.mjs/u);
  assert.match(prepared.content, /<key>StartInterval<\/key><integer>900<\/integer>/u);
});
