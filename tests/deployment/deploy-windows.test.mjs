import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { acquireLock, deploy, loadConfig, runCommand } from '../../scripts/deploy-windows.mjs';
import { autoDeploy } from '../../scripts/auto-deploy-windows.mjs';

const script = fileURLToPath(new URL('../../scripts/deploy-windows.mjs', import.meta.url));
const generated = resolve('codex-generated', 'deployment-tests');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Deployment Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Deployment Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
}).trim();

const fakeProgram = `
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(join(root, name), 'utf8'));
const save = (name, value) => fs.writeFileSync(join(root, name), JSON.stringify(value));
const control = read('control.json');
const npm = process.argv[1].endsWith('npm-cli.mjs');
const action = npm ? 'npm ' + process.argv.slice(2).join(' ') : process.argv[2];
const calls = read('calls.json'); calls.push(action); save('calls.json', calls);
if (control.fail === action) { console.error('fixture failure: ' + action); process.exit(7); }
if (npm) {
  if (!fs.existsSync(join(root, 'works.json.lock'))) throw new Error('Missing registry lock');
  if (control.liveDllPath) {
    if (fs.readFileSync(control.liveDllPath, 'utf8') !== 'in-use native library') throw new Error('Live dependencies were changed');
    if (action === 'npm ci') {
      fs.rmSync(join(process.cwd(), 'node_modules'), { recursive: true, force: true });
      fs.mkdirSync(join(process.cwd(), 'node_modules'));
      fs.writeFileSync(join(process.cwd(), 'node_modules', 'native.dll'), 'candidate native library');
    }
    if (fs.readFileSync(control.liveDllPath, 'utf8') !== 'in-use native library') throw new Error('npm ci touched the live library');
  }
  if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay));
  if (control.mutateAt === action) fs.writeFileSync(control.mutateFile, control.mutateContent);
  if (action === 'npm run build') {
    fs.mkdirSync(join(process.cwd(), 'dist', 'src'), { recursive: true });
    fs.writeFileSync(join(process.cwd(), 'dist', 'src', 'mcp-stdio.js'), fs.readFileSync('release.txt'));
  }
  console.log('fixture ' + action);
} else {
  const runtime = read('runtime.json');
  if (action === 'stop' && !control.ignoreStop) runtime.process_running = false;
  if (action === 'start') {
    if (fs.existsSync(join(root, 'works.json.lock'))) throw new Error('Registry still locked at startup');
    runtime.process_running = true; runtime.healthy = !control.unhealthy; runtime.ready = !control.unhealthy;
    runtime.process.pid += 1;
    if (control.newId) runtime.tunnel_id = control.newId;
    if (control.releasePointer) {
      runtime.loadedRelease = JSON.parse(fs.readFileSync(control.releasePointer, 'utf8'));
      runtime.loadedCode = fs.readFileSync(join(runtime.loadedRelease.directory, 'dist', 'src', 'mcp-stdio.js'), 'utf8');
    }
  }
  save('runtime.json', runtime);
  if (action === 'start' && control.failAfterStart) process.exit(8);
  if (action === 'status' && control.invalidStatus) console.log('invalid JSON');
  else console.log(JSON.stringify(runtime));
}
`;

