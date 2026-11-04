// Optional Windows deployment dependency, independent of host authorization.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export const AGENT_DESKTOP_VERSION = '1.0.2';
// The integrity-pinned npm tarball includes Windows x64/ARM64 binaries and
// checksum sidecars. No postinstall download or npm launcher rewrite is needed.
export const AGENT_DESKTOP_INTEGRITY = 'sha512-k2Qi3f0y1U60YaJOw1dob3EO55P/DuH4HK3WKdI9sMZLjVxpGZAzuG50rIWuIqS0JIVy07g+0pp9Of2JDjTX0w==';
const tarball = `https://registry.npmjs.org/agent-desktop/-/agent-desktop-${AGENT_DESKTOP_VERSION}.tgz`;
const hashes = {
  x64: '409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988',
  arm64: '5877fbca41fb85806353d0aaf67c23cfdf06a58a77c5d9cba005727a2891034e'
};
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
};

export function defaultDesktopDirectory(repository, exists = existsSync) {
  if (win32.resolve(repository).toLowerCase().startsWith('d:\\studyserver\\') && exists('D:/StudyServer')) {
    return 'D:/StudyServer/tools/agent-desktop';
  }
  if (exists('E:/Codex/Tools/agent-desktop')) return 'E:/Codex/Tools/agent-desktop';
  if (exists('E:/Codex')) return 'E:/Codex/Tools/agent-desktop';
  const drive = win32.parse(repository).root;
  if (/^[d-z]:[\\/]$/iu.test(drive) && exists(drive)) return win32.join(drive, 'Workbench', 'tools', 'agent-desktop');
  for (const drive of ['E:/', 'D:/']) if (exists(drive)) return win32.join(drive, 'Workbench', 'tools', 'agent-desktop');
  fail('DESKTOP_DATA_DRIVE', 'Configure agent_desktop.directory on a local data drive.');
}

function noLinks(file) {
  for (let current = file;; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('DESKTOP_PATH', 'Linked installation paths are not supported.');
    if (current === dirname(current)) break;
  }
}

function installationPaths(config, systemDrive) {
  const settings = config.agentDesktop ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).some(key => !['enabled', 'directory', 'cache_directory'].includes(key)) ||
      settings.enabled !== undefined && typeof settings.enabled !== 'boolean') fail('DESKTOP_CONFIG', 'Invalid agent_desktop deployment settings.');
  const directory = settings.directory ?? defaultDesktopDirectory(config.repository);
  const cache = settings.cache_directory ?? join(dirname(directory), 'agent-desktop-npm-cache');
  const excluded = [config.repository, config.stateDirectory, config.configFile,
    ...(config.protectedFiles ?? []), ...(config.workRegistries ?? []),
    ...(config.releases ? [config.releases.directory, config.releases.pointer] : [])].filter(Boolean).map(resolvePath => resolve(resolvePath));
  const paths = [directory, cache].map(value => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') ||
        value.split(/[\\/]/u).includes('..') || /^[\\/]{2}/u.test(value) ||
        win32.parse(value).root.toLowerCase().startsWith(systemDrive.toLowerCase())) fail('DESKTOP_PATH', 'Use ordinary absolute data-drive paths outside C:.');
    const path = resolve(value);
    noLinks(path);
    if (dirname(path) === path || excluded.some(other => inside(path, other) || inside(other, path))) {
      fail('DESKTOP_PATH', 'Installation/cache must be separate from source, releases and private configuration.');
    }
    return path;
  });
  if (inside(paths[0], paths[1]) || inside(paths[1], paths[0])) fail('DESKTOP_PATH', 'Installation and cache must be separate directories.');
  return { directory: paths[0], cache: paths[1] };
}

export function inspectDesktopInstallation(directory, arch = process.arch) {
  if (!hashes[arch]) fail('DESKTOP_ARCH', 'Only Windows x64 and arm64 are supported.');
  const packageRoot = join(directory, 'node_modules', 'agent-desktop');
  const metadata = join(packageRoot, 'package.json');
  noLinks(metadata);
  if (!existsSync(metadata)) return { status: 'missing' };
  const pkg = read(metadata);
  if (pkg.name !== 'agent-desktop' || pkg.repository?.url !== 'git+https://github.com/vercel-labs/agent-desktop.git') {
    fail('DESKTOP_ORIGIN', 'Installed package does not identify the official project.');
  }
  if (pkg.version !== AGENT_DESKTOP_VERSION) return { status: 'version-mismatch' };
  const executable = join(packageRoot, 'bin', `agent-desktop-win32-${arch}.exe`);
  noLinks(executable); noLinks(executable + '.sha256');
  if (!existsSync(executable) || !existsSync(executable + '.sha256')) return { status: 'missing' };
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 134217728) fail('DESKTOP_INTEGRITY', 'Invalid native executable.');
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (sha256 !== readFileSync(executable + '.sha256', 'utf8').trim() || sha256 !== hashes[arch]) {
    fail('DESKTOP_INTEGRITY', 'Native binary SHA-256 differs from the packaged and pinned checksum; local review required.');
  }
  return { status: 'ready', version: pkg.version, executable, sha256, architecture: arch };
}

