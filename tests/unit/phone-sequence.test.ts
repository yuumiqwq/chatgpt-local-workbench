import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHmac } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Adb } from '../../src/phone/adb.js';
import type { PhoneConfig } from '../../src/phone/config.js';
import { PhoneService, phoneSchemas } from '../../src/phone/service.js';
import { digest } from '../../src/phone/store.js';

const richUi = () => '<hierarchy><node package="com.example.app" enabled="true" clickable="true" resource-id="app:id/search" text="搜索商品" bounds="[100,100][600,250]"/>'
  + '<node package="com.example.app" enabled="true" text="商品搜索页面" bounds="[100,300][800,450]"/></hierarchy>';
const decode = (response: CallToolResult) => JSON.parse((response.content[0] as { text: string }).text);
class SequenceAdb implements Adb {
  calls: string[][] = [];
  writes: string[][] = [];
  inputConnection = 'first';
  remainingUnreadyReads = 0;
  unreadyAfterTap = 0;
  neverReady = false;
  window = 'window';
  ui = richUi();
  failed = false;
  failAfterWrite = 0;
  onWrite: (() => Promise<void>) | undefined;
  onIme: (() => void | Promise<void>) | undefined;
  constructor(readonly png: Buffer) {}
  async run(args: string[]): Promise<Buffer> {
    this.calls.push(args);
    if (this.failed) throw new Error('ADB_FAILED_OR_TIMEOUT');
    if (args[0] === 'shell' && args.length === 2 && args[1]!.includes(';')) {
      const output: Buffer[] = [];
      for (const command of args[1]!.split(';')) output.push(await this.run(['shell', ...command.trim().split(' ')]), Buffer.from('\n'));
      return Buffer.concat(output);
    }
    const command = args.join(' ');
    if (args[1] === 'echo') return Buffer.from(args.slice(2).join(' '));
    if (command.includes('dumpsys window')) return Buffer.from(`mCurrentFocus=Window{${this.window} u0 com.example.app/.Main}\nmRotation=0\nPhysical size: 1080x2400`);
    if (command.includes('dumpsys input_method')) {
      await this.onIme?.();
      if (this.neverReady || this.remainingUnreadyReads-- > 0) return Buffer.from('Input connection unavailable');
      return Buffer.from(`Input method service state for org.workbench.ime.WorkbenchIme@abc:\n  mStartedInputConnection=RemoteInputConnection{idHash=#${this.inputConnection}}\n  mInputStarted=true\n  mInputEditorInfo:\n    inputType=0x1\n    packageName=com.example.app autofillId=123 fieldId=1\n  mShowInputRequested=true`);
    }
    if (command.includes('default_input_method')) return Buffer.from('org.workbench.ime/.WorkbenchIme');
    if (command.includes('screencap')) return this.png;
    if (command.includes('uiautomator')) return Buffer.from(this.ui);
    if (/shell (input |am broadcast)/.test(command)) {
      this.writes.push(args);
      if (command.includes('input tap')) this.remainingUnreadyReads = this.unreadyAfterTap;
      if (this.failAfterWrite && this.writes.length >= this.failAfterWrite) this.failed = true;
      await this.onWrite?.();
      return Buffer.from('Broadcast completed: result=1');
    }
    return Buffer.from('');
  }
}
async function fixture(t: TestContext) {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'phone-sequence-test-'));
  t.after(async () => {
    const suffix = relative(root, resolve(dir));
    assert.ok(suffix && !suffix.startsWith('..') && !suffix.includes('..'));
    await rm(dir, { recursive: true, force: true });
  });
  const png = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#fff' } }).png().toBuffer();
  const adb = new SequenceAdb(png);
  const config: PhoneConfig = { enabled: true, hostname: 'test', adb_path: process.execPath, serial: 'test', state_dir: dir,
    lease_seconds: 60, frame_seconds: 30, ime_enabled: true };
  const phone = new PhoneService(config, adb);
  const lease_id = decode(await phone.call('phone_acquire_control', {})).lease_id as string;
  const frame = decode(await phone.call('phone_observe', { ui: true, image: false }));
  adb.calls = [];
  const args = { lease_id, frame_id: frame.frame_id as string, request_id: 'sequence-request-0001', observation: 'image', response_detail: 'full', steps: [
    { action: { type: 'tap', x: 200, y: 150 } },
    { action: { type: 'text', text: '茉莉花茶', mode: 'replace' } },
    { action: { type: 'key', key: 'ENTER' } }
  ] };
  return { dir, config, adb, phone, frame, args };
}

