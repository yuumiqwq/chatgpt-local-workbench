#!/usr/bin/env node
// Standalone on purpose: deployment must still work after an interrupted npm ci.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export class DeploymentError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode) { throw new DeploymentError(code, message, exitCode); }
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};

function absolute(value, label, directory = false) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('CONFIG', `${label} must be an absolute path.`);
  const canonical = realpathSync(value);
  if (statSync(canonical).isDirectory() !== directory) fail('CONFIG', `${label} has the wrong file type.`);
  return canonical;
}

// Resolve even a not-yet-created state directory through its nearest existing parent.
function futurePath(file) {
  if (existsSync(file)) return realpathSync(file);
  const parent = dirname(file);
  if (parent === file) fail('CONFIG', 'State directory has no existing parent.');
  return join(futurePath(parent), relative(parent, file));
}

function command(value, label) {
  if (!value || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    fail('CONFIG', `${label} requires an executable and a string argument array.`);
  }
  const executable = absolute(value.executable, label);
  if (process.platform === 'win32' && !/\.(exe|com)$/iu.test(executable)) {
    fail('CONFIG', `${label} must use an explicit native interpreter for scripts.`);
  }
  return { executable, args: value.args };
}

export function loadConfig(file) {
  const configFile = absolute(resolve(file), 'Configuration');
  const raw = readJson(configFile);
  if (raw.version !== 1) fail('CONFIG', 'Expected deployment configuration version 1.');
  const repository = absolute(raw.repository, 'repository', true);
  if (typeof raw.state_directory !== 'string' || !isAbsolute(raw.state_directory)) {
    fail('CONFIG', 'state_directory must be an absolute path.');
  }
  const stateDirectory = futurePath(resolve(raw.state_directory));
  if (inside(repository, configFile) || inside(repository, stateDirectory) || inside(stateDirectory, repository)) {
    fail('CONFIG', 'Keep deployment configuration and its dedicated state directory outside the checkout.');
  }
  const privateFiles = (values, label) => {
    if (!Array.isArray(values) || values.length === 0) fail('CONFIG', `${label} must be a nonempty array.`);
    if (label === 'work_registries' && values.some(value => typeof value === 'string' && lstatSync(value).isSymbolicLink())) {
      fail('CONFIG', 'Use ordinary work registry files so their adjacent lock paths match Bridge.');
    }
    const files = values.map(value => absolute(value, label));
    if (new Set(files).size !== files.length || files.some(path => inside(repository, path) || inside(stateDirectory, path))) {
      fail('CONFIG', `${label} must name distinct files outside the checkout and deployment state directory.`);
    }
    return files;
  };
  const workRegistries = privateFiles(raw.work_registries, 'work_registries');
  const protectedFiles = privateFiles(raw.protected_files, 'protected_files');
  if (inside(stateDirectory, configFile)) fail('CONFIG', 'Keep the configuration outside its dedicated state directory.');
  let releases;
  if (raw.releases !== undefined) {
    if (!raw.releases || !['directory', 'pointer'].every(key =>
      typeof raw.releases[key] === 'string' && isAbsolute(raw.releases[key]))) {
      fail('CONFIG', 'releases requires absolute directory and pointer paths.');
    }
    const directory = futurePath(raw.releases.directory), pointer = futurePath(raw.releases.pointer);
    const keep = raw.releases.keep ?? 3;
    if (!Number.isInteger(keep) || keep < 2 || keep > 20 ||
        [repository, stateDirectory].some(root => inside(root, directory) || inside(directory, root)) ||
        inside(repository, pointer) || inside(directory, pointer) ||
        [configFile, ...protectedFiles, ...workRegistries].some(file => inside(directory, file) || file === pointer)) {
      fail('CONFIG', 'Use a dedicated release directory, an unprotected pointer outside the checkout, and keep 2..20 releases.');
    }
    releases = { directory, pointer, keep };
  }
  if (!raw.tunnel || typeof raw.tunnel.id !== 'string' || raw.tunnel.id.length === 0) {
    fail('CONFIG', 'tunnel.id must identify this computer\'s existing tunnel.');
  }
  const environment = raw.tunnel.environment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      Object.entries(environment).some(([key, value]) => !key || key.includes('=') || key.includes('\0') ||
        typeof value !== 'string' || value.includes('\0'))) fail('CONFIG', 'Invalid tunnel environment.');
  const seconds = (value, fallback, label) => {
    const number = value ?? fallback;
    if (!Number.isInteger(number) || number < 1 || number > 7200) fail('CONFIG', `${label} must be 1..7200 seconds.`);
    return number * 1000;
  };
  const npmCli = absolute(raw.npm_cli ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'npm_cli');
  const config = {
    configFile, repository, stateDirectory, workRegistries, protectedFiles, npmCli, releases,
    git: raw.git_executable === undefined ? 'git' : absolute(raw.git_executable, 'git_executable'),
    commandTimeout: seconds(raw.command_timeout_seconds, 1200, 'command_timeout_seconds'),
    healthTimeout: seconds(raw.health_timeout_seconds, 90, 'health_timeout_seconds'),
    tunnel: { id: raw.tunnel.id, environment,
      status: command(raw.tunnel.status, 'tunnel.status'),
      stop: command(raw.tunnel.stop, 'tunnel.stop'),
      start: command(raw.tunnel.start, 'tunnel.start') },
  };
  config.scope = hash(JSON.stringify({ machine: hostname(), repository, config: raw }));
  return config;
}

