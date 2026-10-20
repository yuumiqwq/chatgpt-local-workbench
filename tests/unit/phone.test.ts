import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
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
import { physicalPanelState } from '../../src/phone/panel.js';
import type { PhoneAutomation } from '../../src/phone/automation.js';
import type { TouchPlan } from '../../src/phone/gestures.js';
import { digest } from '../../src/phone/store.js';

class FakeAdb implements Adb {
  calls: string[][] = [];
  state = 'device'; rotation = 0; package = 'com.example.app'; fail = false; uiFail = false; failAfterWrite = false;
  png!: Buffer;
  wakefulness = 'Awake';
  panelMode = 'On';
  activity = '.Main';
  windowId = 'aa';
  inputConnection = 'abc';
  uiXml = '<?xml version="1.0"?><hierarchy><node text="untrusted"/></hierarchy>';
  transientAfterWrite = 0;
  wrote = false;
  async run(args: string[]) {
    this.calls.push(args);
    if (this.fail) throw new Error('ADB_FAILED_OR_TIMEOUT');
    if (args[0] === 'devices') return Buffer.from(`List of devices attached\nAYCVVB2B09005827\t${this.state}\n`);
    if (this.state !== 'device') throw new Error('ADB_FAILED_OR_TIMEOUT');
    const s = args.join(' ');
    if (s.includes('dumpsys window')) {
      if (this.wrote && this.transientAfterWrite-- > 0) return Buffer.from('mCurrentFocus=null');
      return Buffer.from(`mCurrentFocus=Window{${this.windowId} u0 ${this.package}/${this.activity}}\nmRotation=${this.rotation}\nPhysical size: 1080x2400`);
    }
    if (s.includes('screencap')) return this.png;
    if (s.includes('uiautomator')) return Buffer.from(this.uiFail ? 'ERROR' : this.uiXml);
    if (s.includes('dumpsys battery')) return Buffer.from('level: 82\nscale: 100\nstatus: 2\nUSB powered: true\ntemperature: 310');
    if (s.includes('dumpsys power')) return Buffer.from(`mWakefulness=${this.wakefulness}`);
    if (s.includes('dumpsys SurfaceFlinger')) return Buffer.from(`Display 123\n    connectionType=Internal\n    powerMode=${this.panelMode}\nVirtual Display 456\n    name="scrcpy"\n    powerMode=On\n`);
    if (s.includes('query-activities')) return Buffer.from('com.example.app/.Main\ncom.example.other/.Main\ncom.example.app/.Second');
    if (s.includes('resolve-activity')) return Buffer.from('com.example.app/.Main');
    if (s.includes('default_input_method')) return Buffer.from('org.workbench.ime/.WorkbenchIme');
    if (s.includes('dumpsys input_method')) return Buffer.from(`Input method service state for org.workbench.ime.WorkbenchIme@abc:\n  mStartedInputConnection=RemoteInputConnection{idHash=#${this.inputConnection}}\n  mInputStarted=true\n  mInputEditorInfo:\n    inputType=0x1\n    packageName=${this.package} autofillId=123 fieldId=1\n  mShowInputRequested=true`);
    if (s.includes('input ') || s.includes('am start') || s.includes('am broadcast')) {
      this.wrote = true;
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

test('physical panel status distinguishes the internal screen from the live virtual display', () => {
  assert.equal(physicalPanelState('Display 123\n    connectionType=Internal\n    powerMode=Off\nVirtual Display 456\n    powerMode=On\n'), 'off');
  assert.equal(physicalPanelState('Virtual Display 456\n    powerMode=Off\n'), 'unknown');
  assert.equal(physicalPanelState('Display 123\n    connectionType=Internal\n    powerMode=On\n'), 'on');
  assert.equal(physicalPanelState('Display 123\n    connectionType=Internal\n    powerMode=Doze\n'), 'unknown');
});

test('automatic wake closes the panel but preserves a screen manually lit while already awake', async t => {
  const f = await fixture(t); f.config.dark_on_wake = true;
  let offCalls = 0;
  const phone = new PhoneService(f.config, f.adb, Date.now, { async turnOff() { offCalls++; f.adb.panelMode = 'Off'; } });
  const lease_id = await f.acquire();
  const call = (request_id: string, name: 'phone_display' | 'phone_recover' = 'phone_display') => phone.call(name, {lease_id,request_id,action:'wake'});
  f.adb.wakefulness = 'Dozing';
  const sleeping = data(await call('dark-wake-test-0001'));
  assert.equal(sleeping.result.status, 'completed');
  assert.equal(sleeping.result.physical_panel_state, 'off');
  assert.equal(offCalls, 1);
  f.adb.wakefulness = 'Awake'; f.adb.panelMode = 'On';
  assert.equal(data(await call('manual-wake-test-01')).result.status, 'completed');
  assert.equal(f.adb.panelMode, 'On'); assert.equal(offCalls, 1);
  f.adb.wakefulness = 'Asleep';
  assert.equal(data(await call('recovery-wake-test1', 'phone_recover')).result.physical_panel_state, 'off');
  assert.equal(offCalls, 2);
});

test('panel-off requires verified physical state and never repeats an uncertain request', async t => {
  const f = await fixture(t); let calls = 0;
  const phone = new PhoneService(f.config, f.adb, Date.now, { async turnOff() { calls++; } });
  const lease_id = await f.acquire();
  const args = {lease_id,request_id:'panel-unknown-test1',action:'physical_off'};
  assert.equal(data(await phone.call('phone_display',args)).status, 'outcome_unknown');
  assert.equal(data(await phone.call('phone_display',args)).status, 'outcome_unknown');
  assert.equal(calls, 1);
  assert.equal(f.adb.writes.length, 0);
  f.adb.panelMode = 'Off';
  const completed = data(await phone.call('phone_display',{...args,request_id:'panel-success-test1'}));
  assert.equal(completed.result.physical_panel_state, 'off');
  assert.equal(completed.result.status, 'completed');
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

async function changedRectangle(png: Buffer, left: number, top: number, width: number, height: number) {
  const input = await sharp({ create: { width, height, channels: 3, background: '#1248ad' } }).png().toBuffer();
  return sharp(png).composite([{ input, left, top }]).png().toBuffer();
}

test('tap and long press allow a changing remote banner, including across service instances', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, type] of ['tap', 'long_press'].entries()) {
    const frame_id = await f.observe();
    f.adb.png = await changedRectangle(f.adb.png, 0, 900 + index * 800, 1080, 700);
    const result = data(await new PhoneService(f.config, f.adb).call('phone_input', {
      lease_id, frame_id, request_id: `animated-banner-00${index}`, action: { type, x: 300, y: 500 }
    }));
    assert.equal(result.result.status, 'completed');
    assert.equal(result.result.input_validation, 'stable_target_region');
  }
  assert.equal(f.adb.writes.length, 2);
  const frame = JSON.parse(await readFile(join(f.dir, 'frame.json'), 'utf8'));
  assert.ok(frame.visual.hashes.every((hash: string) => /^[a-f0-9]{64}$/.test(hash)));
  assert.equal(Object.hasOwn(frame, 'png'), false);
});

test('tap rejects a moving or covered target even when almost all pixels are unchanged', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  f.adb.png = await changedRectangle(f.adb.png, 330, 510, 10, 10);
  const result = data(await f.phone.call('phone_input', { lease_id, frame_id,
    request_id: 'target-moved-000001', action: { type: 'tap', x: 300, y: 500 } }));
  assert.equal(result.error, 'PHONE_FRAME_CHANGED');
  assert.equal(f.adb.writes.length, 0);
});

test('large unrelated pixel changes do not block a stable coordinate target', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  f.adb.png = await changedRectangle(f.adb.png, 0, 1000, 1080, 1400);
  assert.equal(data(await f.phone.call('phone_input', { lease_id, frame_id,
    request_id: 'page-changed-000001', action: { type: 'tap', x: 300, y: 500 } })).result.status, 'completed');
  assert.equal(f.adb.writes.length, 1);
});