test('sequence waits for IME, executes supplied steps and returns only one final image', async t => {
  const f = await fixture(t); f.adb.unreadyAfterTap = 2;
  const response = await f.phone.call('phone_sequence', f.args), body = decode(response);
  assert.equal(body.result.status, 'completed');
  assert.equal(body.result.completed_steps, 3);
  assert.equal(body.result.steps[1].input_wait.status, 'matched');
  assert.ok(body.result.steps[1].input_wait.attempts >= 2);
  assert.equal(body.observation.mode, 'image');
  assert.equal(response.content.filter(c => c.type === 'image').length, 1);
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 1);
  assert.equal(f.adb.calls.filter(c => c.includes('uiautomator')).length, 0);
  assert.deepEqual(f.adb.writes.map(c => c.slice(1, 3).join(' ')), ['input tap', 'am broadcast', 'input keyevent']);
  assert.ok(body.result.steps.every((step: { elapsed_ms: number }) => step.elapsed_ms >= 0));
  const replay = decode(await new PhoneService(f.config, f.adb).call('phone_sequence', f.args));
  assert.equal(replay.replayed, true); assert.equal(replay.status, 'completed');
  assert.equal(f.adb.writes.length, 3);
  for (const file of (await readdir(f.dir)).filter(name => name.endsWith('.json'))) assert.ok(!(await readFile(join(f.dir, file), 'utf8')).includes('茉莉花茶'));
});

test('input readiness timeout stops before text and returns the current page', async t => {
  const f = await fixture(t); f.adb.neverReady = true;
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, input_ready_timeout_ms: 100 }));
  assert.equal(body.result.status, 'stopped'); assert.equal(body.result.completed_steps, 1);
  assert.equal(body.result.stopped_at, 1); assert.equal(body.result.error, 'PHONE_INPUT_READY_TIMEOUT');
  assert.equal(body.result.steps[1].request_sent, false);
  assert.equal(body.result.steps[1].input_wait.status, 'timeout');
  assert.equal(body.observation.input_ready, false); assert.equal(body.observation.mode, 'image');
  assert.equal(f.adb.writes.length, 1);
});

test('an existing input connection change is rejected without replacing its proof', async t => {
  const f = await fixture(t); f.adb.inputConnection = 'different';
  const args = { ...f.args, steps: f.args.steps.slice(1) };
  const body = decode(await f.phone.call('phone_sequence', args));
  assert.equal(body.result.error, 'PHONE_UI_TEXT_FOCUS_CHANGED');
  assert.equal(body.result.completed_steps, 0); assert.equal(f.adb.writes.length, 0);
  assert.equal(body.observation.mode, 'image');
});

test('text immediately following the sequence tap refreshes an unsettled connection before dispatch', async t => {
  for (const type of ['tap', 'tap_element'] as const) {
    const f = await fixture(t); let imeReads = 0;
    f.adb.onIme = () => { if (++imeReads >= 2) f.adb.inputConnection = 'new-editor'; };
    const action = type === 'tap' ? f.args.steps[0]!.action : { type, element_id: f.frame.ui.elements[0].element_id };
    const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [{ action }, ...f.args.steps.slice(1)] }));
    assert.equal(body.result.status, 'completed'); assert.equal(body.result.completed_steps, 3);
    assert.equal(body.result.steps[1].input_wait.attempts, 1);
    assert.equal(body.result.steps[1].input_wait.status, 'matched');
    assert.equal(f.adb.writes.length, 3);
    assert.equal(f.adb.writes.filter(c => c.includes('broadcast')).length, 1);
  }
});

test('the stable text fast path adds no readiness polls', async t => {
  const f = await fixture(t);
  const body = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(body.result.status, 'completed');
  assert.equal(body.result.steps[1].input_wait.attempts, 0);
  assert.equal(f.adb.writes.length, 3);
});

test('a connection race following a key instead of a tap still stops text', async t => {
  const f = await fixture(t); let imeReads = 0;
  f.adb.onIme = () => { if (++imeReads >= 2) f.adb.inputConnection = 'new-editor'; };
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [f.args.steps[2]!, f.args.steps[1]!] }));
  assert.equal(body.result.error, 'PHONE_UI_TEXT_FOCUS_CHANGED'); assert.equal(body.result.completed_steps, 1);
  assert.equal(f.adb.writes.length, 1);
});

