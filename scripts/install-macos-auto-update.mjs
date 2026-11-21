#!/usr/bin/env node
// Install a per-user macOS launchd update job for the shared Workbench repository.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './deploy-windows.mjs';

export const LABEL = 'com.yuumi.workbench.auto-update';
const MARKER = '<!-- Managed by chatgpt-local-workbench/scripts/install-macos-auto-update.mjs -->';
const xml = value => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');

function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(name + ' must be absolute.');
  return resolve(value);
}

export function renderLaunchAgent({ nodePath, runner, configFile, workingDirectory,
  intervalSeconds = 900, label = LABEL }) {
  if (!/^[A-Za-z][A-Za-z0-9.-]+$/u.test(label)) throw new Error('Invalid launchd label.');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 300 || intervalSeconds > 86400) {
    throw new Error('Update interval must be 300..86400 seconds.');
  }
  const args = [absolute(nodePath, 'nodePath'), absolute(runner, 'runner'), '--config',
    absolute(configFile, 'configFile')];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    MARKER, '<plist version="1.0">', '<dict>',
    '  <key>Label</key><string>' + xml(label) + '</string>',
    '  <key>ProgramArguments</key>', '  <array>',
    ...args.map(arg => '    <string>' + xml(arg) + '</string>'),
    '  </array>',
    '  <key>WorkingDirectory</key><string>' + xml(absolute(workingDirectory, 'workingDirectory')) + '</string>',
    '  <key>EnvironmentVariables</key><dict>',
    '    <key>PATH</key><string>' + xml([dirname(absolute(nodePath, 'nodePath')), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')) + '</string>',
    '  </dict>',
    '  <key>StartInterval</key><integer>' + intervalSeconds + '</integer>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>ProcessType</key><string>Background</string>',
    '</dict>', '</plist>', ''
  ];
  return lines.join('\n');
}

export function prepareInstall(specFile, { platform = process.platform, home = homedir(),
  machine = hostname(), nodePath = process.execPath } = {}) {
  if (platform !== 'darwin') throw new Error('The launchd installer requires macOS.');
  const file = absolute(specFile, 'specFile');
  const spec = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  if (spec.version !== 1 || spec.hostname !== machine) {
    throw new Error('Automatic deployment configuration does not belong to this Mac.');
  }
  const config = loadConfig(spec.deployment_config);
  if (!config.releases) throw new Error('Use isolated release directories for automatic deployment.');
  const runner = join(config.repository, 'scripts', 'auto-deploy-windows.mjs');
  if (!existsSync(runner)) throw new Error('The shared Workbench updater is missing.');
  const plistFile = join(absolute(home, 'home'), 'Library', 'LaunchAgents', LABEL + '.plist');
  return {
    plistFile,
    content: renderLaunchAgent({ nodePath, runner, configFile: file, workingDirectory: config.repository }),
    label: LABEL,
    stateDirectory: config.stateDirectory
  };
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error('launchctl ' + args[0] + ' failed; verify the logged-in macOS user session.');
  }
  return result.status === 0;
}

export function installMacAutoUpdate(specFile, options = {}) {
  const prepared = prepareInstall(specFile, options);
  const uid = options.uid ?? process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Invalid macOS user ID.');
  const domain = 'gui/' + uid;
  const old = existsSync(prepared.plistFile) ? readFileSync(prepared.plistFile, 'utf8') : null;
  if (old !== null && !old.includes(MARKER)) {
    throw new Error('The launchd job path belongs to an unmanaged configuration.');
  }
  mkdirSync(dirname(prepared.plistFile), { recursive: true });
  const loaded = launchctl(['print', domain + '/' + prepared.label], { allowFailure: true });
  if (old === prepared.content && loaded) return { status: 'already-installed', label: prepared.label };
  if (loaded) launchctl(['bootout', domain + '/' + prepared.label]);
  let changed = false;
  try {
    if (old !== prepared.content) {
      const temporary = prepared.plistFile + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temporary, prepared.content, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, prepared.plistFile);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      changed = true;
    }
    launchctl(['bootstrap', domain, prepared.plistFile]);
    if (!launchctl(['print', domain + '/' + prepared.label], { allowFailure: true })) {
      throw new Error('New macOS update job did not register.');
    }
    return { status: 'installed', label: prepared.label, interval_seconds: 900, plist: prepared.plistFile };
  } catch (error) {
    if (changed) {
      if (old === null) unlinkSync(prepared.plistFile);
      else writeFileSync(prepared.plistFile, old, { mode: 0o600 });
    }
    if (loaded && old !== null) {
      launchctl(['bootstrap', domain, prepared.plistFile], { allowFailure: true });
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') {
      throw new Error('Usage: node scripts/install-macos-auto-update.mjs --config <private-auto-update.json>');
    }
    console.log(JSON.stringify(installMacAutoUpdate(process.argv[3])));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