function fixture(t, count = 1) {
  mkdirSync(generated, { recursive: true });
  const root = mkdtempSync(join(generated, 'case-'));
  // Only this test's newly-created directory is removed.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'origin.git'), seed = join(root, 'publisher');
  mkdirSync(seed);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  // Receive-pack runs separately from the caller's per-command configuration.
  git(remote, 'config', 'core.longpaths', 'true');
  git(seed, 'init', '--initial-branch=main');
  writeFileSync(join(seed, 'release.txt'), 'release 1\n');
  writeFileSync(join(seed, '.gitignore'), 'dist/\nnode_modules/\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-u', 'origin', 'main');
  const initial = git(seed, 'rev-parse', 'HEAD');
  function publish(text = 'release 2\n') {
    writeFileSync(join(seed, 'release.txt'), text);
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'release'); git(seed, 'push', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  }
  const machines = [];
  for (let i = 0; i < count; i++) {
    const repo = join(root, `computer ${i} checkout`), privateDir = join(root, `computer ${i} private`);
    git(root, 'clone', '--branch', 'main', remote, repo);
    git(repo, 'config', 'core.autocrlf', 'false');
    mkdirSync(privateDir);
    const registry = join(privateDir, 'works.json');
    save(registry, { version: 1, works: [{ name: 'Retained work', thread_id: 'retained-native-uuid' }], runs: [] });
    writeFileSync(join(privateDir, 'profile.yaml'), 'existing-profile-bytes: preserved\n');
    writeFileSync(join(privateDir, 'session.jsonl'), 'retained native history\n');
    save(join(privateDir, 'runtime.json'), { tunnel_id: `existing-${i}`, process_running: true,
      healthy: true, ready: true, process: { pid: 41000 + i * 100 } });
    save(join(privateDir, 'control.json'), {}); save(join(privateDir, 'calls.json'), []);
    writeFileSync(join(privateDir, 'npm-cli.mjs'), fakeProgram);
    writeFileSync(join(privateDir, 'tunnel.mjs'), fakeProgram);
    const invoke = action => ({ executable: process.execPath, args: [join(privateDir, 'tunnel.mjs'), action] });
    const config = { version: 1, repository: repo, state_directory: join(privateDir, 'deployment-state'),
      npm_cli: join(privateDir, 'npm-cli.mjs'), work_registries: [registry],
      protected_files: [join(privateDir, 'profile.yaml')], health_timeout_seconds: 1,
      tunnel: { id: `existing-${i}`, status: invoke('status'), stop: invoke('stop'), start: invoke('start') } };
    const configFile = join(privateDir, 'deploy.json'); save(configFile, config);
    machines.push({ repo, privateDir, registry, config, configFile,
      calls: () => json(join(privateDir, 'calls.json')),
      control: value => save(join(privateDir, 'control.json'), value),
      runtime: () => json(join(privateDir, 'runtime.json')),
      state: () => json(join(config.state_directory, 'deployment.json')) });
  }
  return { root, remote, seed, initial, publish, machines, ...machines[0] };
}

const rejection = (promise, code) => assert.rejects(promise, error => error.code === code);
const noRestart = f => assert.equal(f.calls().some(action => action === 'stop' || action === 'start'), false);
const noLocks = f => {
  assert.equal(existsSync(f.registry + '.lock'), false);
  assert.equal(existsSync(join(f.repo, '.git', 'bridge-deploy.lock')), false);
  assert.equal(existsSync(join(f.config.state_directory, 'deployment.lock')), false);
};

test('check fetches origin/main without updating the checkout or restarting', async t => {
  const f = fixture(t), target = f.publish();
  const result = await deploy(f.configFile, 'check');
  assert.equal(result.target, target); assert.equal(result.update_available, true);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial);
  assert.equal(git(f.repo, 'rev-parse', 'origin/main'), target);
  assert.deepEqual(f.calls(), ['status']); noLocks(f);
  assert.equal(existsSync(join(f.config.state_directory, 'deployment.json')), false);
});

