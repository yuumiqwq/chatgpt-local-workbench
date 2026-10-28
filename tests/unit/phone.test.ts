import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { PhoneDrag } from '../../src/phone/drag.js';

class FakeAdb implements Adb {
  calls: string[][] = [];
  state = 'device'; rotation = 0; package = 'com.example.app'; fail = false; uiFail = false; failAfterWrite = false;
  png!: Buffer;
  wakefulness = 'Awake';
  panelMode = 'On';
  activity = '.Main';
  windowId = 'aa';
  inputConnection = 'abc';
  selectedIme = 'org.workbench.ime/.WorkbenchIme';
  imeInstalled = true;
  imeEnabled = true;
  imeSelectionFails = false;
  uiXml = '<?xml version="1.0"?><hierarchy><node text="untrusted"/></hierarchy>';
  transientAfterWrite = 0;
  wrote = false;
  async run(args: string[]) {
    this.calls.push(args);
    return this.execute(args);
  }
  private async execute(args: string[]): Promise<Buffer> {
    if (this.fail) throw new Error('ADB_FAILED_OR_TIMEOUT');
    if (args[0] === 'devices') return Buffer.from(`List of devices attached\nAYCVVB2B09005827\t${this.state}\n`);
    if (this.state !== 'device') throw new Error('ADB_FAILED_OR_TIMEOUT');
    const s = args.join(' ');
    if (args[0] === 'shell' && args.length === 2 && args[1]!.includes(';')) {
      const output: Buffer[] = [];
      for (const command of args[1]!.split(';')) output.push(await this.execute(['shell', ...command.trim().split(' ')]), Buffer.from('\n'));
      return Buffer.concat(output);
    }
    if (args[0] === 'shell' && args[1] === 'echo') return Buffer.from(args.slice(2).join(' '));
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
    if (s.includes('default_input_method')) return Buffer.from(this.selectedIme);
    if (s.includes('enabled_input_methods')) return Buffer.from(this.imeEnabled ? 'org.workbench.ime/.WorkbenchIme' : 'com.example.keyboard/.Ime');
    if (s === 'shell ime list -a -s') return Buffer.from(this.imeInstalled ? 'com.example.keyboard/.Ime\norg.workbench.ime/.WorkbenchIme\n' : 'com.example.keyboard/.Ime\n');
    if (s === 'shell ime enable org.workbench.ime/.WorkbenchIme') { this.imeEnabled = true; return Buffer.from('enabled'); }
    if (s === 'shell ime set org.workbench.ime/.WorkbenchIme') {
      if (!this.imeSelectionFails) this.selectedIme = 'org.workbench.ime/.WorkbenchIme';
      return Buffer.from('selected');
    }
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

test('focus and text can defer page observation until the final keyboard action', async t => {
  const f=await fixture(t), lease_id=await f.acquire(), frame_id=await f.observe();
  f.adb.calls=[];
  const focused=await f.phone.call('phone_input',{lease_id,frame_id,request_id:'context-focus-00001',
    action:{type:'tap',x:100,y:200},observation:'context'});
  let frame=data(focused);
  assert.equal(focused.content.length,1);
  assert.equal(frame.observation.mode,'context');
  assert.equal(frame.observation.input_ready,true);
  assert.equal(frame.ui.status,'not_requested');
  assert.equal(frame.result.timing.total_ms>=frame.result.timing.observation_ms,true);
  const args={lease_id,frame_id:frame.frame_id,request_id:'context-text-000001',
    action:{type:'text',text:'茉莉花茶',mode:'replace'},observation:'context'};
  frame=data(await f.phone.call('phone_input',args));
  assert.equal(frame.result.status,'completed');
  assert.equal(f.adb.calls.some(a=>a.includes('screencap')||a.includes('uiautomator')),false);
  assert.equal(data(await f.phone.call('phone_input',args)).replayed,true);
  assert.equal(f.adb.writes.length,2);
  const result=await f.phone.call('phone_input',{lease_id,frame_id:frame.frame_id,request_id:'context-enter-00001',
    action:{type:'key',key:'ENTER'},observation:'image'});
  assert.equal(data(result).observation.mode,'image');
  assert.equal(result.content[1]?.type,'image');
  assert.equal(f.adb.calls.filter(a=>a.includes('screencap')).length,1);
  assert.equal(f.adb.writes.length,3);
});

test('context-only frames permit known coordinates but never invent semantic targets',async t=>{
  const f=await fixture(t),lease_id=await f.acquire();
  const frame=data(await f.phone.call('phone_input',{lease_id,frame_id:await f.observe(),request_id:'context-key-000001',
    action:{type:'key',key:'BACK'},observation:'context'}));
  const args={lease_id,frame_id:frame.frame_id,request_id:'context-point-00001',action:{type:'tap',x:200,y:300}};
  assert.equal(data(await f.phone.call('phone_input',{...args,action:{type:'tap_element',element_id:'a'.repeat(64)}})).error,'PHONE_UI_TARGET_UNKNOWN_OR_AMBIGUOUS');
  assert.equal(f.adb.writes.length,1);
  assert.equal(data(await f.phone.call('phone_input',args)).result.status,'completed');
  const screenshots=f.adb.calls.filter(a=>a.includes('screencap')).length;
  const context=data(await f.phone.call('phone_observe',{ui:false,image:false}));
  assert.equal(context.observation.mode,'context');
  assert.equal(f.adb.calls.filter(a=>a.includes('screencap')).length,screenshots);
});

test('deferred observation retains focus freshness and rejects contradictory waits before dispatch',async t=>{
  const f=await fixture(t),lease_id=await f.acquire(),frame_id=await f.observe();
  const args={lease_id,frame_id,request_id:'context-invalid-001',action:{type:'tap',x:100,y:200},observation:'context'};
  assert.equal(data(await f.phone.call('phone_input',{...args,wait_for:{selector:{text:'ready'}}})).error,'PHONE_CONTEXT_WAIT_UNSUPPORTED');
  assert.equal(f.adb.writes.length,0);
  const frame=data(await f.phone.call('phone_input',args));
  f.adb.inputConnection='other';
  const textArgs={lease_id,frame_id:frame.frame_id,request_id:'context-stale-text1',
    action:{type:'text',text:'test',mode:'replace'},observation:'context'};
  assert.equal(data(await f.phone.call('phone_input',textArgs)).error,'PHONE_UI_TEXT_FOCUS_CHANGED');
  f.tick(11000);
  assert.equal(data(await f.phone.call('phone_input',{...textArgs,request_id:'context-stale-text2'})).error,'PHONE_FRAME_EXPIRED');
  assert.equal(f.adb.writes.length,1);
});

test('failed context capture preserves unknown outcomes and never repeats dispatched input',async t=>{
  const f=await fixture(t),lease_id=await f.acquire(),frame_id=await f.observe();
  f.adb.failAfterWrite=true;
  const args={lease_id,frame_id,request_id:'context-unknown-001',action:{type:'tap',x:100,y:200},observation:'context'};
  assert.equal(data(await f.phone.call('phone_input',args)).status,'outcome_unknown');
  assert.equal(data(await f.phone.call('phone_input',args)).status,'outcome_unknown');
  assert.equal(f.adb.writes.length,1);
});

test('bundled context reads detect a window transition during IME inspection',async t=>{
  const f=await fixture(t), original=(f.adb as any).execute.bind(f.adb);
  (f.adb as any).execute=async(args:string[])=>{
    const result=await original(args);
    if(args.join(' ')==='shell dumpsys input_method')f.adb.windowId='new-window';
    return result;
  };
  assert.equal(data(await f.phone.call('phone_observe',{ui:false,image:false})).error,'PHONE_FRAME_CHANGED_DURING_CAPTURE');
  assert.equal(await f.phone.store.read('frame.json'),undefined);
});

test('bundled context reads preserve missing input connection and reject malformed output',async t=>{
  const f=await fixture(t), original=(f.adb as any).execute.bind(f.adb);
  (f.adb as any).execute=async(args:string[])=>args.join(' ')==='shell dumpsys input_method'
    ?Buffer.from('Service input_method unavailable'):original(args);
  const result=data(await f.phone.call('phone_observe',{ui:false,image:false}));
  assert.equal(result.observation.input_ready,false);
  const lease_id=await f.acquire();
  assert.equal(data(await f.phone.call('phone_input',{lease_id,frame_id:result.frame_id,request_id:'missing-ime-000001',
    action:{type:'text',text:'test',mode:'replace'},observation:'context'})).error,'PHONE_UI_TEXT_FOCUS_CHANGED');
  const run=f.adb.run.bind(f.adb);
  f.adb.run=async args=>Buffer.from((await run(args)).toString().replace('__WB_CONTEXT_INPUT__','truncated'));
  assert.equal(data(await f.phone.call('phone_observe',{ui:false,image:false})).error,'PHONE_DISPLAY_CONTEXT_UNKNOWN');
  assert.equal(f.adb.writes.length,0);
});

test('failed image encoding settles the in-flight context read before releasing the device lock',async t=>{
  const f=await fixture(t), original=f.adb.run.bind(f.adb);
  f.adb.png=f.adb.png.subarray(0,33);
  let started!:()=>void,finish!:()=>void;
  const reading=new Promise<void>(resolve=>{started=resolve;}),released=new Promise<void>(resolve=>{finish=resolve;});
  f.adb.run=async args=>{
    if(args.join(' ').includes('__WB_INPUT_CONTEXT__')){started();await released;}
    return original(args);
  };
  const pending=f.phone.call('phone_observe',{image:true,ui:false});
  await reading;
  try {
    assert.equal(data(await f.phone.call('phone_observe',{ui:false,image:false})).error,'PHONE_BUSY_OR_ABANDONED_LOCK');
  } finally { finish(); }
  assert.ok(data(await pending).error);
  assert.equal(await f.phone.store.read('frame.json'),undefined);
  assert.equal((await readdir(f.dir)).includes('operation.lock'),false);
});
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

test('continuous drag holds across observations, deduplicates moves and cancels on release', async t => {
  const f = await fixture(t), calls: string[] = [];
  const drag: PhoneDrag = { async start() { calls.push('down'); }, async move() { calls.push('move'); }, async end(cancel) { calls.push(cancel ? 'cancel' : 'up'); } };
  const phone = new PhoneService(f.config, f.adb, Date.now, undefined, undefined, drag);
  const lease_id = data(await phone.call('phone_acquire_control', {})).lease_id;
  let frame_id = data(await phone.call('phone_observe', { ui: false, image: true })).frame_id;
  const begin = await phone.call('phone_drag', { lease_id, request_id: 'held-start-0000001', phase: 'start', frame_id, x: 100, y: 300 });
  const drag_id = data(begin).result.drag.id;
  assert.equal(data(begin).result.drag.held, true); assert.equal(begin.content.filter(x => x.type === 'image').length, 1);
  frame_id = data(await phone.call('phone_observe', { ui: false, image: true })).frame_id;
  assert.deepEqual(calls, ['down']);
  const other = new PhoneService(f.config, f.adb);
  assert.equal(data(await other.call('phone_input', { lease_id, frame_id, request_id: 'held-conflict-0001', action: { type: 'tap', x: 50, y: 50 } })).error, 'PHONE_DRAG_ACTIVE');
  const move = { lease_id, request_id: 'held-move-00000001', phase: 'move', drag_id, x: 300, y: 300, observation: 'image' };
  assert.equal(data(await phone.call('phone_drag', move)).result.drag.held, true);
  assert.equal(data(await phone.call('phone_drag', move)).replayed, true);
  assert.deepEqual(calls, ['down', 'move']);
  await phone.call('phone_release_control', { lease_id });
  assert.deepEqual(calls, ['down', 'move', 'cancel']);
});

test('continuous drag lifts only on end and cancels if the active window changes', async t => {
  const f = await fixture(t), calls: string[] = [];
  const drag: PhoneDrag = { async start() { calls.push('down'); }, async move() { calls.push('move'); }, async end(cancel) { calls.push(cancel ? 'cancel' : 'up'); } };
  const phone = new PhoneService(f.config, f.adb, Date.now, undefined, undefined, drag);
  const lease_id = data(await phone.call('phone_acquire_control', {})).lease_id;
  for (const scenario of ['end', 'change'] as const) {
    const frame_id = data(await phone.call('phone_observe', { ui: false, image: true })).frame_id;
    const start = data(await phone.call('phone_drag', { lease_id, request_id: `held-${scenario}-start-01`, phase: 'start', frame_id, x: 100, y: 300 }));
    const drag_id = start.result.drag.id;
    if (scenario === 'end') {
      const end = data(await phone.call('phone_drag', { lease_id, request_id: 'held-finish-000001', phase: 'end', drag_id }));
      assert.equal(end.result.drag.held, false); assert.deepEqual(calls, ['down', 'up']);
    } else {
      f.adb.windowId = 'new-window';
      const result = data(await phone.call('phone_drag', { lease_id, request_id: 'held-changed-00001', phase: 'move', drag_id, x: 200, y: 300 }));
      assert.equal(result.error, 'PHONE_FRAME_CHANGED'); assert.deepEqual(calls, ['down', 'up', 'down', 'cancel']);
    }
  }
});

test('a failed drag observation cancels once and persists the cancelled outcome', async t => {
  const f = await fixture(t), calls: string[] = [];
  const drag: PhoneDrag = { async start() { calls.push('down'); f.adb.fail = true; }, async move() {}, async end(cancel) { calls.push(cancel ? 'cancel' : 'up'); } };
  const phone = new PhoneService(f.config, f.adb, Date.now, undefined, undefined, drag);
  const lease_id = data(await phone.call('phone_acquire_control', {})).lease_id;
  const frame_id = data(await phone.call('phone_observe', { ui: false, image: true })).frame_id;
  const args = { lease_id, frame_id, request_id: 'held-capture-failed-1', phase: 'start', x: 100, y: 300 };
  assert.equal(data(await phone.call('phone_drag', args)).error, 'ADB_FAILED_OR_TIMEOUT');
  const replay = data(await phone.call('phone_drag', args));
  assert.equal(replay.replayed, true); assert.equal(replay.result.status, 'cancelled');
  assert.equal(replay.result.drag.held, false); assert.deepEqual(calls, ['down', 'cancel']);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'drag.json'), 'utf8')), null);
});