function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function acquireLock(file, purpose) {
  const owner = JSON.stringify({ pid: process.pid, machine: hostname(), token: randomUUID(), purpose });
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, owner);
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); unlinkSync(file); }
    if (error.code === 'EEXIST') fail('LOCKED', 'Another writer or an unrecovered deployment owns a required lock.', 2);
    throw error;
  }
  return () => {
    closeSync(fd);
    if (existsSync(file) && readFileSync(file, 'utf8') === owner) unlinkSync(file);
  };
}

export function assertIdle(registries) {
  for (const file of registries) {
    let store;
    try { store = readJson(file); }
    catch { fail('REGISTRY', 'A configured work registry is missing or unreadable.'); }
    if (store.version !== 1 || !Array.isArray(store.works) || !Array.isArray(store.runs) ||
        store.runs.some(run => !run || !['queued', 'running', 'completed', 'failed'].includes(run.state))) {
      fail('REGISTRY', 'A configured work registry has an unsupported structure.');
    }
    // A dead/missing owner is still unresolved work, not permission to discard it.
    if (store.runs.some(run => run.state === 'queued' || run.state === 'running')) {
      fail('BUSY', 'Bridge has queued or running work; retry after it has finished.', 2);
    }
  }
}

function fileDigests(files) { return files.map(file => hash(readFileSync(file))); }
function assertDigests(files, digests) {
  if (JSON.stringify(fileDigests(files)) !== JSON.stringify(digests)) {
    fail('CONFIG_CHANGED', 'A protected private file changed during deployment.');
  }
}

function buildDigest(repository) {
  const root = join(repository, 'dist');
  if (!existsSync(join(root, 'src', 'mcp-stdio.js'))) fail('BUILD_OUTPUT', 'Built MCP entry point is missing.');
  const digest = createHash('sha256');
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) digest.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
      else fail('BUILD_OUTPUT', 'Build output must contain ordinary files and directories.');
    }
  }
  visit(root);
  return digest.digest('hex');
}

function releasePath(config, directory) {
  if (typeof directory !== 'string' || dirname(resolve(directory)) !== config.releases.directory ||
      realpathSync(directory) !== resolve(directory)) fail('RELEASE_PATH', 'Release must be an ordinary child of its configured directory.');
  return directory;
}

function activeReleaseMatches(config, journal) {
  if (!config.releases) return true;
  try {
    const pointer = readJson(config.releases.pointer);
    return pointer.version === 1 && pointer.commit === journal.target &&
      pointer.directory === releasePath(config, journal.release_directory);
  } catch { return false; }
}

function retireReleases(config, journal, event) {
  if (!config.releases) return;
  const all = [...new Set([journal.release_directory, ...(journal.retained_releases ?? [])])];
  journal.retained_releases = all.slice(0, config.releases.keep);
  for (const directory of all.slice(config.releases.keep)) {
    try {
      releasePath(config, directory);
      if (readJson(join(directory, '.workbench-release.json')).scope !== config.scope) continue;
      rmSync(directory, { recursive: true });
      event('release-retired', { directory });
    } catch { event('release-retained', { directory }); }
  }
}