test('two independent computers fast-forward separately and preserve local identities and data', async t => {
  const f = fixture(t, 2), target = f.publish(), [a, b] = f.machines;
  const originals = f.machines.map(m => [m.registry, join(m.privateDir, 'profile.yaml'), join(m.privateDir, 'session.jsonl')]
    .map(file => readFileSync(file, 'utf8')));
  assert.equal((await deploy(a.configFile, 'apply')).result, 'deployed');
  assert.equal(git(b.repo, 'rev-parse', 'HEAD'), f.initial); assert.deepEqual(b.calls(), []);
  assert.equal((await deploy(b.configFile, 'apply')).result, 'deployed');
  for (const [i, m] of f.machines.entries()) {
    assert.equal(git(m.repo, 'rev-parse', 'HEAD'), target);
    assert.equal(m.state().deployed_commit, target); assert.equal(m.state().phase, 'complete');
    assert.equal(m.runtime().tunnel_id, `existing-${i}`);
    assert.deepEqual(m.calls().filter(action => action !== 'status'),
      ['npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'stop', 'start']);
    assert.deepEqual([m.registry, join(m.privateDir, 'profile.yaml'), join(m.privateDir, 'session.jsonl')]
      .map(file => readFileSync(file, 'utf8')), originals[i]);
    assert.equal(git(m.repo, 'status', '--porcelain'), ''); noLocks(m);
    const before = m.calls();
    assert.equal((await deploy(m.configFile, 'apply')).result, 'up-to-date');
    assert.deepEqual(m.calls().slice(before.length), ['status']);
  }
});

function enableReleases(f, keep = 3) {
  const releases = { directory: join(f.privateDir, 'releases'), pointer: join(f.privateDir, 'active-release.json'), keep };
  save(f.configFile, { ...f.config, releases });
  return releases;
}

test('release deployment installs and validates away from in-use dependencies before switching startup', async t => {
  const f = fixture(t), releases = enableReleases(f), target = f.publish();
  mkdirSync(join(f.repo, 'node_modules'));
  const liveDllPath = join(f.repo, 'node_modules', 'native.dll');
  writeFileSync(liveDllPath, 'in-use native library');
  mkdirSync(join(f.repo, 'dist', 'src'), { recursive: true });
  writeFileSync(join(f.repo, 'dist', 'src', 'mcp-stdio.js'), 'existing running code');
  f.control({ liveDllPath, releasePointer: releases.pointer });
  assert.equal((await deploy(f.configFile, 'apply')).result, 'deployed');
  const active = json(releases.pointer);
  assert.equal(active.commit, target);
  assert.equal(f.runtime().loadedCode, 'release 2\n');
  assert.equal(f.runtime().loadedRelease.directory, active.directory);
  assert.equal(readFileSync(liveDllPath, 'utf8'), 'in-use native library');
  assert.equal(readFileSync(join(f.repo, 'dist', 'src', 'mcp-stdio.js'), 'utf8'), 'existing running code');
  assert.equal(readFileSync(join(active.directory, 'node_modules', 'native.dll'), 'utf8'), 'candidate native library');
  const calls = f.calls().length;
  assert.equal((await deploy(f.configFile, 'apply')).result, 'up-to-date');
  assert.deepEqual(f.calls().slice(calls), ['status']);
  save(releases.pointer, { ...active, commit: 'wrong-commit' });
  assert.equal((await deploy(f.configFile, 'check')).deployment_needed, true);
  noLocks(f);
});

test('failed release validation retains the active version and removes only its unused candidate', async t => {
  const f = fixture(t), releases = enableReleases(f);
  f.control({ releasePointer: releases.pointer });
  await deploy(f.configFile, 'apply');
  const active = readFileSync(releases.pointer, 'utf8'), runtime = f.runtime(), calls = f.calls().length;
  f.publish(); f.control({ fail: 'npm test', releasePointer: releases.pointer });
  await rejection(deploy(f.configFile, 'apply'), 'COMMAND');
  assert.equal(readFileSync(releases.pointer, 'utf8'), active);
  assert.deepEqual(f.runtime(), runtime);
  assert.equal(readdirSync(releases.directory).length, 1);
  assert.equal(f.calls().slice(calls).some(x => x === 'stop' || x === 'start'), false);
  noLocks(f);
});

test('release startup recovery does not restart twice and retention keeps the configured prior versions', async t => {
  const f = fixture(t), releases = enableReleases(f, 2);
  f.control({ releasePointer: releases.pointer, failAfterStart: true });
  await rejection(deploy(f.configFile, 'apply'), 'COMMAND');
  const initialDirectory = json(releases.pointer).directory, calls = f.calls().length;
  f.control({ releasePointer: releases.pointer });
  assert.equal((await deploy(f.configFile, 'apply')).result, 'recovered');
  assert.deepEqual(f.calls().slice(calls), ['status']);
  f.publish(); await deploy(f.configFile, 'apply');
  f.publish('release 3\n'); await deploy(f.configFile, 'apply');
  assert.equal(f.runtime().loadedCode, 'release 3\n');
  assert.equal(readdirSync(releases.directory).length, 2);
  assert.equal(existsSync(initialDirectory), false);
  noLocks(f);
});

test('release locations may not contain source, configuration, or the mutable pointer', t => {
  const f = fixture(t);
  for (const releases of [
    { directory: f.repo, pointer: join(f.privateDir, 'active.json') },
    { directory: f.privateDir, pointer: join(f.root, 'active.json') },
    { directory: join(f.privateDir, 'releases'), pointer: join(f.privateDir, 'releases', 'active.json') },
    { directory: join(f.privateDir, 'releases'), pointer: join(f.privateDir, 'profile.yaml') },
  ]) {
    save(f.configFile, { ...f.config, releases });
    assert.throws(() => loadConfig(f.configFile), error => error.code === 'CONFIG');
  }
});

test('automatic deployment coordinates the guardian and phone, skips unchanged versions, and restores maintenance state on failure', async t => {
  const f = fixture(t), releases = enableReleases(f);
  const phone = join(f.privateDir, 'phone'); mkdirSync(phone);
  const guardian = { pause_file: join(f.privateDir, 'guardian.paused'), state_file: join(f.privateDir, 'guardian.json') };
  save(guardian.state_file, { paused: false, at: new Date().toISOString() });
  const watcher = setInterval(() => {
    if (existsSync(guardian.pause_file)) save(guardian.state_file, { paused: true, at: new Date().toISOString() });
  }, 20);
  t.after(() => clearInterval(watcher));
  const auto = join(f.privateDir, 'auto.json');
  save(auto, { version: 1, hostname: hostname(), deployment_config: f.configFile, guardian, phone_state_directory: phone });
  f.control({ releasePointer: releases.pointer });
  assert.equal((await autoDeploy(auto)).status, 'deployed');
  const calls = f.calls().length;
  assert.equal((await autoDeploy(auto)).status, 'up-to-date');
  assert.deepEqual(f.calls().slice(calls), ['status']);
  assert.equal(existsSync(guardian.pause_file), false);
  assert.equal(existsSync(join(phone, 'operation.lock')), false);
  f.publish();
  save(join(phone, 'lease.json'), { expires: Date.now() + 60000 });
  await rejection(autoDeploy(auto), 'BUSY');
  assert.equal(existsSync(join(phone, 'operation.lock')), false);
  assert.equal(existsSync(guardian.pause_file), false);
  save(join(phone, 'lease.json'), null);
  f.control({ fail: 'npm ci' });
  await rejection(autoDeploy(auto), 'COMMAND');
  assert.equal(existsSync(guardian.pause_file), false);
  assert.equal(existsSync(join(phone, 'operation.lock')), false);
  assert.equal(existsSync(join(f.config.state_directory, 'automatic.lock')), false);
  assert.equal(json(join(f.config.state_directory, 'automatic.json')).status, 'failed');
  assert.equal(json(releases.pointer).commit, f.initial);
});

for (const [name, dirty] of [
  ['tracked', f => writeFileSync(join(f.repo, 'release.txt'), 'local edits')],
  ['untracked', f => writeFileSync(join(f.repo, 'local.txt'), 'local edits')],
  ['staged', f => { writeFileSync(join(f.repo, 'local.txt'), 'local edits'); git(f.repo, 'add', '.'); }],
]) {
  test(`dirty ${name} files block all update and service actions`, async t => {
    const f = fixture(t); f.publish(); dirty(f);
    await rejection(deploy(f.configFile, 'apply'), 'DIRTY');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); assert.deepEqual(f.calls(), []); noLocks(f);
  });
}

test('local commits, divergence, another branch and Git operations are rejected', async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'local.txt'), 'local commit');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'local');
  const local = git(f.repo, 'rev-parse', 'HEAD');
  await rejection(deploy(f.configFile, 'apply'), 'NON_FAST_FORWARD');
  f.publish(); await rejection(deploy(f.configFile, 'apply'), 'NON_FAST_FORWARD');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), local);
  git(f.repo, 'checkout', '-b', 'feature');
  await rejection(deploy(f.configFile, 'apply'), 'BRANCH');
  git(f.repo, 'checkout', 'main');
  writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), f.initial + '\n');
  await rejection(deploy(f.configFile, 'apply'), 'GIT_OPERATION'); noRestart(f); noLocks(f);
});