test('repeated post-tap connection changes share one readiness deadline', async t => {
  const f = await fixture(t); let imeReads = 0;
  f.adb.onIme = () => { f.adb.inputConnection = `editor-${++imeReads}`; };
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, input_ready_timeout_ms: 100 }));
  assert.equal(body.result.status, 'stopped'); assert.equal(body.result.error, 'PHONE_INPUT_READY_TIMEOUT');
  assert.equal(body.result.steps[1].input_wait.status, 'timeout');
  assert.ok(body.result.steps[1].input_wait.elapsed_ms < 1000);
  assert.equal(f.adb.writes.length, 1);
});

test('post-tap connection refresh still rejects a concurrent window change', async t => {
  const f = await fixture(t); let imeReads = 0;
  f.adb.onIme = () => {
    if (++imeReads >= 2) f.adb.inputConnection = 'new-editor';
    if (imeReads === 3) f.adb.window = 'another-window';
  };
  const body = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(body.result.status, 'stopped'); assert.equal(body.result.error, 'PHONE_FRAME_CHANGED_DURING_CAPTURE');
  assert.equal(f.adb.writes.length, 1);
});

test('a pending child receipt prevents a post-tap focus recovery attempt', async t => {
  const f = await fixture(t); let imeReads = 0;
  const childRequestId = digest(`phone_sequence:${f.args.request_id}:1`);
  f.adb.onIme = async () => {
    if (++imeReads === 2) {
      f.adb.inputConnection = 'new-editor';
      await f.phone.store.save(`request-${digest(childRequestId)}.json`, { state: 'pending' });
    }
  };
  const body = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(body.result.status, 'outcome_unknown'); assert.equal(body.result.completed_steps, 1);
  assert.equal(f.adb.writes.length, 1);
});

test('window changes during readiness waiting stop the sequence without sending text', async t => {
  const f = await fixture(t); f.adb.unreadyAfterTap = 10;
  let imeReads = 0;
  f.adb.onIme = () => { if (++imeReads === 2) f.adb.window = 'another-window'; };
  const body = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(body.result.status, 'stopped');
  assert.equal(body.result.error, 'PHONE_FRAME_CHANGED_DURING_CAPTURE');
  assert.equal(f.adb.writes.length, 1); assert.equal(body.observation.mode, 'image');
});

test('a selector timeout stops later actions and the same receipt never continues them', async t => {
  const f = await fixture(t);
  const args = { ...f.args, steps: [{ action: f.args.steps[0]!.action,
    wait_for: { selector: { text: 'Missing' }, timeout_ms: 100, stable_ms: 0 } }, f.args.steps[2]!] };
  const body = decode(await f.phone.call('phone_sequence', args));
  assert.equal(body.result.status, 'stopped'); assert.equal(body.result.error, 'PHONE_SEQUENCE_WAIT_TIMEOUT');
  assert.equal(body.result.completed_steps, 0); assert.equal(body.result.steps[0].request_sent, true);
  assert.equal(body.result.steps[0].result.wait.status, 'timeout');
  assert.equal(body.observation.mode, 'image'); assert.equal(f.adb.writes.length, 1);
  assert.equal(decode(await f.phone.call('phone_sequence', args)).status, 'stopped');
  assert.equal(f.adb.writes.length, 1);
});

test('a final selector timeout reuses its existing image instead of recapturing', async t => {
  const f = await fixture(t);
  const response = await f.phone.call('phone_sequence', { ...f.args, steps: [{ action: f.args.steps[0]!.action,
    wait_for: { selector: { text: 'Missing' }, timeout_ms: 100, stable_ms: 0 } }] });
  assert.equal(decode(response).result.error, 'PHONE_SEQUENCE_WAIT_TIMEOUT');
  assert.equal(response.content.filter(c => c.type === 'image').length, 1);
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 1);
  assert.equal(f.adb.writes.length, 1);
});

