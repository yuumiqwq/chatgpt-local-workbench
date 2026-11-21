#!/usr/bin/env node
// Stable MCP entry point that follows the deployment's active-release pointer.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function absolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(label + ' must be absolute.');
  return resolve(path);
}
function json(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')); }

export function selectWorkbenchEntry({ releasesDirectory, pointerFile, fallbackDirectory }) {
  const root = realpathSync(absolute(releasesDirectory, 'releasesDirectory'));
  const fallback = realpathSync(absolute(fallbackDirectory, 'fallbackDirectory'));
  const pointerPath = absolute(pointerFile, 'pointerFile');
  let directory = fallback;
  if (existsSync(pointerPath)) {
    const pointer = json(pointerPath);
    if (pointer.version !== 1 || !/^[0-9a-f]{40}$/u.test(pointer.commit) ||
        typeof pointer.directory !== 'string') throw new Error('Invalid active release pointer.');
    directory = realpathSync(absolute(pointer.directory, 'pointer.directory'));
    if (dirname(directory) !== root || directory !== resolve(pointer.directory)) {
      throw new Error('Active release is outside the configured releases directory.');
    }
    const manifest = json(join(directory, '.workbench-release.json'));
    if (manifest.version !== 1 || manifest.commit !== pointer.commit) {
      throw new Error('Active release manifest does not match the pointer.');
    }
  }
  const entry = join(directory, 'dist', 'src', 'mcp-stdio.js');
  if (!existsSync(entry)) throw new Error('Compiled Workbench entry is missing.');
  return { directory, entry };
}

export function parseArguments(args) {
  const result = {};
  const divider = args.indexOf('--');
  const options = divider === -1 ? args : args.slice(0, divider);
  if (options.length !== 6) throw new Error('Expected --releases, --pointer and --fallback absolute paths.');
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (!['--releases', '--pointer', '--fallback'].includes(key) || result[key]) {
      throw new Error('Invalid or repeated entry-point option.');
    }
    result[key] = options[i + 1];
  }
  if (!result['--releases'] || !result['--pointer'] || !result['--fallback']) {
    throw new Error('Missing entry-point option.');
  }
  return {
    settings: { releasesDirectory: result['--releases'], pointerFile: result['--pointer'],
      fallbackDirectory: result['--fallback'] },
    passthrough: divider === -1 ? [] : args.slice(divider + 1)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { settings, passthrough } = parseArguments(process.argv.slice(2));
    const { directory, entry } = selectWorkbenchEntry(settings);
    const child = spawn(process.execPath, [entry, ...passthrough], {
      cwd: directory, env: process.env, stdio: 'inherit', windowsHide: true
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
