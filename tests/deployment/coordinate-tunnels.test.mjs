import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinate, validateProfiles } from '../../scripts/coordinate-tunnels.mjs';

const config = { shared_command: 'node shared-entry.cjs', tunnels: [
  { alias: 'first', id: 'tunnel_first' }, { alias: 'second', id: 'tunnel_second' }
] };
function fixture(runs = []) {
  const calls = [];
  const healthy = t => ({ tunnel_id: t.id, process_running: true, healthy: true, ready: true });
  return { calls, io: { readRuns: () => runs, alive: () => true,
    build: async () => calls.push('build'), status: async t => healthy(t),
    stop: async t => calls.push(`stop:${t.alias}`),
    connect: async t => { calls.push(`connect:${t.alias}`); return healthy(t); }
  } };
}
test('an active Bridge task blocks all build and restart operations', async () => {
  const { calls, io } = fixture([{ state: 'running', owner_pid: 123 }]);
  await assert.rejects(coordinate('update', config, io), /Active Bridge tasks/);
  assert.deepEqual(calls, []);
});
test('ensure preserves existing processes, including temporarily unhealthy ones', async () => {
  const { calls, io } = fixture();
  io.status = async t => ({ tunnel_id: t.id, process_running: true, healthy: false, ready: false });
  await coordinate('ensure', config, io, 'second');
  assert.deepEqual(calls, []);
});
test('idle update builds once and reconnects each distinct tunnel', async () => {
  const { calls, io } = fixture();
  await coordinate('update', config, io);
  assert.deepEqual(calls, ['build', 'stop:first', 'connect:first', 'stop:second', 'connect:second']);
});
test('a task arriving during the build prevents any subsequent restart', async () => {
  const runs = []; const { calls, io } = fixture(runs);
  io.build = async () => { calls.push('build'); runs.push({ state: 'queued', owner_pid: 123 }); };
  await assert.rejects(coordinate('update', config, io), /Active Bridge tasks/);
  assert.deepEqual(calls, ['build']);
});
test('profiles retain separate tunnel IDs and exactly the same code entry', () => {
  const profiles = config.tunnels.map(t => ({ control_plane: { tunnel_id: t.id }, mcp: { commands: [{ command: config.shared_command }] } }));
  validateProfiles(config, profiles);
  profiles[1].mcp.commands[0].command = 'node old-study-plugin.mjs';
  assert.throws(() => validateProfiles(config, profiles), /shared entry/);
});