test('an unknown second action preserves partial progress and never repeats input', async t => {
  const f = await fixture(t); f.adb.failAfterWrite = 2;
  const response = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(response.result.status, 'outcome_unknown');
  assert.equal(response.result.completed_steps, 1); assert.equal(response.result.stopped_at, 1);
  assert.equal(response.result.steps[1].status, 'outcome_unknown');
  assert.equal(response.result.observation_error, 'ADB_FAILED_OR_TIMEOUT');
  assert.equal(f.adb.writes.length, 2);
  f.adb.failed = false;
  const replay = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(replay.status, 'outcome_unknown'); assert.equal(f.adb.writes.length, 2);
});

test('a parent journal failure after input reports partial progress and never resumes', async t => {
  const f = await fixture(t), save = f.phone.store.save.bind(f.phone.store);
  const parent = `request-${digest(f.args.request_id)}.json`;
  f.phone.store.save = async (file, value) => {
    if (file === parent && f.adb.writes.length) throw new Error('disk unavailable');
    return save(file, value);
  };
  const body = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(body.result.status, 'outcome_unknown'); assert.equal(body.result.error, 'PHONE_SEQUENCE_JOURNAL_FAILED');
  assert.equal(body.result.completed_steps, 1); assert.equal(f.adb.writes.length, 1);
  assert.equal(body.observation.mode, 'image');
  const replay = decode(await new PhoneService(f.config, f.adb).call('phone_sequence', f.args));
  assert.equal(replay.status, 'outcome_unknown'); assert.equal(f.adb.writes.length, 1);
});

test('failure to persist the final sequence receipt does not report successful completion', async t => {
  const f = await fixture(t), save = f.phone.store.save.bind(f.phone.store);
  const parent = `request-${digest(f.args.request_id)}.json`;
  f.phone.store.save = async (file, value) => {
    if (file === parent && (value as { state?: string }).state === 'completed') throw new Error('disk unavailable');
    return save(file, value);
  };
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [f.args.steps[0]!] }));
  assert.equal(body.result.status, 'outcome_unknown'); assert.equal(body.result.completed_steps, 1);
  assert.equal(body.result.error, 'PHONE_SEQUENCE_JOURNAL_FAILED'); assert.equal(f.adb.writes.length, 1);
});

test('local pause between steps stops the sequence and preserves the completed step', async t => {
  const f = await fixture(t);
  f.adb.onWrite = async () => { await writeFile(join(f.dir, 'PAUSED'), ''); };
  const body = decode(await f.phone.call('phone_sequence', f.args));
  assert.equal(body.result.status, 'stopped'); assert.equal(body.result.error, 'PHONE_ADMIN_PAUSED');
  assert.equal(body.result.completed_steps, 1); assert.equal(f.adb.writes.length, 1);
  assert.equal(body.observation.mode, 'image');
});

test('sequence holds the shared operation lock across its steps', async t => {
  const f = await fixture(t);
  let entered!: () => void, resume!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  f.adb.onWrite = async () => { entered(); await blocked; };
  const execution = f.phone.call('phone_sequence', { ...f.args, observation: 'context', steps: [f.args.steps[0]!, f.args.steps[2]!] });
  await reached;
  const other = new PhoneService(f.config, f.adb);
  assert.equal(decode(await other.call('phone_observe', { ui: false, image: false })).error, 'PHONE_BUSY_OR_ABANDONED_LOCK');
  assert.equal(decode(await other.call('phone_release_control', { lease_id: f.args.lease_id })).error, 'PHONE_BUSY_OR_ABANDONED_LOCK');
  resume();
  assert.equal(decode(await execution).result.status, 'completed'); assert.equal(f.adb.writes.length, 2);
});

test('pending sequence receipts report progress across restarts even with an abandoned lock', async t => {
  const f = await fixture(t), parsed = phoneSchemas.phone_sequence.parse(f.args);
  const fingerprint = createHmac('sha256', f.args.lease_id).update(JSON.stringify({ name: 'phone_sequence', ...parsed, lease_id: undefined, response_detail: undefined })).digest('hex');
  await f.phone.store.save(`request-${digest(f.args.request_id)}.json`, { fingerprint, lease_hash: digest(f.args.lease_id), state: 'pending',
    result: { status: 'running', completed_steps: 1, active_step: 1, steps: [{ index: 0, status: 'completed' }] } });
  await mkdir(join(f.dir, 'operation.lock'));
  const body = decode(await new PhoneService(f.config, f.adb).call('phone_sequence', f.args));
  assert.equal(body.status, 'outcome_unknown'); assert.equal(body.result.status, 'outcome_unknown');
  assert.equal(body.result.completed_steps, 1); assert.equal(body.result.active_step, 1);
  assert.equal(f.adb.writes.length, 0);
});