test('same-package activity and focused window changes reject identical images', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, field] of ['activity', 'windowId'].entries()) {
    const frame_id = await f.observe();
    if (field === 'activity') f.adb.activity = '.Different'; else f.adb.windowId = 'bb';
    assert.equal(data(await f.phone.call('phone_input', { lease_id, frame_id,
      request_id: `focus-changed-0000${index}`, action: { type: 'tap', x: 300, y: 500 } })).error, 'PHONE_FRAME_CHANGED');
  }
  assert.equal(f.adb.writes.length, 0);
});

test('text and keys tolerate animation while validating the relevant context', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  const actions = [{ type: 'text', text: 'example', mode: 'append' }, { type: 'key', key: 'ENTER' }];
  for (const [index, action] of actions.entries()) {
    const frame_id = await f.observe();
    f.adb.png = await changedRectangle(f.adb.png, index * 100, 2000, 50, 50);
    const result = data(await f.phone.call('phone_input', { lease_id, frame_id,
      request_id: `strict-action-0000${index}`, action }));
    assert.equal(result.result.status, 'completed');
    assert.equal(result.result.input_validation, index === 0 ? 'fresh_input_connection' : 'fresh_context');
  }
  assert.equal(f.adb.writes.length, 2);
});

test('text refuses an IME input connection changed since observation', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  f.adb.inputConnection = 'def';
  assert.equal(data(await f.phone.call('phone_input', {lease_id,frame_id,request_id:'changed-editor-001',
    action:{type:'text',text:'test',mode:'replace'}})).error, 'PHONE_UI_TEXT_FOCUS_CHANGED');
  assert.equal(f.adb.writes.length, 0);
});