test('queued and running records, including unknown/dead owners, defer deployment', async t => {
  const f = fixture(t); f.publish();
  for (const run of [{ state: 'queued' }, { state: 'running', owner_pid: process.pid }, { state: 'running', owner_pid: 2147483647 }]) {
    save(f.registry, { version: 1, works: [], runs: [run] });
    await rejection(deploy(f.configFile, 'apply'), 'BUSY');
    assert.deepEqual(json(f.registry).runs, [run]); noLocks(f);
  }
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); assert.deepEqual(f.calls(), []);
});

test('every configured local registry participates in the idle check', async t => {
  const f = fixture(t); f.publish();
  const second = join(f.privateDir, 'another-bridge.json');
  save(second, { version: 1, works: [], runs: [{ state: 'running' }] });
  save(f.configFile, { ...f.config, work_registries: [f.registry, second] });
  await rejection(deploy(f.configFile, 'apply'), 'BUSY');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); noRestart(f);
});

test('missing, corrupt and unknown registry structures block deployment', async t => {
  const f = fixture(t); f.publish();
  for (const value of ['broken json', '{}', '{"version":1,"works":[],"runs":[{"state":"new-state"}]}']) {
    writeFileSync(f.registry, value);
    await rejection(deploy(f.configFile, 'apply'), 'REGISTRY'); noLocks(f);
  }
  rmSync(f.registry);
  await assert.rejects(deploy(f.configFile, 'apply'));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); noRestart(f);
});