test('sequence request IDs conflict when parameters change', async t => {
  const f = await fixture(t), args = { ...f.args, observation: 'context', steps: [f.args.steps[2]!] };
  assert.equal(decode(await f.phone.call('phone_sequence', args)).result.status, 'completed');
  assert.equal(decode(await f.phone.call('phone_sequence', { ...args, settle_ms: 1 })).error, 'PHONE_REQUEST_CONFLICT');
  assert.equal(f.adb.writes.length, 1);
});

test('a later element action receives refreshed UI targets without an intermediate screenshot', async t => {
  const f = await fixture(t), element_id = f.frame.ui.elements[0].element_id;
  const args = { ...f.args, steps: [f.args.steps[2]!, { action: { type: 'tap_element', element_id } }] };
  const body = decode(await f.phone.call('phone_sequence', args));
  assert.equal(body.result.status, 'completed'); assert.equal(f.adb.writes.length, 2);
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 1);
  assert.equal(f.adb.calls.filter(c => c.includes('uiautomator')).length, 1);
});

test('an element absent from refreshed UI stops before that action', async t => {
  const f = await fixture(t), element_id = f.frame.ui.elements[0].element_id;
  f.adb.ui = '<hierarchy></hierarchy>';
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [f.args.steps[2]!, { action: { type: 'tap_element', element_id } }] }));
  assert.equal(body.result.status, 'stopped'); assert.equal(body.result.error, 'PHONE_UI_TARGET_UNKNOWN_OR_AMBIGUOUS');
  assert.equal(body.result.completed_steps, 1); assert.equal(f.adb.writes.length, 1);
});

test('final settling waits without repeated images and auto returns useful UI alone', async t => {
  const f = await fixture(t);
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, observation: 'auto', settle_ms: 100 }));
  assert.equal(body.result.status, 'completed'); assert.equal(body.observation.mode, 'ui');
  assert.equal(body.result.timing.settle_ms, 100); assert.ok(body.result.timing.total_ms >= 100);
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 0);
  assert.equal(f.adb.calls.filter(c => c.includes('uiautomator')).length, 1);
});

test('sequence rejects excess steps, excess waiting and an expired initial frame before input', async t => {
  const f = await fixture(t);
  assert.equal(phoneSchemas.phone_sequence.safeParse({ ...f.args, steps: Array(9).fill(f.args.steps[2]) }).success, false);
  assert.equal(phoneSchemas.phone_sequence.safeParse({ ...f.args, steps: [1, 2].map(() => ({ action: f.args.steps[2]!.action,
    wait_for: { selector: { text: 'ready' }, timeout_ms: 20000 } })) }).success, false);
  assert.equal(decode(await f.phone.call('phone_sequence', { ...f.args, steps: [{ action: f.args.steps[1]!.action,
    wait_for: { selector: { text: 'ready' }, timeout_ms: 30000 } }] })).error, 'PHONE_SEQUENCE_WAIT_BUDGET_EXCEEDED');
  const persisted = await f.phone.store.read<any>('frame.json');
  await f.phone.store.save('frame.json', { ...persisted, at: Date.now() - 31000 });
  assert.equal(decode(await f.phone.call('phone_sequence', f.args)).error, 'PHONE_FRAME_EXPIRED');
  assert.equal(f.adb.writes.length, 0);
});

test('per-step settling delays the next action and returns only the final image', async t => {
  const f = await fixture(t), times: number[] = [];
  f.adb.onWrite = async () => { times.push(performance.now()); };
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [
    { action: f.args.steps[0]!.action, settle_after_ms: 120 }, f.args.steps[2]!
  ] }));
  assert.equal(body.result.status, 'completed'); assert.ok(times[1]! - times[0]! >= 110);
  assert.equal(body.result.steps[0].settle_after_ms, 120);
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 1);
});

test('the last step settles before its only final observation', async t => {
  const f = await fixture(t);
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [{ action: f.args.steps[2]!.action, settle_after_ms: 100 }] }));
  assert.equal(body.result.status, 'completed'); assert.equal(body.result.steps[0].settle_after_ms, 100);
  assert.ok(body.result.timing.total_ms >= 100);
  assert.equal(f.adb.calls.filter(c => c.includes('screencap')).length, 1);
});