test('ordinary scroll accepts UI-only frames and animated contents but rejects changed windows', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); f.adb.uiXml = semanticXml();
  let frame = data(await f.phone.call('phone_observe',{ui:true,image:false}));
  f.adb.png = await changedRectangle(f.adb.png,0,0,1080,2400);
  const action = {type:'scroll',x:540,y:1600,to_x:540,to_y:600,duration_ms:500};
  assert.equal(data(await f.phone.call('phone_input',{lease_id,frame_id:frame.frame_id,request_id:'ordinary-scroll-01',action})).result.input_validation,'fresh_context');
  frame = data(await f.phone.call('phone_observe',{ui:true,image:false})); f.adb.windowId = 'other';
  assert.equal(data(await f.phone.call('phone_input',{lease_id,frame_id:frame.frame_id,request_id:'ordinary-scroll-02',action})).error,'PHONE_FRAME_CHANGED');
  assert.equal(f.adb.writes.length,1);
});

test('swipe permits unrelated banner animation and dispatches its original gesture once', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  f.adb.png = await changedRectangle(f.adb.png, 0, 1900, 1080, 250);
  const args = { lease_id, frame_id, request_id: 'animated-swipe-0001',
    action: { type: 'swipe', x: 160, y: 1600, to_x: 680, to_y: 1600, duration_ms: 1100 } };
  const result = data(await new PhoneService(f.config, f.adb).call('phone_input', args));
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.input_validation, 'stable_gesture_region');
  await f.phone.call('phone_input', args);
  assert.equal(f.adb.writes.length, 1);
  assert.deepEqual(f.adb.writes[0]!.slice(-7), ['input', 'swipe', '160', '1600', '680', '1600', '1100']);
});

