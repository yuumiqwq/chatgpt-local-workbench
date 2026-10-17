import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PhoneService, phoneSchemas } from '../../src/phone/service.js';
import { registerPhoneTools } from '../../src/phone/tools.js';
import { administerPhone } from '../../src/phone/admin.js';
import { loadPhoneConfig, type PhoneConfig } from '../../src/phone/config.js';
import { RealAdb, type Adb } from '../../src/phone/adb.js';
import { HostPolicy } from '../../src/host/host-policy.js';
import { registerHostTools } from '../../src/host/host-tools.js';

class FakeAdb implements Adb {
  calls: string[][] = [];
  state = 'device'; rotation = 0; package = 'com.example.app'; fail = false; uiFail = false; failAfterWrite = false;
  png!: Buffer;
  async run(args: string[]) {
    this.calls.push(args);
    if (this.fail) throw new Error('ADB_FAILED_OR_TIMEOUT');
    if (args[0] === 'devices') return Buffer.from(`List of devices attached\nAYCVVB2B09005827\t${this.state}\n`);
    if (this.state !== 'device') throw new Error('ADB_FAILED_OR_TIMEOUT');
    const s = args.join(' ');
    if (s.includes('dumpsys window')) return Buffer.from(`mCurrentFocus=Window{aa u0 ${this.package}/.Main}\nmRotation=${this.rotation}\nPhysical size: 1080x2400`);
    if (s.includes('screencap')) return this.png;
    if (s.includes('uiautomator')) return Buffer.from(this.uiFail ? 'ERROR' : '<?xml version="1.0"?><hierarchy><node text="untrusted"/></hierarchy>');
    if (s.includes('dumpsys battery')) return Buffer.from('level: 82\nscale: 100\nstatus: 2\nUSB powered: true\ntemperature: 310');
    if (s.includes('query-activities')) return Buffer.from('com.example.app/.Main\ncom.example.other/.Main\ncom.example.app/.Second');
    if (s.includes('resolve-activity')) return Buffer.from('com.example.app/.Main');
    if (s.includes('default_input_method')) return Buffer.from('org.workbench.ime/.WorkbenchIme');
    if (s.includes('input ') || s.includes('am start') || s.includes('am broadcast')) {
      if (this.failAfterWrite) this.fail = true;
      return Buffer.from('Broadcast completed: result=1');
    }
    return Buffer.from('');
  }
  get writes() { return this.calls.filter(c => /shell (input |am start|am broadcast)/.test(c.join(' '))); }
}
const data = (result: CallToolResult) => JSON.parse((result.content[0] as {text: string}).text);
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'phone-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config: PhoneConfig = { enabled: true, hostname: hostname(), adb_path: process.execPath, serial: 'AYCVVB2B09005827', state_dir: dir, lease_seconds: 60, frame_seconds: 10, ime_enabled: true };
  const adb = new FakeAdb();
  adb.png = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#aaa' } }).png().toBuffer();
  let now = Date.now();
  const phone = new PhoneService(config, adb, () => now);
  const acquire = async () => data(await phone.call('phone_acquire_control', {})).lease_id as string;
  const observe = async () => data(await phone.call('phone_observe', {})).frame_id as string;
  return { dir, config, adb, phone, acquire, observe, tick: (ms: number) => { now += ms; } };
}
test('fake-device MCP tools/list and tools/call expose strict nine-tool opt-in surface', async t => {
  const f = await fixture(t), server = new McpServer({ name: 'fake-phone', version: '1' });
  registerPhoneTools(server, f.phone);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), Object.keys(phoneSchemas).sort());
  assert.ok(tools.every(t => t.inputSchema.additionalProperties === false));
  assert.equal((await client.callTool({ name: 'phone_acquire_control', arguments: { owner: 'administrator' } })).isError, true);
  const status = data(await client.callTool({ name: 'server_status', arguments: {} }) as CallToolResult);
  assert.equal(status.first_unlock, 'unknown'); assert.equal(status.battery.temperature_celsius, 31);
  const result = await client.callTool({ name: 'phone_observe', arguments: { ui: true } }) as CallToolResult;
  assert.equal(result.content[1]?.type, 'image');
  const frame = data(result); assert.equal(frame.width, 1080); assert.equal(frame.height, 2400);
  assert.equal(frame.rendered.height, 1280); assert.equal(frame.coordinate_space, 'original_physical_pixels');
  assert.equal(frame.flag_secure, 'unknown'); assert.equal(frame.ui.status, 'fresh');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10 * 1024 * 1024);
  const lease_id = data(await client.callTool({ name: 'phone_acquire_control' }) as CallToolResult).lease_id;
  const opened = await client.callTool({ name: 'phone_open_app', arguments: { lease_id, request_id: 'open-request-000001', package: 'com.example.app' } }) as CallToolResult;
  assert.equal(data(opened).result.target_app_observed, true);
  assert.equal(data(await client.callTool({ name: 'phone_list_apps', arguments: { search: 'example', limit: 1 } }) as CallToolResult).total, 2);
  const fresh = data(await client.callTool({ name: 'phone_observe' }) as CallToolResult);
  assert.equal(data(await client.callTool({ name: 'phone_input', arguments: { lease_id, request_id: 'mcp-input-request001', frame_id: fresh.frame_id, action: { type: 'tap', x: 0, y: 2300 } } }) as CallToolResult).result.status, 'completed');
  assert.equal(data(await client.callTool({ name: 'phone_display', arguments: { lease_id, request_id: 'mcp-display-req0001', action: 'physical_off' } }) as CallToolResult).status, 'unsupported_unverified');
  assert.equal(data(await client.callTool({ name: 'phone_recover', arguments: { lease_id, request_id: 'mcp-recover-req0001', action: 'reconnect' } }) as CallToolResult).status, 'needs_user_action');
  assert.equal(data(await client.callTool({ name: 'phone_release_control', arguments: { lease_id } }) as CallToolResult).released, true);
});
test('leases coordinate separate instances, expire, renew and reject forged owners', async t => {
  const f = await fixture(t), other = new PhoneService(f.config, f.adb);
  const key = await f.acquire();
  assert.equal(data(await other.call('phone_acquire_control', {})).status, 'busy');
  await assert.rejects(f.phone.assertHostCommandAllowed());
  await f.phone.call('phone_release_control', { lease_id: 'incorrect-capability' });
  assert.equal(data(await f.phone.call('phone_acquire_control', {})).status, 'busy');
  f.tick(61000); const next = await f.acquire(); assert.notEqual(next, key);
  await f.phone.call('phone_release_control', { lease_id: next });
  await f.phone.call('phone_release_control', { lease_id: next });
  await f.phone.assertHostCommandAllowed();
});
test('single action, persistent deduplication, request conflict, Unicode no plaintext persistence', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  const args = { lease_id, frame_id, request_id: 'unicode-request-0001', action: { type: 'text', text: '中文\n第二行 😀', mode: 'replace' } };
  assert.equal(data(await f.phone.call('phone_input', args)).result.status, 'completed');
  const other = new PhoneService(f.config, f.adb);
  assert.equal(data(await other.call('phone_input', args)).replayed, true);
  assert.equal(f.adb.writes.length, 1);
  assert.equal(data(await other.call('phone_input', { ...args, action: { ...args.action, text: 'different' } })).error, 'PHONE_REQUEST_CONFLICT');
  assert.ok(f.adb.writes[0]?.includes(Buffer.from(args.action.text).toString('base64')));
  for (const file of await readdir(f.dir)) assert.ok(!(await readFile(join(f.dir, file), 'utf8')).includes('第二行'));
});
test('uncertain side effect remains outcome_unknown across restart and abandoned lock', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  const args = { lease_id, frame_id, request_id: 'unknown-request-001', action: { type: 'tap', x: 10, y: 20 } };
  f.adb.failAfterWrite = true;
  assert.equal(data(await f.phone.call('phone_input', args)).status, 'outcome_unknown');
  await mkdir(join(f.dir, 'operation.lock'));
  assert.equal(data(await new PhoneService(f.config, f.adb).call('phone_input', args)).status, 'outcome_unknown');
  assert.equal(f.adb.writes.length, 1);
});
test('expired, changed pixels, app and rotation frames reject before writes', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  const run = (frame_id: string, n: string) => f.phone.call('phone_input', { lease_id, frame_id, request_id: `frame-request-${n.padStart(4, '0')}`, action: { type: 'tap', x: 1, y: 1 } });
  let frame = await f.observe(); f.tick(11000); assert.equal(data(await run(frame, '1')).error, 'PHONE_FRAME_EXPIRED');
  frame = await f.observe(); f.adb.rotation = 2; assert.equal(data(await run(frame, '2')).error, 'PHONE_FRAME_CHANGED');
  frame = await f.observe(); f.adb.package = 'com.other.app'; assert.equal(data(await run(frame, '3')).error, 'PHONE_FRAME_CHANGED');
  frame = await f.observe(); f.adb.png = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#bbb' } }).png().toBuffer();
  assert.equal(data(await run(frame, '4')).error, 'PHONE_FRAME_CHANGED'); assert.equal(f.adb.writes.length, 0);
});
test('disconnect, unauthorized/offline, unknown state and fresh XML failure never return stale images', async t => {
  const f = await fixture(t); await f.observe();
  f.adb.uiFail = true; const failed = await f.phone.call('phone_observe', { ui: true });
  assert.equal(failed.isError, true); assert.equal(failed.content.length, 1);
  for (const state of ['offline', 'unauthorized']) {
    f.adb.state = state; const status = data(await f.phone.call('server_status', {}));
    assert.equal(status.adb.state, state); assert.equal(status.battery.percent, null);
  }
  f.adb.fail = true; assert.equal(data(await f.phone.call('server_status', {})).adb.state, 'unknown');
  assert.equal((await f.phone.call('phone_observe', {})).isError, true);
});
test('admin pause immediately revokes, resume invalidates old lease; display/recovery do not touch shared daemons', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  await administerPhone(f.phone.store, 'pause');
  assert.equal(data(await f.phone.call('phone_acquire_control', {})).error, 'PHONE_ADMIN_PAUSED');
  await administerPhone(f.phone.store, 'resume');
  assert.equal(data(await f.phone.call('phone_display', { lease_id, request_id: 'display-request-001', action: 'wake' })).error, 'PHONE_LEASE_INVALID');
  const key = await f.acquire();
  assert.equal(data(await f.phone.call('phone_display', { lease_id: key, request_id: 'display-request-002', action: 'physical_off' })).status, 'unsupported_unverified');
  assert.equal(data(await f.phone.call('phone_recover', { lease_id: key, request_id: 'recover-request-001', action: 'reconnect' })).status, 'needs_user_action');
  assert.equal(f.adb.writes.length, 0);
});
test('Windows-compatible lock recovery refuses live PID and preserves journal after process crash', async t => {
  const f = await fixture(t);
  const storeUrl = new URL('../../src/phone/store.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {PhoneStore} from ${JSON.stringify(storeUrl)}; const s=new PhoneStore(process.argv[1]); await s.lock(async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});});`, f.dir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { child.kill(); });
  await once(child.stdout!, 'data');
  assert.equal(data(await f.phone.call('phone_acquire_control', {})).error, 'PHONE_BUSY_OR_ABANDONED_LOCK');
  await administerPhone(f.phone.store, 'pause');
  await assert.rejects(administerPhone(f.phone.store, 'recover-lock', true), /alive/);
  const exited = once(child, 'exit'); child.kill(); await exited;
  await f.phone.store.save('request-preserved.json', { state: 'pending' });
  await administerPhone(f.phone.store, 'recover-lock', true);
  assert.deepEqual(await f.phone.store.read('request-preserved.json'), { state: 'pending' });
  assert.equal(await f.phone.store.paused(), true);
});
test('opt-in config validates hostname, absolute paths, and fails closed; absent/disabled preserves tools', async t => {
  const f = await fixture(t), path = join(f.dir, 'config.json');
  assert.equal(await loadPhoneConfig(path), undefined);
  await writeFile(path, '{"enabled":false}'); assert.equal(await loadPhoneConfig(path), undefined);
  await writeFile(path, JSON.stringify({ ...f.config, hostname: 'LAPTOP-NHHRR3GO-different' })); await assert.rejects(loadPhoneConfig(path), /HOSTNAME_MISMATCH/);
  await writeFile(path, JSON.stringify({ ...f.config, adb_path: 'relative/adb.exe' })); await assert.rejects(loadPhoneConfig(path));
});

test('observation takes exactly one new screenshot; context transitions reject without returning old images', async t => {
  const f = await fixture(t);
  await f.phone.call('phone_observe', { ui: true });
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 1);
  const original = f.adb.run.bind(f.adb);
  f.adb.run = async args => { const result = await original(args); if (args.includes('screencap')) f.adb.package = 'com.changed.app'; return result; };
  const result = await f.phone.call('phone_observe', {});
  assert.equal(data(result).error, 'PHONE_FRAME_CHANGED_DURING_CAPTURE'); assert.equal(result.content.length, 1);
});