for (const step of ['npm ci', 'npm run typecheck', 'npm test', 'npm run build']) {
  test(`${step} failure keeps the runtime and retries when HEAD already equals origin/main`, async t => {
    const f = fixture(t), target = f.publish(), runtime = f.runtime();
    f.control({ fail: step });
    await rejection(deploy(f.configFile, 'apply'), 'COMMAND');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target);
    assert.equal(f.state().deployed_commit, null); assert.deepEqual(f.runtime(), runtime); noRestart(f); noLocks(f);
    assert.equal(f.calls().at(-1), step);
    const previous = f.calls().length;
    f.control({}); assert.equal((await deploy(f.configFile, 'apply')).result, 'deployed');
    assert.deepEqual(f.calls().slice(previous).filter(action => action !== 'status'),
      ['npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'stop', 'start']);
    assert.equal(f.state().deployed_commit, target); noLocks(f);
    const logs = readdirSync(f.config.state_directory).filter(file => file.endsWith('.jsonl'))
      .flatMap(file => readFileSync(join(f.config.state_directory, file), 'utf8').trim().split('\n').map(JSON.parse));
    assert.ok(logs.some(entry => entry.event === 'failure'));
    assert.ok(logs.some(entry => entry.event === 'result' && entry.result === 'deployed'));
  });
}

test('fetch failures leave local HEAD and the tunnel untouched', async t => {
  const f = fixture(t);
  git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
  await rejection(deploy(f.configFile, 'apply'), 'COMMAND');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); noRestart(f); noLocks(f);
});

test('identity and status must be established before updating', async t => {
  const f = fixture(t); f.publish();
  save(join(f.privateDir, 'runtime.json'), { ...f.runtime(), tunnel_id: 'another-computer' });
  await rejection(deploy(f.configFile, 'apply'), 'TUNNEL_ID');
  f.control({ invalidStatus: true });
  await rejection(deploy(f.configFile, 'apply'), 'TUNNEL_STATUS');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); noRestart(f); noLocks(f);
});

test('private configuration changes during validation prevent service actions', async t => {
  const f = fixture(t); f.publish();
  f.control({ mutateAt: 'npm run build', mutateFile: join(f.privateDir, 'profile.yaml'), mutateContent: 'changed' });
  await rejection(deploy(f.configFile, 'apply'), 'CONFIG_CHANGED'); noRestart(f); noLocks(f);
});