test('swipe rejects changes along the path and near the destination', async t => {
  for (const [index, rectangle] of [[400, 1595, 10, 10], [700, 1620, 10, 10]].entries()) {
    const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
    f.adb.png = await changedRectangle(f.adb.png, rectangle[0]!, rectangle[1]!, rectangle[2]!, rectangle[3]!);
    const result = data(await f.phone.call('phone_input', { lease_id, frame_id, request_id: `changed-swipe-000${index}`,
      action: { type: 'swipe', x: 160, y: 1600, to_x: 680, to_y: 1600, duration_ms: 1100 } }));
    assert.equal(result.error, 'PHONE_FRAME_CHANGED');
    assert.equal(f.adb.writes.length, 0);
  }
});

test('identical pixels with different PNG encoding pass and do not expose visual signatures', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  const original = f.adb.png;
  f.adb.png = await sharp(original).png({ compressionLevel: 0 }).toBuffer();
  assert.notDeepEqual(f.adb.png, original);
  const result = data(await f.phone.call('phone_input', { lease_id, frame_id,
    request_id: 'png-encoding-000001', action: { type: 'tap', x: 300, y: 500 } }));
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.input_validation, 'stable_target_region');
  assert.equal(Object.hasOwn(result, 'visual'), false);
  assert.equal(Object.hasOwn(result, 'window'), false);
});

test('missing or malformed comparison metadata cannot relax a changed frame', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, visual] of [undefined, { version: 1, tile_size: 48, hashes: [] }].entries()) {
    const frame_id = await f.observe();
    const file = join(f.dir, 'frame.json'), frame = JSON.parse(await readFile(file, 'utf8'));
    frame.visual = visual;
    await writeFile(file, JSON.stringify(frame));
    f.adb.png = await changedRectangle(f.adb.png, index * 100, 2000, 50, 50);
    assert.match(data(await f.phone.call('phone_input', { lease_id, frame_id,
      request_id: `missing-signature${index}`, action: { type: 'tap', x: 300, y: 500 } })).error, /PHONE_(FRAME_CHANGED|IMAGE_OBSERVATION_REQUIRED)/);
  }
  assert.equal(f.adb.writes.length, 0);
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

const semanticXml = (label = '普通按钮', enabled = 'true', position = '[100,200][300,300]') => `<?xml version="1.0"?><hierarchy rotation="0"><node package="com.example.app" class="Layout" enabled="true" bounds="[0,0][1080,2400]" clickable="false"><node package="com.example.app" class="Button" text="${label}" resource-id="app:id/button" enabled="${enabled}" clickable="true" bounds="${position}"/></node></hierarchy>`;

const focusedEditorXml = () => semanticXml('已有内容').replace('class="Button"', 'class="android.widget.EditText" focused="true"');

test('text revalidates the focused editable field with no screenshot despite animated pixels', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); f.adb.uiXml = focusedEditorXml();
  const frame = data(await f.phone.call('phone_observe', { ui: true, image: false }));
  assert.equal(frame.ui.elements[0].focused, true);
  f.adb.png = await changedRectangle(f.adb.png, 0, 1200, 1080, 1000);
  const args = { lease_id, frame_id: frame.frame_id, request_id: 'semantic-text-0001', action: { type: 'text', text: '芒果干噎酸奶', mode: 'replace' } };
  const result = data(await new PhoneService(f.config, f.adb).call('phone_input', args));
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.input_validation, 'fresh_ui_text_target');
  await f.phone.call('phone_input', args);
  assert.equal(f.adb.writes.length, 1);
  const persisted = await readFile(join(f.dir, 'frame.json'), 'utf8');
  assert.equal(persisted.includes('已有内容'), false);
});

test('text rejects focus loss, replaced fields, moved fields and window changes before dispatch', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, mutate] of [
    () => { f.adb.uiXml = f.adb.uiXml.replace('focused="true"', 'focused="false"'); },
    () => { f.adb.uiXml = f.adb.uiXml.replace('app:id/button', 'app:id/other'); },
    () => { f.adb.uiXml = f.adb.uiXml.replace('[100,200][300,300]', '[200,200][400,300]'); },
    () => { f.adb.windowId = 'other'; }
  ].entries()) {
    f.adb.uiXml = focusedEditorXml();
    const frame = data(await f.phone.call('phone_observe', { ui: true, image: false })); mutate();
    const result = await f.phone.call('phone_input', { lease_id, frame_id: frame.frame_id, request_id: `semantic-text-fail${index}`,
      action: { type: 'text', text: 'test', mode: 'replace' } });
    assert.equal(result.isError, true);
  }
  assert.equal(f.adb.writes.length, 0);
});