test('all typed input paths, coordinates, key whitelist and app cache are bounded', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  const actions = [
    { type: 'tap', x: 1079, y: 2399 }, { type: 'long_press', x: 2, y: 3 },
    { type: 'swipe', x: 2, y: 3, to_x: 100, to_y: 100 }, { type: 'key', key: 'BACK' },
    { type: 'text', text: '追加\n内容', mode: 'append' }
  ];
  for (const [index, action] of actions.entries()) {
    const frame_id = await f.observe();
    const result = await f.phone.call('phone_input', { lease_id, frame_id, request_id: `typed-request-0000${index}`, action });
    assert.equal(data(result).result.status, 'completed');
  }
  let frame_id = await f.observe();
  assert.equal(data(await f.phone.call('phone_input', { lease_id, frame_id, request_id: 'invalid-coords-0001', action: { type: 'tap', x: 1080, y: 2400 } })).error, 'PHONE_COORDINATES_OUTSIDE_FRAME');
  frame_id = await f.observe();
  assert.equal((await f.phone.call('phone_input', { lease_id, frame_id, request_id: 'invalid-key-000001', action: { type: 'key', key: 'POWER' } })).isError, true);
  assert.equal(f.adb.writes.length, actions.length);
  await f.phone.call('phone_list_apps', {}); await f.phone.call('phone_list_apps', {});
  assert.equal(f.adb.calls.filter(c => c.includes('query-activities')).length, 1);
  await f.phone.call('phone_list_apps', { refresh: true });
  assert.equal(f.adb.calls.filter(c => c.includes('query-activities')).length, 2);
});