test('local phone stdio exposes phone tools with context mode and no host task surface',async t=>{
  const f=await fixture(t),path=join(f.dir,'phone.json');
  await writeFile(path,JSON.stringify(f.config));
  const client=new Client({name:'local-phone-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,
    args:[fileURLToPath(new URL('../../src/phone/mcp-stdio.js',import.meta.url)),path],stderr:'pipe'});
  try {
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.map(tool=>tool.name).sort(),Object.keys(phoneSchemas).sort());
    const input=tools.find(tool=>tool.name==='phone_input')!;
    assert.ok(JSON.stringify(input.inputSchema).includes('context'));
    assert.equal(tools.some(tool=>tool.description?.includes('multi-product shopping')),false);
  } finally {await client.close();}
});
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
test('acquisition prepares the configured IME, respects a busy lease and recovers a later manual keyboard change', async t => {
  const f = await fixture(t);
  f.adb.selectedIme = 'com.example.keyboard/.Ime';
  f.adb.imeEnabled = false;
  const acquired = data(await f.phone.call('phone_acquire_control', {}));
  assert.deepEqual(acquired.text_input, { status: 'ready', changed: true });
  assert.equal(f.adb.imeEnabled, true);
  const frame_id = await f.observe();
  const input = data(await f.phone.call('phone_input', { lease_id: acquired.lease_id, frame_id,
    request_id: 'auto-ime-chinese-0001', action: {type:'text', text:'中文输入 😀', mode:'replace'} }));
  assert.equal(input.result.status, 'completed');
  f.adb.selectedIme = 'com.example.keyboard/.Ime';
  assert.equal(data(await f.phone.call('phone_acquire_control', {})).status, 'busy');
  assert.equal(f.adb.selectedIme, 'com.example.keyboard/.Ime');
  await f.phone.call('phone_release_control', {lease_id:acquired.lease_id});
  const next = data(await f.phone.call('phone_acquire_control', {}));
  assert.deepEqual(next.text_input, {status:'ready',changed:true});
  await f.phone.call('phone_release_control', {lease_id:next.lease_id});
  const sets = f.adb.calls.filter(c => c.join(' ') === 'shell ime set org.workbench.ime/.WorkbenchIme').length;
  assert.deepEqual(data(await f.phone.call('phone_acquire_control', {})).text_input, {status:'ready',changed:false});
  assert.equal(f.adb.calls.filter(c => c.join(' ') === 'shell ime set org.workbench.ime/.WorkbenchIme').length, sets);
});