test('semantic observation uses no screenshot and fresh target click survives unrelated pixel changes across processes', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); f.adb.uiXml = semanticXml();
  const observed = await f.phone.call('phone_observe', { ui: true, image: false }), frame = data(observed);
  assert.equal(observed.content.length, 1); assert.equal(frame.rendered, null);
  assert.equal(f.adb.calls.some(c => c.includes('screencap')), false);
  assert.equal(frame.ui.elements[0].text, '普通按钮');
  const persisted = await readFile(join(f.dir, 'frame.json'), 'utf8');
  assert.ok(!persisted.includes('普通按钮') && !persisted.includes('app:id/button'));
  f.adb.png = await changedRectangle(f.adb.png, 0, 1200, 1080, 1000);
  const result = data(await new PhoneService(f.config, f.adb).call('phone_input', { lease_id,
    request_id: 'semantic-cross-0001', frame_id: frame.frame_id, action: { type: 'tap_element', element_id: frame.ui.elements[0].element_id } }));
  assert.equal(result.result.status, 'completed'); assert.equal(result.result.input_validation, 'fresh_ui_target');
  assert.deepEqual(f.adb.writes[0], ['shell', 'input', 'tap', '200', '250']);
  const firstWrite = f.adb.calls.findIndex(c => c.includes('tap'));
  assert.equal(f.adb.calls.slice(0, firstWrite).some(c => c.includes('screencap')), false);
  // Initial observation, target revalidation, and automatic post-action observation.
  assert.equal(f.adb.calls.filter(c => c.includes('uiautomator')).length, 3);
});

test('semantic target rename, movement, disablement and missing UI cannot dispatch', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, xml] of [semanticXml('另一个按钮'), semanticXml('普通按钮', 'true', '[200,200][400,300]'), semanticXml('普通按钮', 'false'), 'ERROR'].entries()) {
    f.adb.uiXml = semanticXml();
    const frame = data(await f.phone.call('phone_observe', { ui: true, image: false }));
    f.adb.uiXml = xml;
    const result = await f.phone.call('phone_input', { lease_id, request_id: `semantic-reject-00${index}`, frame_id: frame.frame_id,
      action: { type: 'tap_element', element_id: frame.ui.elements[0].element_id } });
    assert.equal(result.isError, true);
  }
  assert.equal(f.adb.writes.length, 0);
});

test('UI-only frames cannot authorize coordinate actions and image-only frames cannot authorize element actions', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); f.adb.uiXml = semanticXml();
  const ui = data(await f.phone.call('phone_observe', { ui: true, image: false }));
  assert.equal(data(await f.phone.call('phone_input', { lease_id, request_id: 'ui-coordinate-0001', frame_id: ui.frame_id,
    action: { type: 'tap', x: 200, y: 250 } })).error, 'PHONE_IMAGE_OBSERVATION_REQUIRED');
  const frame_id = await f.observe();
  assert.equal(data(await f.phone.call('phone_input', { lease_id, request_id: 'image-element-0001', frame_id,
    action: { type: 'tap_element', element_id: ui.ui.elements[0].element_id } })).error, 'PHONE_UI_OBSERVATION_REQUIRED');
  assert.equal(f.adb.writes.length, 0);
});

test('navigation observation retries read-only on transient missing focus without replaying the click', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  f.adb.transientAfterWrite = 2;
  const args = {lease_id, frame_id, request_id:'transition-test-001', action:{type:'tap',x:100,y:100}};
  const result = data(await f.phone.call('phone_input', args));
  assert.equal(result.result.status, 'completed'); assert.equal(result.result.observation_attempts, 3);
  assert.equal(f.adb.writes.length, 1);
  assert.equal(data(await f.phone.call('phone_input', args)).replayed, true);
  assert.equal(f.adb.writes.length, 1);
});