test('maintenance command holds device mutex; lease rejects wrappers and pause blocks command execution', async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const running = f.phone.maintenanceCommand(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return 42; });
  await ready;
  assert.equal(data(await new PhoneService(f.config, f.adb).call('phone_acquire_control', {})).error, 'PHONE_BUSY_OR_ABANDONED_LOCK');
  release(); assert.equal(await running, 42);
  await f.acquire(); let executed = false;
  await assert.rejects(f.phone.maintenanceCommand(async () => { executed = true; })); assert.equal(executed, false);
});

test('real stdio preserves all original tools when disabled and only adds nine when opted in', async t => {
  const f = await fixture(t), configPath = join(f.dir, 'workspaces.json');
  await writeFile(configPath, '[]');
  const connect = async () => {
    const client = new Client({ name: 'stdio-optin-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/src/mcp-stdio.js'), configPath], stderr: 'pipe' }));
    return client;
  };
  const first = await connect(); const baseline = (await first.listTools()).tools; const instructions = first.getInstructions(); await first.close();
  await writeFile(configPath + '.phone.json', '{"enabled":false}');
  const disabled = await connect(); assert.deepEqual((await disabled.listTools()).tools, baseline); assert.equal(disabled.getInstructions(), instructions); await disabled.close();
  // node is a harmless stand-in executable; no ADB/phone call is made in this discovery test.
  await writeFile(configPath + '.phone.json', JSON.stringify(f.config));
  const enabled = await connect();
  try {
    const all = (await enabled.listTools()).tools;
    assert.equal(all.length, baseline.length + 9);
    assert.deepEqual(all.filter(t => !Object.hasOwn(phoneSchemas, t.name)), baseline);
    assert.match(enabled.getInstructions()!, /maintenance authority/);
  } finally { await enabled.close(); }
});