test('IME opt-out, missing package and failed selection do not block non-text phone controls', async t => {
  for (const scenario of ['disabled', 'missing', 'selection_failed'] as const) {
    const f = await fixture(t);
    f.adb.selectedIme = 'com.example.keyboard/.Ime';
    if (scenario === 'disabled') f.config.ime_enabled = false;
    if (scenario === 'missing') f.adb.imeInstalled = false;
    if (scenario === 'selection_failed') f.adb.imeSelectionFails = true;
    const acquired = data(await f.phone.call('phone_acquire_control', {}));
    assert.ok(acquired.lease_id);
    assert.deepEqual(acquired.text_input, scenario === 'disabled' ? {status:'not_configured'} :
      {status:'unavailable',error:scenario === 'missing' ? 'PHONE_IME_NOT_INSTALLED' : 'PHONE_IME_SELECTION_UNCONFIRMED'});
    if (scenario === 'disabled') assert.equal(f.adb.calls.length, 0);
    if (scenario === 'missing') assert.ok(!f.adb.calls.some(c => c[1] === 'ime' && ['enable','set'].includes(c[2]!)));
    const frame_id = await f.observe();
    assert.equal(data(await f.phone.call('phone_input', {lease_id:acquired.lease_id, frame_id,
      request_id:'ime-failure-key-0001',action:{type:'key',key:'BACK'}})).result.status, 'completed');
  }
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
  for (const file of await readdir(f.dir, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) assert.ok(!(await readFile(join(file.parentPath, file.name), 'utf8')).includes('第二行'));
  }
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
  assert.equal(data(await run(frame, '4')).result.status, 'completed'); assert.equal(f.adb.writes.length, 1);
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
    assert.equal(result.result.input_validation, 'fresh_context');
  }
  assert.equal(f.adb.writes.length, 2);
  const frame = JSON.parse(await readFile(join(f.dir, 'frame.json'), 'utf8'));
  assert.equal(Object.hasOwn(frame, 'visual'), false);
  assert.equal(Object.hasOwn(frame, 'png'), false);
});