test('persistent missing focus remains unknown after bounded observation retries', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe(); f.adb.transientAfterWrite = 100;
  const result = data(await f.phone.call('phone_input', { lease_id, frame_id, request_id:'transition-fail-001', action:{type:'tap',x:100,y:100} }));
  assert.equal(result.status, 'outcome_unknown'); assert.equal(f.adb.writes.length, 1);
});

test('Appium semantic and coordinate gestures dispatch once without an additional ADB tap', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), gestures: TouchPlan[] = [];
  const automation: PhoneAutomation = { ready: async () => {}, source: async () => semanticXml(), perform: async plan => { gestures.push(plan); } };
  const phone = new PhoneService(f.config, f.adb, Date.now, undefined, automation);
  for (const type of ['tap_element', 'tap', 'swipe'] as const) {
    const frame = data(await phone.call('phone_observe', { ui: true, image: type !== 'tap_element' }));
    const action = type === 'tap_element' ? { type, element_id: frame.ui.elements[0].element_id }
      : type === 'tap' ? { type, x: 200, y: 250 } : { type, x: 200, y: 250, to_x: 200, to_y: 100, duration_ms: 300 };
    const args = { lease_id, frame_id: frame.frame_id, request_id: `appium-dispatch-${type}`, action };
    const result = data(await phone.call('phone_input', args));
    assert.equal(result.result.status, 'completed');
    assert.equal(result.result.touch.backend, 'appium_uiautomator2');
    assert.equal(data(await phone.call('phone_input', args)).replayed, true);
  }
  assert.equal(gestures.length, 3); assert.equal(f.adb.writes.length, 0);
  assert.equal(f.adb.calls.some(call => call.includes('uiautomator')), false);
});

test('condition wait reads until target appears, tolerates changing unrelated text and returns a fresh frame', async t => {
  const f = await fixture(t); let reads = 0;
  const automation: PhoneAutomation = { ready: async () => {}, perform: async () => { throw new Error('unexpected write'); },
    source: async () => {
      reads++;
      return semanticXml(reads > 1 ? 'Ready' : 'Loading').replace('</hierarchy>', `<node package="com.example.app" enabled="true" clickable="false" text="Ad ${reads}" bounds="[0,500][500,600]"/></hierarchy>`);
    } };
  const phone = new PhoneService(f.config, f.adb, Date.now, undefined, automation);
  const result = data(await phone.call('phone_observe', { image: false, wait_for: { selector: { text: 'Ready' }, state: 'enabled', timeout_ms: 2000, stable_ms: 100 } }));
  assert.equal(result.result.wait.status, 'matched'); assert.ok(reads >= 3);
  assert.equal(result.ui.elements[0].text, 'Ready'); assert.equal(result.rendered, null);
  assert.equal(f.adb.writes.length, 0);
});

test('post-action wait timeout reports the observation and never repeats the gesture', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); let dispatched = 0;
  const automation: PhoneAutomation = { ready: async () => {}, source: async () => semanticXml(), perform: async () => { dispatched++; } };
  const phone = new PhoneService(f.config, f.adb, Date.now, undefined, automation);
  const frame = data(await phone.call('phone_observe', { ui: true, image: false }));
  const args = { lease_id, frame_id: frame.frame_id, request_id: 'appium-wait-timeout-01', action: { type: 'tap_element', element_id: frame.ui.elements[0].element_id },
    wait_for: { selector: { text: 'Missing' }, timeout_ms: 100, stable_ms: 0 } };
  const result = data(await phone.call('phone_input', args));
  assert.equal(result.result.wait.status, 'timeout'); assert.equal(result.result.request_sent, true);
  assert.equal(data(await phone.call('phone_input', args)).replayed, true); assert.equal(dispatched, 1);
});