test('a changed tunnel PID during validation prevents stopping an unrelated runtime', async t => {
  const f = fixture(t); f.publish();
  f.control({ mutateAt: 'npm run build', mutateFile: join(f.privateDir, 'runtime.json'),
    mutateContent: JSON.stringify({ ...f.runtime(), process: { pid: 99999 } }) });
  await rejection(deploy(f.configFile, 'apply'), 'RUNTIME_CHANGED'); noRestart(f); noLocks(f);
});

test('new task records and dirty files appearing during validation prevent restart', async t => {
  const f = fixture(t); f.publish();
  const busy = { version: 1, works: [], runs: [{ state: 'running', owner_pid: process.pid }] };
  f.control({ mutateAt: 'npm run build', mutateFile: f.registry, mutateContent: JSON.stringify(busy) });
  await rejection(deploy(f.configFile, 'apply'), 'BUSY'); noRestart(f); noLocks(f);
  save(f.registry, { version: 1, works: [], runs: [] });
  f.control({ mutateAt: 'npm run build', mutateFile: join(f.repo, 'new-edit.txt'), mutateContent: 'local edit' });
  await rejection(deploy(f.configFile, 'apply'), 'DIRTY'); noRestart(f); noLocks(f);
});

test('deployment mutex excludes overlapping invocations and retains unknown old locks', async t => {
  const f = fixture(t); f.publish(); f.control({ delay: 300 });
  let started;
  const gate = new Promise(resolve => { started = resolve; });
  const first = deploy(f.configFile, 'apply', { onEvent: event => {
    if (event.event === 'phase' && event.phase === 'installing') started();
  } });
  await gate;
  await rejection(deploy(f.configFile, 'apply'), 'LOCKED');
  assert.equal((await first).result, 'deployed'); noLocks(f);
  const lock = join(f.repo, '.git', 'bridge-deploy.lock');
  writeFileSync(lock, '{"pid":2147483647}');
  await rejection(deploy(f.configFile, 'apply'), 'LOCKED');
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":2147483647}');
});

test('registry locks exclude a deployment before git fast-forward', async t => {
  const f = fixture(t); f.publish();
  const release = acquireLock(f.registry + '.lock', 'test writer');
  try { await rejection(deploy(f.configFile, 'apply'), 'LOCKED'); }
  finally { release(); }
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); noRestart(f); noLocks(f);
});

test('stop failure never calls start; successful retry runs validation again', async t => {
  const f = fixture(t); f.publish(); f.control({ ignoreStop: true });
  await rejection(deploy(f.configFile, 'apply'), 'STOP_FAILED');
  assert.equal(f.calls().includes('start'), false); noLocks(f);
  f.control({}); assert.equal((await deploy(f.configFile, 'apply')).result, 'deployed');
});

test('lost startup response is safely acknowledged on retry without a second restart', async t => {
  const f = fixture(t), target = f.publish(); f.control({ failAfterStart: true });
  await rejection(deploy(f.configFile, 'apply'), 'COMMAND');
  assert.equal(f.state().phase, 'starting'); assert.equal(f.state().deployed_commit, null); noLocks(f);
  const calls = f.calls().length;
  f.control({}); assert.equal((await deploy(f.configFile, 'apply')).result, 'recovered');
  assert.deepEqual(f.calls().slice(calls), ['status']); assert.equal(f.state().deployed_commit, target);
});

test('failed upgrades retain the previous successful commit and missing output is rebuilt', async t => {
  const f = fixture(t);
  await deploy(f.configFile, 'apply');
  const target = f.publish(); f.control({ fail: 'npm ci' });
  const originalRuntime = f.runtime();
  await rejection(deploy(f.configFile, 'apply'), 'COMMAND');
  assert.equal(f.state().deployed_commit, f.initial); assert.deepEqual(f.runtime(), originalRuntime);
  f.control({}); await deploy(f.configFile, 'apply');
  rmSync(join(f.repo, 'dist'), { recursive: true });
  assert.equal((await deploy(f.configFile, 'check')).deployment_needed, true);
  assert.equal((await deploy(f.configFile, 'apply')).result, 'deployed');
  assert.equal(f.state().deployed_commit, target); noLocks(f);
});