test('tap accepts animation at the target and takes no pre-action screenshot', async t => {
  const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
  f.adb.png = await changedRectangle(f.adb.png, 330, 510, 10, 10);
  const callsBefore = f.adb.calls.length;
  const result = data(await f.phone.call('phone_input', { lease_id, frame_id,
    request_id: 'target-moved-000001', action: { type: 'tap', x: 300, y: 500 } }));
  assert.equal(result.result.status, 'completed');
  assert.equal(f.adb.writes.length, 1);
  const calls = f.adb.calls.slice(callsBefore);
  assert.equal(calls.slice(0,calls.findIndex(c=>c.includes('tap'))).some(c=>c.includes('screencap')),false);
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
  assert.equal(result.result.input_validation, 'fresh_context');
  await f.phone.call('phone_input', args);
  assert.equal(f.adb.writes.length, 1);
  assert.deepEqual(f.adb.writes[0]!.slice(-7), ['input', 'swipe', '160', '1600', '680', '1600', '1100']);
});

test('swipe accepts animation along the path and near the destination', async t => {
  for (const [index, rectangle] of [[400, 1595, 10, 10], [700, 1620, 10, 10]].entries()) {
    const f = await fixture(t), lease_id = await f.acquire(), frame_id = await f.observe();
    f.adb.png = await changedRectangle(f.adb.png, rectangle[0]!, rectangle[1]!, rectangle[2]!, rectangle[3]!);
    const result = data(await f.phone.call('phone_input', { lease_id, frame_id, request_id: `changed-swipe-000${index}`,
      action: { type: 'swipe', x: 160, y: 1600, to_x: 680, to_y: 1600, duration_ms: 1100 } }));
    assert.equal(result.result.status, 'completed');
    assert.equal(f.adb.writes.length, 1);
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
  assert.equal(result.result.input_validation, 'fresh_context');
  assert.equal(Object.hasOwn(result, 'visual'), false);
  assert.equal(Object.hasOwn(result, 'window'), false);
});

test('legacy visual metadata is ignored by coordinate input', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, visual] of [undefined, { version: 1, tile_size: 48, hashes: [] }].entries()) {
    const frame_id = await f.observe();
    const file = join(f.dir, 'frame.json'), frame = JSON.parse(await readFile(file, 'utf8'));
    frame.visual = visual;
    await writeFile(file, JSON.stringify(frame));
    f.adb.png = await changedRectangle(f.adb.png, index * 100, 2000, 50, 50);
    assert.equal(data(await f.phone.call('phone_input', { lease_id, frame_id,
      request_id: `missing-signature${index}`, action: { type: 'tap', x: 300, y: 500 } })).result.status, 'completed');
  }
  assert.equal(f.adb.writes.length, 2);
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