test('ordinary scroll resolves nested lists and reports driver feedback with one dispatch', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), plans: TouchPlan[] = [];
  const automation: PhoneAutomation = { ready: async () => {},
    source: async () => '<hierarchy><node package="com.example.app" enabled="true" scrollable="true" bounds="[0,300][1080,2400]"><node package="com.example.app" enabled="true" scrollable="true" bounds="[0,600][1080,2400]"/></node></hierarchy>',
    resolveScrollTarget: async xpath => { assert.equal(xpath,'/hierarchy/node[1]/node[1]'); return 'inner-list'; },
    perform: async plan => { plans.push(plan); return {can_scroll_more:true}; }
  };
  const phone = new PhoneService(f.config,f.adb,Date.now,undefined,automation);
  const frame = data(await phone.call('phone_observe', {ui:true,image:false}));
  const args = {lease_id,frame_id:frame.frame_id,request_id:'native-scroll-dispatch-01',
    action:{type:'scroll',x:790,y:1900,to_x:790,to_y:700,duration_ms:450}};
  const result = data(await phone.call('phone_input',args));
  assert.equal(result.result.status,'completed');
  assert.equal(result.result.input_validation,'fresh_context');
  assert.equal(result.result.touch.method,'scrollGesture');
  assert.equal(result.result.touch.can_scroll_more,true);
  assert.equal(plans[0]!.scroll!.elementId,'inner-list');
  assert.equal(data(await phone.call('phone_input',args)).replayed,true);
  assert.equal(plans.length,1); assert.equal(f.adb.writes.length,0);
});

test('ordinary scroll retains touch fallback for absent or unreadable UI and rejects a window race', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), plans: TouchPlan[] = [];
  let source = '<hierarchy></hierarchy>', race = false;
  const automation: PhoneAutomation = {ready:async()=>{},resolveScrollTarget:async()=>undefined,
    source:async()=>{ if(race) f.adb.windowId='new-window'; return source; },
    perform:async plan=>{plans.push(plan);}
  };
  const phone = new PhoneService(f.config,f.adb,Date.now,undefined,automation);
  for (const [index, xml] of ['<hierarchy></hierarchy>','malformed'].entries()) {
    source=xml;
    const frame=data(await phone.call('phone_observe',{}));
    const result=data(await phone.call('phone_input',{lease_id,frame_id:frame.frame_id,request_id:`fallback-scroll-request-${index}`,
      action:{type:'scroll',x:790,y:1900,to_x:790,to_y:700}}));
    assert.equal(result.result.touch.method,'pointer_actions');
    assert.equal(plans.at(-1)!.scroll,undefined);
  }
  const frame=data(await phone.call('phone_observe',{})); race=true;
  const result=data(await phone.call('phone_input',{lease_id,frame_id:frame.frame_id,request_id:'native-scroll-window-race',
    action:{type:'scroll',x:790,y:1900,to_x:790,to_y:700}}));
  assert.equal(result.error,'PHONE_FRAME_CHANGED_DURING_CAPTURE');
  assert.equal(plans.length,2); assert.equal(f.adb.writes.length,0);
});

const richXml=()=>semanticXml('打开商品详情', 'true', '[100,500][500,650]').replace('</hierarchy>',
  '<node package="com.example.app" enabled="true" class="android.widget.TextView" text="商品价格 25.90 元" bounds="[100,700][600,850]"/></hierarchy>');

