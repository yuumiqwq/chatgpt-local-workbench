import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { AGENT_DESKTOP_INTEGRITY, AGENT_DESKTOP_VERSION, defaultDesktopDirectory,
  ensureAgentDesktop, inspectDesktopInstallation } from '../../scripts/ensure-agent-desktop.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, JSON.stringify(data));
function fixture(t) {
  const parent = resolve('codex-generated', 'desktop-install-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'tools', 'agent-desktop');
  const policy = join(root, 'private', 'host-policy.json');
  mkdirSync(join(root, 'private')); save(policy, { desktop: { enabled: false } });
  const config = { repository: join(root, 'repo'), stateDirectory: join(root, 'state'),
    protectedFiles: [policy], npmCli: join(root, 'npm-cli.js'), agentDesktop: { directory },
    releases: { directory: join(root, 'releases'), pointer: join(root, 'active.json') } };
  const calls = [], events = [];
  // Never spawn npm/native binaries in this suite. A marker models verified files.
  const inspect = path => existsSync(join(path, 'verified.json'))
    ? { status: 'ready', version: AGENT_DESKTOP_VERSION, executable: join(path, 'native.exe'), sha256: 'fixture' }
    : { status: 'missing' };
  const options = { platform: 'win32', arch: 'x64', systemDrive: 'Z:', inspect,
    event: (name, data) => events.push({ name, data }),
    invoke: async (label, executable, args, env, timeout, cwd) => {
      calls.push({ label, executable, args, env, timeout, cwd });
      if (label === 'agent-desktop npm ci') {
        const lock = read(join(cwd, 'package-lock.json'));
        assert.equal(lock.packages['node_modules/agent-desktop'].integrity, AGENT_DESKTOP_INTEGRITY);
        assert.equal(lock.packages['node_modules/agent-desktop'].version, '1.0.2');
        assert.equal(lock.packages['node_modules/agent-desktop'].resolved, 'https://registry.npmjs.org/agent-desktop/-/agent-desktop-1.0.2.tgz');
        assert.equal(read(join(cwd, 'package.json')).dependencies['agent-desktop'], '1.0.2');
        save(join(cwd, 'verified.json'), {}); return '';
      }
      return JSON.stringify({ ok: true, data: { version: '1.0.2', os: 'windows' } });
    } };
  return { root, directory, policy, config, calls, events, options };
}

test('desktop installation defaults recognize ROG, Legion and local data drives', () => {
  const exists = (...paths) => path => paths.includes(path);
  assert.equal(defaultDesktopDirectory('D:/StudyServer/repos/workbench', exists('D:/StudyServer', 'E:/Codex')), 'D:/StudyServer/tools/agent-desktop');
  assert.equal(defaultDesktopDirectory('E:/Projects/workbench', exists('E:/Codex/Tools/agent-desktop')), 'E:/Codex/Tools/agent-desktop');
  assert.match(defaultDesktopDirectory('F:/Projects/workbench', exists('F:/')), /^F:[\\/]Workbench[\\/]tools[\\/]agent-desktop$/u);
  assert.match(defaultDesktopDirectory('C:/Projects/workbench', exists('D:/')), /^D:[\\/]Workbench/u);
  assert.throws(() => defaultDesktopDirectory('C:/Projects/workbench', () => false), { code: 'DESKTOP_DATA_DRIVE' });
});

test('missing desktop installs staged pinned package, then the next ensure is a local no-op', async t => {
  const f = fixture(t), original = readFileSync(f.policy, 'utf8');
  const result = await ensureAgentDesktop(f.config, f.options);
  assert.equal(result.status, 'installed'); assert.equal(f.calls.length, 2);
  const install = f.calls[0];
  assert.equal(install.executable, process.execPath);
  assert.ok(install.args.includes('--ignore-scripts')); assert.ok(install.args.includes('--no-audit'));
  assert.ok(install.args.includes(join(f.root, 'tools', 'agent-desktop-npm-cache')));
  assert.equal(install.timeout, 120000); assert.equal(f.calls[1].timeout, 10000);
  assert.deepEqual(f.calls[1].args, ['version']);
  assert.ok(install.env.TEMP.startsWith(install.cwd));
  assert.equal(Object.keys(install.env).some(key => /^npm_config_/iu.test(key)), false);
  assert.equal(readFileSync(f.policy, 'utf8'), original);
  assert.equal(existsSync(f.config.repository), false); assert.equal(existsSync(f.config.releases.directory), false);
  const before = readdirSync(join(f.root, 'tools'));
  assert.equal((await ensureAgentDesktop(f.config, f.options)).status, 'ready');
  assert.equal(f.calls.length, 2); assert.deepEqual(readdirSync(join(f.root, 'tools')), before);
  assert.equal(existsSync(f.directory + '.install-lock'), false);
  assert.equal(before.some(name => name.includes('.staging-')), false);
});

test('preexisting matching installation does not invoke any process or create a cache', async t => {
  const f = fixture(t); mkdirSync(f.directory, { recursive: true }); save(join(f.directory, 'verified.json'), {});
  assert.equal((await ensureAgentDesktop(f.config, f.options)).status, 'ready');
  assert.deepEqual(f.calls, []); assert.deepEqual(readdirSync(join(f.root, 'tools')), ['agent-desktop']);
});

test('version replacement retains old prefix and never changes host policy', async t => {
  const f = fixture(t); mkdirSync(f.directory, { recursive: true });
  save(join(f.directory, 'package.json'), { dependencies: { 'agent-desktop': '1.0.1' } });
  writeFileSync(join(f.directory, 'old'), 'working old installation');
  const result = await ensureAgentDesktop(f.config, f.options);
  assert.equal(result.status, 'installed'); assert.equal(readFileSync(join(result.previous, 'old'), 'utf8'), 'working old installation');
  assert.equal(read(f.policy).desktop.enabled, false);
});

test('failed optional install preserves existing prefix, records diagnostics and removes only its staging lock', async t => {
  const f = fixture(t); mkdirSync(f.directory, { recursive: true });
  save(join(f.directory, 'package.json'), { dependencies: { 'agent-desktop': '1.0.1' } });
  const original = readFileSync(join(f.directory, 'package.json'), 'utf8');
  f.options.invoke = async () => { throw Object.assign(new Error('mock network failure'), { code: 'COMMAND_TIMEOUT' }); };
  const result = await ensureAgentDesktop(f.config, f.options);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'COMMAND_TIMEOUT');
  assert.equal(readFileSync(join(f.directory, 'package.json'), 'utf8'), original);
  assert.equal(existsSync(f.directory + '.install-lock'), false);
  assert.equal(readdirSync(join(f.root, 'tools')).some(name => name.includes('.staging-')), false);
  assert.equal(f.events.at(-1).name, 'agent-desktop-warning');
});