function installerEnvironment(temporary) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|userprofile|home|appdata|localappdata|https?_proxy|no_proxy)$/iu.test(key)) env[key] = value;
  }
  return { ...env, TEMP: temporary, TMP: temporary, AGENT_DESKTOP_HOME: temporary };
}

export async function ensureAgentDesktop(config, { invoke, event = () => {}, signal,
  platform = process.platform, arch = process.arch, systemDrive = 'C:', inspect = inspectDesktopInstallation } = {}) {
  if (platform !== 'win32') return { status: 'not-applicable' };
  if (config.agentDesktop?.enabled === false) return { status: 'disabled' };
  let staging, directory, lock, lockOwned = false, heartbeat;
  try {
    signal?.throwIfAborted();
    const paths = installationPaths(config, systemDrive);
    directory = paths.directory;
    const present = inspect(directory, arch);
    if (present.status === 'ready') { event('agent-desktop', present); return present; }
    // Never rename an unrelated directory supplied as the installation target.
    if (existsSync(directory) && readdirSync(directory).length &&
        (!existsSync(join(directory, 'package.json')) || !read(join(directory, 'package.json')).dependencies?.['agent-desktop'])) {
      fail('DESKTOP_UNMANAGED', 'Installation target is nonempty and is not an agent-desktop prefix.');
    }
    mkdirSync(dirname(directory), { recursive: true });
    lock = directory + '.install-lock';
    try { mkdirSync(lock); lockOwned = true; }
    catch (error) { if (error.code === 'EEXIST') return { status: 'busy' }; throw error; }
    // Recheck after acquiring the cross-process lock.
    const rechecked = inspect(directory, arch);
    if (rechecked.status === 'ready') return rechecked;
    staging = mkdtempSync(join(dirname(directory), basename(directory) + '.staging-'));
    mkdirSync(paths.cache, { recursive: true });
    const temporary = join(staging, '.tmp'); mkdirSync(temporary);
    const npmrc = join(staging, '.npmrc'); writeFileSync(npmrc, '');
    const root = { name: 'workbench-agent-desktop', version: '1.0.0', private: true,
      dependencies: { 'agent-desktop': AGENT_DESKTOP_VERSION } };
    writeFileSync(join(staging, 'package.json'), JSON.stringify(root));
    writeFileSync(join(staging, 'package-lock.json'), JSON.stringify({ name: root.name, version: root.version,
      lockfileVersion: 3, requires: true, packages: { '': root,
        'node_modules/agent-desktop': { version: AGENT_DESKTOP_VERSION, resolved: tarball, integrity: AGENT_DESKTOP_INTEGRITY } } }));
    event('agent-desktop-installing', { version: AGENT_DESKTOP_VERSION, directory });
    heartbeat = setInterval(() => event('agent-desktop-progress', { state: 'installing' }), 10000);
    const env = installerEnvironment(temporary);
    await invoke('agent-desktop npm ci', process.execPath, [config.npmCli, 'ci', '--prefix', staging,
      '--cache', paths.cache, '--registry=https://registry.npmjs.org', '--userconfig', npmrc,
      '--globalconfig', join(staging, '.global-npmrc'), '--ignore-scripts', '--no-audit', '--no-fund'], env, 120000, staging);
    const verified = inspect(staging, arch);
    if (verified.status !== 'ready') fail('DESKTOP_INSTALL_INVALID', 'Staged package did not validate.');
    const version = JSON.parse(await invoke('agent-desktop version', verified.executable, ['version'], env, 10000, staging));
    if (version.ok !== true || version.data?.version !== AGENT_DESKTOP_VERSION || version.data?.os !== 'windows') {
      fail('DESKTOP_INSTALL_INVALID', 'Native CLI version check failed.');
    }
    signal?.throwIfAborted();
    let previous;
    if (existsSync(directory)) {
      previous = directory + '.previous-' + randomUUID();
      renameSync(directory, previous);
    }
    try { renameSync(staging, directory); staging = undefined; }
    catch (error) { if (previous) renameSync(previous, directory); throw error; }
    const result = { ...inspect(directory, arch), status: 'installed', ...(previous ? { previous } : {}) };
    event('agent-desktop', result);
    return result;
  } catch (error) {
    const result = { status: 'failed', code: error.code ?? 'DESKTOP_INSTALL_FAILED',
      message: 'Optional agent-desktop installation failed; existing Workbench and host authorization are unchanged.' };
    event('agent-desktop-warning', result);
    return result;
  } finally {
    clearInterval(heartbeat);
    // Only the uniquely created staging sibling and lock are eligible for removal.
    if (staging && directory && dirname(staging) === dirname(directory) &&
        basename(staging).startsWith(basename(directory) + '.staging-')) {
      try { noLinks(staging); rmSync(staging, { recursive: true, force: true }); } catch { /* Retain uncertain staging paths. */ }
    }
    if (lockOwned) { try { rmdirSync(lock); } catch { /* A retained lock requires operator inspection. */ } }
  }
}