test('automatic post-action observation returns useful controls without taking a screenshot',async t=>{
  const f=await fixture(t),lease_id=await f.acquire(); f.adb.uiXml=richXml();
  const frame=data(await f.phone.call('phone_observe',{ui:true,image:false}));
  const args={lease_id,frame_id:frame.frame_id,request_id:'auto-ui-result-0001',action:{type:'tap_element',element_id:frame.ui.elements[0].element_id}};
  const response=await f.phone.call('phone_input',args), result=data(response);
  assert.equal(result.result.status,'completed');
  assert.equal(result.observation.mode,'ui'); assert.equal(result.observation.reason,'ui_sufficient');
  assert.equal(response.content.length,1); assert.equal(result.rendered,null);
  assert.equal(result.ui.nodes.some((n:any)=>n.text==='商品价格 25.90 元'),true);
  assert.equal(f.adb.calls.filter(a=>a.includes('screencap')).length,0);
  assert.equal(data(await f.phone.call('phone_input',args)).replayed,true); assert.equal(f.adb.writes.length,1);
  const next=await f.phone.call('phone_input',{lease_id,frame_id:result.frame_id,request_id:'auto-ui-next-0001',
    action:{type:'tap_element',element_id:result.ui.elements[0].element_id}});
  assert.equal(data(next).result.status,'completed'); assert.equal(f.adb.calls.some(a=>a.includes('screencap')),false);
});

test('automatic post-action screenshot fallback handles sparse, visual and invalid UI without replay',async t=>{
  const f=await fixture(t),lease_id=await f.acquire();
  for(const [index,[xml,reason]] of [
    ['<hierarchy></hierarchy>','sparse_ui'],
    [richXml().replace('</hierarchy>','<node package="com.example.app" enabled="true" class="android.widget.ImageView" bounds="[0,1000][1080,2300]"/></hierarchy>'),'unlabelled_visual_region'],
    ['malformed','ui_unavailable']
  ].entries()){
    f.adb.uiXml=xml!;
    const frame=await f.observe(), before=f.adb.calls.filter(a=>a.includes('screencap')).length;
    const args={lease_id,frame_id:frame,request_id:`auto-fallback-case-${index}`,action:{type:'key',key:'BACK'}};
    const response=await f.phone.call('phone_input',args),result=data(response);
    assert.equal(result.result.status,'completed'); assert.equal(result.observation.reason,reason);
    assert.equal(response.content[1]?.type,'image');
    assert.equal(f.adb.calls.filter(a=>a.includes('screencap')).length-before,1);
    assert.equal(data(await f.phone.call('phone_input',args)).replayed,true);
  }
  assert.equal(f.adb.writes.length,3);
});

test('explicit observation modes and condition waits preserve caller choice',async t=>{
  const f=await fixture(t),lease_id=await f.acquire(); f.adb.uiXml=richXml();
  for(const [index,observation] of ['image','ui','auto'].entries()){
    const frame=data(await f.phone.call('phone_observe',{ui:true,image:false}));
    const before=f.adb.calls.filter(a=>a.includes('screencap')).length;
    const response=await f.phone.call('phone_input',{lease_id,frame_id:frame.frame_id,request_id:`observation-mode-${index}`,observation,
      action:{type:'key',key:'BACK'},wait_for:{selector:{text:'商品价格 25.90 元'},stable_ms:0,timeout_ms:100}});
    const result=data(response);
    assert.equal(result.result.wait.status,'matched');
    assert.equal(result.observation.mode,observation==='image'?'image':'ui');
    assert.equal(f.adb.calls.filter(a=>a.includes('screencap')).length-before,observation==='image'?1:0);
  }
});

test('adding the default observation mode preserves durable receipts written by older versions',async t=>{
  const f=await fixture(t),lease_id=await f.acquire();
  const args={lease_id,frame_id:await f.observe(),request_id:'pre-observation-upgrade',action:{type:'key',key:'BACK'}};
  const legacyArgs={...phoneSchemas.phone_input.parse(args),observation:undefined};
  const fingerprint=createHmac('sha256',lease_id).update(JSON.stringify({name:'phone_input',...legacyArgs,lease_id:undefined})).digest('hex');
  await f.phone.store.save(`request-${digest(args.request_id)}.json`,{fingerprint,lease_hash:digest(lease_id),state:'completed',result:{status:'completed'}});
  assert.equal(data(await f.phone.call('phone_input',args)).replayed,true);
  assert.equal(f.adb.writes.length,0);
});
