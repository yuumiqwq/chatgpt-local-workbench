import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateProfiles(config, profiles) {
  if (config.tunnels.length !== 2 || new Set(config.tunnels.map(t => t.id)).size !== 2) {
    throw new Error('Configure two distinct existing tunnels.');
  }
  for (const [index, profile] of profiles.entries()) {
    if (profile.control_plane?.tunnel_id !== config.tunnels[index].id ||
        profile.mcp?.commands?.length !== 1 ||
        profile.mcp.commands[0].command !== config.shared_command) {
      throw new Error('Tunnel identity or shared entry does not match the deployment manifest.');
    }
  }
}

export async function coordinate(operation, config, io, only) {
  const tunnels = only ? config.tunnels.filter(t => t.alias === only) : config.tunnels;
  if (!tunnels.length) throw new Error('Unknown tunnel alias.');
  const busy = () => io.readRuns().filter(r => ['queued', 'running'].includes(r.state) &&
    (!r.owner_pid || io.alive(r.owner_pid)));
  const assertIdle = () => {
    if (busy().length) throw new Error('Active Bridge tasks: further deployment deferred; running instances preserved.');
  };
  if (operation === 'plan') return { blocked: busy().length > 0, build_once: true,
    tunnels: config.tunnels.map(t => ({ alias: t.alias, tunnel_id: t.id })) };
  if (operation === 'update') {
    assertIdle();
    await io.build();
  } else if (operation !== 'ensure' && operation !== 'status') throw new Error('Unknown operation.');
  const results = [];
  for (const tunnel of tunnels) {
    let status = await io.status(tunnel);
    if (status.tunnel_id !== tunnel.id) throw new Error('Runtime tunnel identity changed.');
    if (operation === 'update') {
      assertIdle();
      if (status.process_running) await io.stop(tunnel);
      status = await io.connect(tunnel);
    } else if (operation === 'ensure' && !status.process_running) {
      status = await io.connect(tunnel);
    }
    results.push({ alias: tunnel.alias, tunnel_id: tunnel.id, pid: status.process?.pid ?? status.pid,
      process_running: status.process_running, healthy: status.healthy, ready: status.ready });
  }
  return results;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function main() {
  const [operation, manifest, option] = process.argv.slice(2);
  if (!manifest) throw new Error('Usage: node scripts/coordinate-tunnels.mjs plan|status|ensure|update <manifest.json> [alias|--apply]');
  if (operation === 'update' && option !== '--apply') throw new Error('Use plan first, then update <manifest.json> --apply during an idle maintenance window.');
  const config = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const profiles = config.tunnels.map(t => JSON.parse(fs.readFileSync(t.profile, 'utf8')));
  validateProfiles(config, profiles);
  const byAlias = new Map(config.tunnels.map((t, i) => [t.alias, profiles[i]]));
  function native(tunnel, args) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(TUNNEL_CLIENT_|CONTROL_PLANE_|MCP_|HEALTH_|LOG_|PID_FILE$|OPEN_WEB_UI$|ALLOW_REMOTE_UI$)/i.test(key)) delete env[key];
    }
    Object.assign(env, config.environment, { TUNNEL_CLIENT_STATE_DIR: tunnel.state_dir });
    try {
      return JSON.parse(execFileSync(config.tunnel_client, args, {
        cwd: config.repository, env, encoding: 'utf8', windowsHide: true, timeout: 90000,
        maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
      }));
    } catch { throw new Error(`Tunnel ${tunnel.alias}: ${args[1]} failed; inspect its local diagnostics.`); }
  }
  const io = {
    alive,
    readRuns: () => JSON.parse(fs.readFileSync(config.registry, 'utf8')).runs,
    status: t => native(t, ['runtimes', 'status', t.alias, '--json']),
    stop: t => native(t, ['runtimes', 'stop', t.alias, '--json']),
    connect: t => native(t, ['runtimes', 'connect', '--alias', t.alias, '--tunnel-id', t.id,
      '--profile', path.basename(t.profile, '.yaml'), '--profile-dir', path.dirname(t.profile),
      '--mcp-command', config.shared_command, '--runtime-api-key', byAlias.get(t.alias).control_plane.api_key, '--json']),
    build: () => {
      try {
        const output = execFileSync(config.build.command, config.build.args, {
          cwd: config.repository, encoding: 'utf8', windowsHide: true, timeout: 120000,
          maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
        });
        fs.writeFileSync(path.join(path.dirname(manifest), 'build.log'), output);
      } catch { throw new Error('Shared build failed; running tunnels were preserved.'); }
    }
  };
  const lock = `${manifest}.lock`;
  let descriptor;
  if (operation === 'ensure' || operation === 'update') {
    if (fs.existsSync(lock)) {
      const owner = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0 || alive(owner)) throw new Error('Deployment coordinator is already running.');
      fs.unlinkSync(lock);
    }
    descriptor = fs.openSync(lock, 'wx');
    fs.writeFileSync(descriptor, String(process.pid));
  }
  try {
    const result = await coordinate(operation, config, io, operation === 'ensure' ? option : undefined);
    console.log(JSON.stringify(result, null, 2));
    if (Array.isArray(result) && result.some(r => !r.process_running || !r.healthy || !r.ready)) process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(lock); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