// No implicit shell: paths, arguments and private environment values stay separate.
export function runCommand({ executable, args, cwd, env, timeout, signal, log, event, label }) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) { reject(new DeploymentError('CANCELLED', 'Deployment cancelled.')); return; }
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', failure, size = 0;
    const stop = error => {
      failure ??= error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop(new DeploymentError('CANCELLED', 'Deployment cancelled.'));
    const timer = setTimeout(() => stop(new DeploymentError('TIMEOUT', `${label} timed out.`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('spawn', () => event('command', { label, pid: child.pid }));
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        try {
          size += Buffer.byteLength(chunk);
          if (size <= 20 * 1024 * 1024) appendFileSync(log, chunk);
          if (capture && stdout.length < 4 * 1024 * 1024) stdout += chunk;
        } catch { stop(new DeploymentError('LOG_WRITE', 'Unable to write the command log.')); }
      });
    }
    child.on('error', () => { failure = new DeploymentError('COMMAND', `${label} could not start.`); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new DeploymentError('COMMAND', `${label} failed with exit code ${code}.`));
      else accept(stdout);
    });
  });
}

export async function deploy(configFile, mode = 'check', { signal, onEvent = () => {} } = {}) {
  if (!['check', 'apply'].includes(mode)) fail('USAGE', 'Mode must be check or apply.');
  const config = loadConfig(configFile);
  mkdirSync(config.stateDirectory, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID();
  const eventLog = join(config.stateDirectory, runId + '.jsonl');
  const commandLog = join(config.stateDirectory, runId + '.commands.log');
  writeFileSync(commandLog, '', { flag: 'wx', mode: 0o600 });
  const event = (name, details = {}) => {
    const record = { at: new Date().toISOString(), event: name, ...details };
    appendFileSync(eventLog, JSON.stringify(record) + '\n', { mode: 0o600 });
    onEvent(record);
  };
  const invoke = (label, executable, args, env = process.env, timeout = config.commandTimeout, cwd = config.repository) => {
    event('stage', { label });
    appendFileSync(commandLog, `\n[${new Date().toISOString()}] ${label}\n`);
    return runCommand({ executable, args, cwd, env, timeout, signal,
      log: commandLog, event, label });
  };
  const git = async (...args) => (await invoke('git ' + args[0], config.git, ['-c', 'core.longpaths=true', ...args],
    { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, 120000)).trim();
  const tunnelEnvironment = { ...process.env };
  for (const [key, value] of Object.entries(config.tunnel.environment)) {
    // Windows environment variable names are case insensitive.
    for (const present of Object.keys(tunnelEnvironment)) {
      if (present.toLowerCase() === key.toLowerCase()) delete tunnelEnvironment[present];
    }
    tunnelEnvironment[key] = value;
  }
  const tunnel = (action, timeout = 120000) => invoke('tunnel ' + action, config.tunnel[action].executable,
    config.tunnel[action].args, tunnelEnvironment, timeout);
  const status = async timeout => {
    let result;
    try { result = JSON.parse(await tunnel('status', timeout)); }
    catch (error) { if (error instanceof DeploymentError) throw error; fail('TUNNEL_STATUS', 'Tunnel status is not JSON.'); }
    if (result.tunnel_id !== config.tunnel.id) fail('TUNNEL_ID', 'Existing tunnel identity does not match the configuration.');
    if (['process_running', 'healthy', 'ready'].some(key => typeof result[key] !== 'boolean')) {
      fail('TUNNEL_STATUS', 'Tunnel status must include process_running, healthy and ready booleans.');
    }
    const pid = result.process?.pid ?? result.pid ?? null;
    if (result.process_running && (!Number.isSafeInteger(pid) || pid <= 0)) {
      fail('TUNNEL_STATUS', 'A running tunnel must report its process ID.');
    }
    return { running: result.process_running, healthy: result.healthy && result.ready, pid };
  };
  const clean = async () => {
    if (await git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')) {
      fail('DIRTY', 'Git worktree or index is dirty.', 2);
    }
    if (await git('symbolic-ref', '--quiet', '--short', 'HEAD') !== 'main' ||
        await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') !== 'origin/main') {
      fail('BRANCH', 'Checkout must be main tracking origin/main.', 2);
    }
    const gitDirectory = resolve(config.repository, await git('rev-parse', '--git-dir'));
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']
      .some(name => existsSync(join(gitDirectory, name)))) fail('GIT_OPERATION', 'A Git operation is in progress.', 2);
  };
  let releaseDeployment, releaseState;
  const registryLocks = [];
  const releaseRegistries = () => { while (registryLocks.length) registryLocks.pop()(); };
  let journal;
  const journalFile = join(config.stateDirectory, 'deployment.json');
  const save = phase => {
    journal.phase = phase;
    journal.updated_at = new Date().toISOString();
    atomicJson(journalFile, journal);
    event('phase', { phase, target: journal.target });
  };
  try {
    event('begin', { mode });
    const top = realpathSync(await git('rev-parse', '--show-toplevel'));
    if (relative(top, config.repository) !== '') fail('REPOSITORY', 'repository must be the checkout root.');
    const common = realpathSync(resolve(config.repository, await git('rev-parse', '--git-common-dir')));
    releaseDeployment = acquireLock(join(common, 'bridge-deploy.lock'), 'deployment');
    releaseState = acquireLock(join(config.stateDirectory, 'deployment.lock'), 'deployment state');
    journal = existsSync(journalFile) ? readJson(journalFile) : { version: 1, scope: config.scope, deployed_commit: null, phase: 'new' };
    if (journal.version !== 1 || journal.scope !== config.scope || typeof journal.phase !== 'string') {
      fail('STATE', 'Deployment state belongs to different configuration or is invalid; use a new state directory.');
    }
    await clean();
    assertIdle(config.workRegistries);
    await git('fetch', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const head = await git('rev-parse', 'HEAD');
    const target = await git('rev-parse', 'refs/remotes/origin/main');
    try { await git('merge-base', '--is-ancestor', head, target); }
    catch (error) {
      if (error.code !== 'COMMAND') throw error;
      fail('NON_FAST_FORWARD', 'Local main is ahead of or diverged from origin/main.', 2);
    }
    const protectedFiles = [config.configFile, ...config.protectedFiles];
    const digests = fileDigests(protectedFiles);
    const current = await status();
    let buildMatches = false;
    if (head === target && journal.build_digest) {
      try { buildMatches = activeReleaseMatches(config, journal) &&
        buildDigest(config.releases ? journal.release_directory : config.repository) === journal.build_digest; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'BUILD_OUTPUT') throw error; }
    }
    const protectedMatch = JSON.stringify(digests) === JSON.stringify(journal.protected_digests);
    const completed = journal.phase === 'complete' && journal.deployed_commit === target && head === target &&
      buildMatches && protectedMatch && current.running && current.healthy;
    if (mode === 'check') {
      assertIdle(config.workRegistries);
      const result = { result: 'checked', head, target, update_available: head !== target,
        deployment_needed: !completed, tunnel_running: current.running, tunnel_healthy: current.healthy };
      event('result', result);
      return result;
    }
    // The same .lock protocol is used by WorkService.save before it launches an executor.
    // Hold it until the old runtime is confirmed stopped, then release for startup.
    for (const registry of [...config.workRegistries].sort()) registryLocks.push(acquireLock(registry + '.lock', 'Bridge deployment'));
    assertIdle(config.workRegistries);
    const registryDigests = fileDigests(config.workRegistries);
    await clean();
    if (await git('rev-parse', 'HEAD') !== head) fail('HEAD_CHANGED', 'HEAD changed during preflight.');
    if (completed) {
      event('result', { result: 'up-to-date', target });
      return { result: 'up-to-date', target };
    }
    // If startup succeeded but its response or health check was interrupted, acknowledge
    // the verified new process without stopping it for a second time.
    if (head === target && journal.target === target && journal.phase === 'starting' &&
        current.running && current.healthy && current.pid !== journal.previous_pid &&
        buildMatches && protectedMatch) {
      journal.deployed_commit = target;
      retireReleases(config, journal, event);
      save('complete');
      event('result', { result: 'recovered', target });
      return { result: 'recovered', target };
    }
    journal.target = target;
    journal.previous_pid = current.pid;
    journal.protected_digests = digests;
    save('updating');
    if (head !== target) await git('merge', '--ff-only', '--no-edit', target);
    let buildDirectory = config.repository;
    const previousPointer = config.releases && existsSync(config.releases.pointer) ? readFileSync(config.releases.pointer) : null;
    if (config.releases) {
      mkdirSync(config.releases.directory, { recursive: true });
      buildDirectory = join(config.releases.directory, target.slice(0, 12) + '-' + randomUUID().slice(0, 8));
      mkdirSync(buildDirectory);
      releasePath(config, buildDirectory);
      for (const file of (await git('ls-files', '-z')).split('\0').filter(Boolean)) {
        const source = resolve(config.repository, file), destination = resolve(buildDirectory, file);
        if (!inside(config.repository, source) || !inside(buildDirectory, destination) || !lstatSync(source).isFile()) {
          fail('RELEASE_SOURCE', 'Release source must contain ordinary tracked files.');
        }
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
      atomicJson(join(buildDirectory, '.workbench-release.json'), { version: 1, scope: config.scope, commit: target });
      journal.release_directory = buildDirectory;
      journal.previous_pointer = previousPointer === null ? null : JSON.parse(previousPointer.toString('utf8'));
    }
    for (const [phase, args] of [
      ['installing', ['ci']], ['typechecking', ['run', 'typecheck']],
      ['testing', ['test']], ['building', ['run', 'build']],
    ]) {
      save(phase);
      await invoke('npm ' + args.join(' '), process.execPath, [config.npmCli, ...args], process.env, config.commandTimeout, buildDirectory);
    }
    await clean();
    if (await git('rev-parse', 'HEAD') !== target) fail('HEAD_CHANGED', 'HEAD changed during validation.');
    assertIdle(config.workRegistries);
    assertDigests(config.workRegistries, registryDigests);
    assertDigests(protectedFiles, digests);
    journal.build_digest = buildDigest(buildDirectory);
    if (config.releases) {
      const pointerNow = existsSync(config.releases.pointer) ? readFileSync(config.releases.pointer) : null;
      if (previousPointer === null ? pointerNow !== null : !pointerNow?.equals(previousPointer)) {
        fail('RELEASE_CHANGED', 'Active release changed during validation.');
      }
    }
    const beforeStop = await status();
    if (beforeStop.pid !== current.pid || beforeStop.running !== current.running) {
      fail('RUNTIME_CHANGED', 'Tunnel process changed during validation; retry after it settles.');
    }
    save('stopping');
    if (beforeStop.running) await tunnel('stop');
    const stopped = await status();
    if (stopped.running) fail('STOP_FAILED', 'The old tunnel is still running; startup was not attempted.');
    assertDigests(protectedFiles, digests);
    if (config.releases) {
      atomicJson(config.releases.pointer, { version: 1, commit: target, directory: buildDirectory });
    }
    releaseRegistries();
    save('starting');
    await tunnel('start');
    const deadline = Date.now() + config.healthTimeout;
    for (;;) {
      let next;
      try { next = await status(Math.max(1, Math.min(120000, deadline - Date.now()))); }
      catch (error) {
        if (!['COMMAND', 'TIMEOUT'].includes(error.code)) throw error;
        event('health-retry', { code: error.code });
      }
      assertDigests(protectedFiles, digests);
      if (next?.running && next.healthy && next.pid !== journal.previous_pid) break;
      if (Date.now() >= deadline) fail('NOT_READY', 'The restarted tunnel did not become healthy; retry the same deployment.');
      await delay(Math.min(1000, deadline - Date.now()), undefined, { signal });
    }
    journal.deployed_commit = target;
    retireReleases(config, journal, event);
    save('complete');
    event('result', { result: 'deployed', target });
    return { result: 'deployed', target };
  } catch (error) {
    // Keep the last successful phase, including 'starting', for a safe subsequent apply.
    event('failure', { code: error.code ?? 'IO', phase: journal?.phase ?? 'preflight' });
    if (config.releases && journal?.release_directory &&
        ['installing', 'typechecking', 'testing', 'building'].includes(journal.phase)) {
      try {
        const directory = releasePath(config, journal.release_directory);
        const pointer = existsSync(config.releases.pointer) ? readJson(config.releases.pointer) : null;
        if (pointer?.directory !== directory && readJson(join(directory, '.workbench-release.json')).scope === config.scope) {
          rmSync(directory, { recursive: true });
          event('unactivated-release-removed', { directory });
        }
      } catch { /* Keep uncertain paths for inspection; never remove the active release. */ }
    }
    throw error;
  } finally {
    try { releaseRegistries(); }
    finally { try { releaseState?.(); } finally { releaseDeployment?.(); } }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/deploy-windows.mjs check|apply --config <absolute-private-config.json>');
    return;
  }
  if (args.length !== 3 || args[1] !== '--config') fail('USAGE', 'Use check|apply --config <absolute-private-config.json>.');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_VERSION', 'Node.js 22 or newer is required.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try { await deploy(args[2], args[0], { signal: controller.signal, onEvent: record => console.log(JSON.stringify(record)) }); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ error: error.code ?? 'IO', message: error instanceof DeploymentError ? error.message : 'Deployment failed; inspect private logs and file permissions.' }));
    process.exitCode = error.exitCode ?? 1;
  });
}