test('invalid native version never publishes the staged prefix', async t => {
  const f = fixture(t), invoke = f.options.invoke;
  f.options.invoke = (...args) => args[0] === 'agent-desktop version' ? '{"ok":true,"data":{"version":"9.0","os":"windows"}}' : invoke(...args);
  assert.equal((await ensureAgentDesktop(f.config, f.options)).code, 'DESKTOP_INSTALL_INVALID');
  assert.equal(existsSync(f.directory), false);
});

test('rejects C drive, source/release overlap, unmanaged directories and invalid settings', async t => {
  const f = fixture(t);
  for (const directory of [f.config.repository, f.config.releases.directory, join(f.root, 'private'), 'C:/Workbench/tools']) {
    const result = await ensureAgentDesktop({ ...f.config, agentDesktop: { directory } }, { ...f.options, systemDrive: 'C:' });
    assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 0);
  }
  assert.equal((await ensureAgentDesktop({ ...f.config, agentDesktop: { ...f.config.agentDesktop, command: 'arbitrary' } }, f.options)).code, 'DESKTOP_CONFIG');
  mkdirSync(f.directory, { recursive: true }); writeFileSync(join(f.directory, 'unrelated'), 'retained');
  assert.equal((await ensureAgentDesktop(f.config, f.options)).code, 'DESKTOP_UNMANAGED');
  assert.equal(readFileSync(join(f.directory, 'unrelated'), 'utf8'), 'retained');
});

test('disabled/non-Windows installs, a held installation lock and cancellation never launch npm', async t => {
  const f = fixture(t);
  assert.equal((await ensureAgentDesktop({ ...f.config, agentDesktop: { enabled: false } }, f.options)).status, 'disabled');
  assert.equal((await ensureAgentDesktop(f.config, { ...f.options, platform: 'linux' })).status, 'not-applicable');
  mkdirSync(f.directory + '.install-lock', { recursive: true });
  assert.equal((await ensureAgentDesktop(f.config, f.options)).status, 'busy');
  assert.equal(existsSync(f.directory + '.install-lock'), true);
  assert.equal((await ensureAgentDesktop(f.config, { ...f.options, signal: AbortSignal.abort() })).status, 'failed');
  assert.deepEqual(f.calls, []);
});

test('real inspection rejects unsupported architecture, unofficial origin and tampered native checksum', t => {
  const f = fixture(t), pkg = join(f.directory, 'node_modules', 'agent-desktop');
  assert.throws(() => inspectDesktopInstallation(f.directory, 'ia32'), { code: 'DESKTOP_ARCH' });
  assert.equal(inspectDesktopInstallation(f.directory, 'arm64').status, 'missing');
  mkdirSync(join(pkg, 'bin'), { recursive: true }); save(join(pkg, 'package.json'), { name: 'agent-desktop', version: '1.0.2' });
  assert.throws(() => inspectDesktopInstallation(f.directory), { code: 'DESKTOP_ORIGIN' });
  const metadata = { name: 'agent-desktop', version: '1.0.1', repository: { url: 'git+https://github.com/vercel-labs/agent-desktop.git' } };
  save(join(pkg, 'package.json'), metadata); assert.equal(inspectDesktopInstallation(f.directory).status, 'version-mismatch');
  save(join(pkg, 'package.json'), { ...metadata, version: '1.0.2' });
  const native = join(pkg, 'bin', 'agent-desktop-win32-x64.exe');
  writeFileSync(native, 'corrupt'); writeFileSync(native + '.sha256', 'untrusted checksum');
  assert.throws(() => inspectDesktopInstallation(f.directory, 'x64'), { code: 'DESKTOP_INTEGRITY' });
});