test('real stdio preserves all original tools when disabled and adds the phone tool set when opted in', async t => {
  const f = await fixture(t), configPath = join(f.dir, 'workspaces.json');
  await writeFile(configPath, '[]');
  const connect = async () => {
    const client = new Client({ name: 'stdio-optin-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../src/mcp-stdio.js', import.meta.url)), configPath], stderr: 'pipe' }));
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
    assert.equal(all.length, baseline.length + Object.keys(phoneSchemas).length);
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

test('text confirms the active input connection without comparing field content', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); f.adb.uiXml = focusedEditorXml();
  const frame = data(await f.phone.call('phone_observe', { ui: true, image: false }));
  assert.equal(frame.ui.elements[0].focused, true);
  f.adb.png = await changedRectangle(f.adb.png, 0, 1200, 1080, 1000);
  const args = { lease_id, frame_id: frame.frame_id, request_id: 'semantic-text-0001', action: { type: 'text', text: '芒果干噎酸奶', mode: 'replace' } };
  const result = data(await new PhoneService(f.config, f.adb).call('phone_input', args));
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.input_validation, 'fresh_input_connection');
  await f.phone.call('phone_input', args);
  assert.equal(f.adb.writes.length, 1);
  const persisted = await readFile(join(f.dir, 'frame.json'), 'utf8');
  assert.equal(persisted.includes('已有内容'), false);
});