test('high entropy original PNG is resized below the tunnel budget without changing physical coordinates', async t => {
  const f = await fixture(t);
  f.adb.png = await sharp(randomBytes(1080 * 2400 * 3), { raw: { width: 1080, height: 2400, channels: 3 } }).png().toBuffer();
  const result = await f.phone.call('phone_observe', {});
  assert.equal(result.isError, undefined);
  const frame = data(result); assert.equal(frame.width, 1080); assert.equal(frame.height, 2400);
  const image = result.content.find(c => c.type === 'image'); assert.ok(image && image.type === 'image');
  assert.ok(Buffer.from(image.data, 'base64').length <= 3 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10 * 1024 * 1024);
  assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).height, 1280);
});

test('real child process writes pending receipt then crashes: retry reports unknown and never dispatches', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  const args = { lease_id, frame_id, request_id: 'process-crash-00001', action: { type: 'tap', x: 10, y: 20 } };
  const serviceUrl = new URL('../../src/phone/service.js', import.meta.url).href;
  const childCode = `import {PhoneService} from ${JSON.stringify(serviceUrl)};
    const config=JSON.parse(process.argv[1]), args=JSON.parse(process.argv[2]), png=Buffer.from(process.argv[3],'base64');
    const adb={async run(a){const s=a.join(' ');if(s.includes('dumpsys window'))return Buffer.from('mCurrentFocus=Window{aa u0 com.example.app/.Main}\\nmRotation=0\\nPhysical size: 1080x2400');if(s.includes('screencap'))return png;if(s.includes('input tap'))process.exit(19);throw Error('unexpected');}};
    await new PhoneService(config,adb).call('phone_input',args);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify(f.config), JSON.stringify(args), f.adb.png.toString('base64')], { windowsHide: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit'); assert.equal(code, 19);
  assert.equal(data(await f.phone.call('phone_input', args)).status, 'outcome_unknown');
  assert.equal(f.adb.writes.length, 0);
  await administerPhone(f.phone.store, 'pause'); await administerPhone(f.phone.store, 'recover-lock', true);
});

test('ADB runner pins executable and serial, bounds resources, hides Windows process and redacts subprocess failure', async t => {
  const f = await fixture(t);
  const adb = new RealAdb(f.config, (executable, args, options, callback) => {
    assert.equal(executable, f.config.adb_path);
    assert.deepEqual(args.slice(0, 2), ['-s', f.config.serial]);
    assert.equal(options.timeout, 8000); assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    assert.equal(options.windowsHide, true); assert.equal(options.env?.ADB_SERVER_SOCKET, 'tcp:localhost:5037');
    callback(new Error('sensitive stderr and command arguments'), Buffer.alloc(0), Buffer.from('private'));
  });
  await assert.rejects(adb.run(['exec-out', 'screencap', '-p']), /^Error: ADB_FAILED_OR_TIMEOUT$/);
});

test('MCP host command entry point enforces the phone guard and remains available after release', async t => {
  const f = await fixture(t), policyPath = join(f.dir, 'host-policy.json');
  await writeFile(policyPath, JSON.stringify({ version: 1, enabled: true, read_roots: [f.dir], write_roots: [f.dir], command_roots: [f.dir], commands_enabled: true }));
  const policy = await HostPolicy.load(policyPath);
  const server = new McpServer({ name: 'host-phone', version: '1' });
  registerHostTools(server, policy, { withCommand: operation => f.phone.maintenanceCommand(operation) });
  const client = new Client({ name: 'test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const lease_id = await f.acquire();
  const args = { executable: process.execPath, args: ['-e', 'process.stdout.write("maintenance-ok")'], cwd: f.dir };
  const blocked = await client.callTool({ name: 'run_host_command', arguments: args }) as CallToolResult;
  assert.equal(data(blocked).error.code, 'PHONE_MAINTENANCE_COMMAND_BLOCKED');
  await f.phone.call('phone_release_control', { lease_id });
  const allowed = await client.callTool({ name: 'run_host_command', arguments: args }) as CallToolResult;
  assert.equal(data(allowed).stdout, 'maintenance-ok');
});