test('unhealthy or wrong-identity startup is not marked deployed', async t => {
  const f = fixture(t); f.publish(); f.control({ unhealthy: true });
  await rejection(deploy(f.configFile, 'apply'), 'NOT_READY');
  assert.equal(f.state().phase, 'starting'); assert.equal(f.state().deployed_commit, null); noLocks(f);
  save(join(f.privateDir, 'runtime.json'), { ...f.runtime(), process_running: false });
  f.control({ newId: 'unexpected-id' });
  await rejection(deploy(f.configFile, 'apply'), 'TUNNEL_ID');
  assert.equal(f.state().deployed_commit, null); noLocks(f);
});

test('private paths inside the checkout or a junction to it are rejected', async t => {
  const f = fixture(t);
  const embedded = join(f.repo, 'private.json'); save(embedded, f.config);
  await rejection(deploy(embedded, 'apply'), 'CONFIG');
  save(f.configFile, { ...f.config, state_directory: join(f.repo, 'ignored-state') });
  await rejection(deploy(f.configFile, 'apply'), 'CONFIG');
  save(f.configFile, { ...f.config, work_registries: [join(f.repo, 'release.txt')] });
  assert.throws(() => loadConfig(f.configFile), error => error.code === 'CONFIG');
  const linked = join(f.root, 'checkout-alias');
  symlinkSync(f.repo, linked, process.platform === 'win32' ? 'junction' : 'dir');
  save(f.configFile, { ...f.config, state_directory: join(linked, 'future-state') });
  await rejection(deploy(f.configFile, 'apply'), 'CONFIG');
  assert.deepEqual(f.calls(), []);
});

test('cancellation terminates the spawned command tree before releasing execution', async t => {
  const f = fixture(t), controller = new AbortController();
  const log = join(f.privateDir, 'cancel.log');
  const command = join(f.privateDir, 'waiting.mjs');
  const descendantFile = join(f.privateDir, 'descendant.pid');
  const marker = join(f.privateDir, 'unexpected-descendant-output');
  writeFileSync(command, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e',
      'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "alive"), 900)', process.argv[3]], { stdio: 'ignore' });
    writeFileSync(process.argv[2], String(child.pid));
    setInterval(() => {}, 1000);
  `);
  let pid;
  const running = runCommand({ executable: process.execPath, args: [command, descendantFile, marker], cwd: f.privateDir,
    env: process.env, timeout: 5000, signal: controller.signal, log, label: 'cancel test',
    event: (_event, details) => { pid = details.pid; } });
  const deadline = Date.now() + 3000;
  while (!existsSync(descendantFile) && Date.now() < deadline) await delay(20);
  assert.equal(existsSync(descendantFile), true);
  controller.abort();
  await rejection(running, 'CANCELLED');
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  await delay(1000);
  assert.equal(existsSync(marker), false);
});

test('command deadlines stop validation subprocesses', async t => {
  const f = fixture(t);
  let pid;
  await rejection(runCommand({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: f.privateDir, env: process.env, timeout: 100, log: join(f.privateDir, 'timeout.log'), label: 'timeout test',
    event: (_event, details) => { pid = details.pid; } }), 'TIMEOUT');
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('deployment guide contains a valid private configuration example', () => {
  const guide = readFileSync(new URL('../../docs/windows-git-deployment.md', import.meta.url), 'utf8');
  const example = guide.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(example);
  const config = JSON.parse(example);
  assert.equal(config.version, 1); assert.equal(config.tunnel.status.args[0], 'runtimes');
});

test('PowerShell wrapper defaults to check and accepts paths containing spaces', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); f.publish();
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(dirname(script), 'deploy-windows.ps1'), '-Config', f.configFile],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.ok(output.includes('"result":"checked"'));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.initial); noRestart(f);
});