test('text tolerates field rendering changes while preserving input connection and window checks', async t => {
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
    if (index === 3) assert.equal(data(result).error,'PHONE_FRAME_CHANGED');
    else assert.equal(data(result).result.status,'completed');
  }
  assert.equal(f.adb.writes.length, 3);
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
  assert.equal(result.result.status, 'completed'); assert.equal(result.result.input_validation, 'observed_ui_target');
  assert.deepEqual(f.adb.writes[0], ['shell', 'input', 'tap', '200', '250']);
  const firstWrite = f.adb.calls.findIndex(c => c.includes('tap'));
  assert.equal(f.adb.calls.slice(0, firstWrite).some(c => c.includes('screencap')), false);
  // Initial and post-action observations; no duplicate target revalidation read.
  assert.equal(f.adb.calls.filter(c => c.includes('uiautomator')).length, 2);
});

test('semantic targets use observed coordinates without requiring the page to remain identical', async t => {
  const f = await fixture(t), lease_id = await f.acquire();
  for (const [index, xml] of [semanticXml('另一个按钮'), semanticXml('普通按钮', 'true', '[200,200][400,300]'), semanticXml('普通按钮', 'false'), 'ERROR'].entries()) {
    f.adb.uiXml = semanticXml();
    const frame = data(await f.phone.call('phone_observe', { ui: true, image: false }));
    f.adb.uiXml = xml;
    const result = await f.phone.call('phone_input', { lease_id, request_id: `semantic-reject-00${index}`, frame_id: frame.frame_id,
      action: { type: 'tap_element', element_id: frame.ui.elements[0].element_id } });
    assert.equal(data(result).result.status,'completed');
    assert.deepEqual(f.adb.writes.at(-1),['shell','input','tap','200','250']);
  }
  assert.equal(f.adb.writes.length, 4);
});