test('an element target is refreshed after settling, and pause prevents the next input', async t => {
  const f = await fixture(t), target = f.frame.ui.elements[0].element_id;
  let timer: ReturnType<typeof setTimeout>;
  t.after(() => clearTimeout(timer));
  f.adb.onWrite = async () => { if (f.adb.writes.length === 1) timer = setTimeout(() => { f.adb.ui = '<hierarchy></hierarchy>'; }, 20); };
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [
    { action: f.args.steps[2]!.action, settle_after_ms: 100 }, { action: { type: 'tap_element', element_id: target } }
  ] }));
  assert.equal(body.result.error, 'PHONE_UI_TARGET_UNKNOWN_OR_AMBIGUOUS'); assert.equal(f.adb.writes.length, 1);
  const g = await fixture(t);
  g.adb.onWrite = async () => { await writeFile(join(g.dir, 'PAUSED'), ''); };
  const paused = decode(await g.phone.call('phone_sequence', { ...g.args, steps: [
    { action: g.args.steps[0]!.action, settle_after_ms: 30 }, g.args.steps[2]!
  ] }));
  assert.equal(paused.result.error, 'PHONE_ADMIN_PAUSED'); assert.equal(g.adb.writes.length, 1);
});

test('step waits count toward the total budget and cannot be negative or unbounded', async t => {
  const f = await fixture(t);
  for (const value of [-1, 2001]) assert.equal(phoneSchemas.phone_sequence.safeParse({ ...f.args,
    steps: [{ action: f.args.steps[0]!.action, settle_after_ms: value }] }).success, false);
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, steps: [{ action: f.args.steps[0]!.action,
    settle_after_ms: 2000, wait_for: { selector: { text: 'ready' }, timeout_ms: 29000 } }] }));
  assert.equal(body.error, 'PHONE_SEQUENCE_WAIT_BUDGET_EXCEEDED'); assert.equal(f.adb.writes.length, 0);
});

test('summary is the default, full receipts remain retrievable without repeating input, and timing is logged', async t => {
  const f = await fixture(t), args = { ...f.args, response_detail: undefined };
  const response = await f.phone.call('phone_sequence', args), body = decode(response);
  assert.equal(body.result.status, 'completed'); assert.equal(body.result.steps, undefined);
  assert.equal(body.diagnostic.recorded, true); assert.equal(body.consistency, undefined);
  assert.equal(response.content.filter(item => item.type === 'image').length, 1);
  const log = (await readFile(join(f.dir, 'diagnostics', 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const entry = log.find(item => item.trace_id === body.diagnostic.trace_id);
  assert.equal(entry.result.steps.length, 3); assert.equal(entry.image_count, 1);
  assert.ok(entry.duration_ms >= 0); assert.ok(entry.idle_before_ms >= 0);
  assert.ok(!JSON.stringify(log).includes(f.args.lease_id)); assert.ok(!JSON.stringify(log).includes('茉莉花茶'));
  const replay = decode(await f.phone.call('phone_sequence', { ...args, response_detail: 'full' }));
  assert.equal(replay.replayed, true); assert.equal(replay.result.steps.length, 3); assert.equal(f.adb.writes.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < Buffer.byteLength(JSON.stringify(replay)));
});

test('summary preserves the failed step and diagnostic failure does not change a completed action', async t => {
  const f = await fixture(t); f.adb.neverReady = true;
  const body = decode(await f.phone.call('phone_sequence', { ...f.args, response_detail: undefined, input_ready_timeout_ms: 100 }));
  assert.equal(body.result.failed_steps[0].index, 1); assert.equal(body.result.failed_steps[0].request_sent, false);
  assert.equal(body.result.error, 'PHONE_INPUT_READY_TIMEOUT');
  const g = await fixture(t);
  await mkdir(join(g.dir, 'diagnostics', 'operation.lock'));
  const completed = decode(await g.phone.call('phone_sequence', { ...g.args, response_detail: undefined }));
  assert.equal(completed.result.status, 'completed'); assert.equal(completed.diagnostic.recorded, false);
  assert.equal(g.adb.writes.length, 3);
});