test('UI-only frames support coordinates, while element actions require an observed ID', async t => {
  const f = await fixture(t), lease_id = await f.acquire(); f.adb.uiXml = semanticXml();
  const ui = data(await f.phone.call('phone_observe', { ui: true, image: false }));
  assert.equal(data(await f.phone.call('phone_input', { lease_id, request_id: 'ui-coordinate-0001', frame_id: ui.frame_id,
    action: { type: 'tap', x: 200, y: 250 } })).result.status, 'completed');
  const frame_id = await f.observe();
  assert.equal(data(await f.phone.call('phone_input', { lease_id, request_id: 'image-element-0001', frame_id,
    action: { type: 'tap_element', element_id: ui.ui.elements[0].element_id } })).error, 'PHONE_UI_TARGET_UNKNOWN_OR_AMBIGUOUS');
  assert.equal(f.adb.writes.length, 1);
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

test('scroll avoids a floating banner once and reports actual displacement; a full cover never dispatches',async t=>{
  const f=await fixture(t),lease_id=await f.acquire();
  let offset=0,covered=false;
  const xml=()=>`<hierarchy><node package="com.example.app" enabled="true" bounds="[0,0][1080,2400]">
    <node package="com.example.app" enabled="true" scrollable="true" drawing-order="1" bounds="[0,500][1080,2200]">
    ${[1,2].map(i=>`<node package="com.example.app" enabled="true" class="TextView" text="商品 ${i}" bounds="[100,${800+i*150+offset}][500,${900+i*150+offset}]"/>`).join('')}
    </node><node package="com.example.app" enabled="true" clickable="true" drawing-order="2" bounds="${covered?'[0,0][1080,2400]':'[0,1800][1080,2200]'}"/></node></hierarchy>`;
  const gestures:TouchPlan[]=[];
  const automation:PhoneAutomation={ready:async()=>{},source:async()=>xml(),
    resolveScrollTarget:async()=>{throw Error('covered native bounds must not be used');},
    perform:async plan=>{gestures.push(plan);offset=-300;}};
  const phone=new PhoneService(f.config,f.adb,Date.now,undefined,automation);
  let frame=data(await phone.call('phone_observe',{ui:true,image:false}));
  const args={lease_id,frame_id:frame.frame_id,request_id:'scroll-overlay-once-001',
    action:{type:'scroll',x:800,y:2050,to_x:800,to_y:900,duration_ms:450}};
  const result=data(await phone.call('phone_input',args));
  assert.equal(result.result.touch.avoided_overlay,true);
  assert.deepEqual(result.result.scroll_observation,{status:'moved',displacement_px:-300});
  assert.ok(gestures[0]!.points.every(([x,y])=>x>=12 && x<1068 && y>=512 && y<1788));
  assert.equal(data(await phone.call('phone_input',args)).replayed,true);
  assert.equal(gestures.length,1);
  covered=true;
  frame=data(await phone.call('phone_observe',{ui:true,image:false}));
  assert.equal(data(await phone.call('phone_input',{...args,frame_id:frame.frame_id,request_id:'scroll-covered-001'})).error,'PHONE_SCROLL_AREA_OCCLUDED');
  assert.equal(gestures.length,1);
});
