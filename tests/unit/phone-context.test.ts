import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseDisplayContext, parseWindowOwner } from '../../src/phone/context.js';
import { PhoneService } from '../../src/phone/service.js';
import type { PhoneConfig } from '../../src/phone/config.js';
import type { Adb } from '../../src/phone/adb.js';

const customFocus = 'Window{128d05a u0 com.hihonor.hiboard.Workspace}';
const componentFocus = 'Window{abc u0 com.android.settings/.Settings}';
const display = (id: number, focus: string, rotation: number) => `   Display: mDisplayId=${id}${id === 0 ? ' (organized)' : ''}\n`
  + `    overrideConfig={mDisplayRotation=ROTATION_0 mRotation=ROTATION_0}\n    mCurrentFocus=${focus}\n`
  + `  DisplayRotation\n    mCurrentAppOrientation=1\n    mRotation=${rotation} mDeferredRotationPauseCount=0\n  DisplayFrames w=1080 h=2400 r=${rotation}\n`;
const displays = (focus = customFocus, rotation = 0) => display(4, 'null', 1) + display(0, focus, rotation) + 'Physical size: 1080x2400\n';
const windows = (focus = customFocus, owner = 'com.hihonor.hiboard', id = 0) => `Window #11 ${focus}:\n`
  + ` mDisplayId=${id} rootTaskId=1 mSession=Session{8e5c34c 8297:u0a10031}\n`
  + ` mOwnerUid=10031 showForAllUsers=false package=${owner} appop=NONE\n`
  + ' mAttrs={(0,0)(fillxfill)}\n mToken=ActivityRecord{deb2886 u0 com.hihonor.android.launcher/.unihome.UniHomeLauncher t2}\n'
  + ' mActivityRecord=ActivityRecord{deb2886 u0 com.hihonor.android.launcher/.unihome.UniHomeLauncher t2}\n';
const decode = (response: CallToolResult) => JSON.parse((response.content[0] as { text: string }).text);

test('display context chooses default-display focus and its own rotation', () => {
  const physical = parseDisplayContext(displays());
  assert.equal(physical.focus, customFocus); assert.equal(physical.package, null);
  assert.equal(physical.rotation, 0); assert.equal(physical.width, 1080); assert.equal(physical.height, 2400);
  const rotated = parseDisplayContext(displays(componentFocus, 1));
  assert.equal(rotated.rotation, 1); assert.equal(rotated.width, 2400); assert.equal(rotated.height, 1080);
  assert.equal(rotated.package, 'com.android.settings');
});

test('context ignores a focused virtual display when default display is missing or unfocused', () => {
  for (const output of [display(4, componentFocus, 0), display(4, componentFocus, 0) + display(0, 'null', 0)]) {
    assert.throws(() => parseDisplayContext(output + 'Physical size: 1080x2400'), /PHONE_DISPLAY_CONTEXT_UNKNOWN/);
  }
});

test('legacy one-display output and CRLF dumps retain component parsing', () => {
  const legacy = `mCurrentFocus=${componentFocus}\nmRotation=ROTATION_90\nPhysical size: 1080x2400`;
  assert.equal(parseDisplayContext(legacy).package, 'com.android.settings');
  assert.equal(parseDisplayContext(legacy).rotation, 1);
  assert.equal(parseDisplayContext(displays(componentFocus).replaceAll('\n', '\r\n')).width, 1080);
});

test('duplicate default displays, ambiguous focus and display overrides are rejected', () => {
  assert.throws(() => parseDisplayContext(display(0, componentFocus, 0) + displays()), /PHONE_DISPLAY_CONTEXT_UNKNOWN/);
  assert.throws(() => parseDisplayContext(`mCurrentFocus=${componentFocus}\nmCurrentFocus=${customFocus}\nmRotation=0\nPhysical size: 1080x2400`), /PHONE_DISPLAY_CONTEXT_UNKNOWN/);
  assert.throws(() => parseDisplayContext(displays() + 'Override size: 720x1600'), /PHONE_DISPLAY_OVERRIDE_UNSUPPORTED/);
});

test('custom window ownership comes from the exact window owner rather than its activity token', () => {
  assert.equal(parseWindowOwner(windows(), customFocus), 'com.hihonor.hiboard');
  const other = windows(componentFocus, 'com.android.settings').replace('Window #11', 'Window #10');
  assert.equal(parseWindowOwner(other + windows(), customFocus), 'com.hihonor.hiboard');
  assert.equal(parseWindowOwner(windows() + other, customFocus), 'com.hihonor.hiboard');
});

test('owner resolution requires one exact window on display zero and one valid owner field', () => {
  for (const output of [windows(componentFocus), windows(customFocus, 'com.hihonor.hiboard', 4), windows() + windows(),
    windows().replace(/mOwnerUid=[^\n]+\n/, ''), windows(customFocus, 'not-a-package'),
    windows() + ' mOwnerUid=10032 package=com.example.second appop=NONE\n']) {
    assert.throws(() => parseWindowOwner(output, customFocus), /PHONE_DISPLAY_CONTEXT_UNKNOWN/);
  }
});

class ContextAdb implements Adb {
  calls: string[][] = [];
  custom = false;
  changedDuringOwnerLookup = false;
  invalidOwner = false;
  writes = 0;
  constructor(readonly png: Buffer) {}
  async run(args: string[]) { this.calls.push(args); return this.execute(args); }
  private async execute(args: string[]): Promise<Buffer> {
    if (args[0] === 'shell' && args.length === 2 && args[1]!.includes(';')) {
      const output: Buffer[] = [];
      for (const command of args[1]!.split(';')) output.push(await this.execute(['shell', ...command.trim().split(' ')]), Buffer.from('\n'));
      return Buffer.concat(output);
    }
    const command = args.join(' ');
    if (args[1] === 'echo') return Buffer.from(args.slice(2).join(' '));
    if (command === 'shell dumpsys window displays') return Buffer.from(displays(this.custom ? customFocus : componentFocus));
    if (command === 'shell dumpsys window windows') {
      const output = windows(this.invalidOwner ? componentFocus : customFocus);
      if (this.changedDuringOwnerLookup) this.custom = false;
      return Buffer.from(output);
    }
    if (command.includes('screencap')) return this.png;
    if (command.includes('uiautomator')) return Buffer.from('<hierarchy></hierarchy>');
    if (command.includes('default_input_method')) return Buffer.from('org.workbench.ime/.WorkbenchIme');
    if (command.includes('input keyevent')) { this.custom = true; this.writes++; }
    return Buffer.from('');
  }
}
async function fixture(t: TestContext) {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'phone-context-test-'));
  t.after(async () => {
    const suffix = relative(root, resolve(dir)); assert.ok(suffix && !suffix.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  const png = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#fff' } }).png().toBuffer();
  const adb = new ContextAdb(png);
  const config: PhoneConfig = { enabled: true, hostname: 'test', adb_path: process.execPath, serial: 'test', state_dir: dir,
    lease_seconds: 60, frame_seconds: 30, ime_enabled: true };
  return { phone: new PhoneService(config, adb), adb };
}

test('normal component observations make no owner lookup while custom titles resolve exactly once', async t => {
  const f = await fixture(t);
  assert.equal(decode(await f.phone.call('phone_observe', { ui: false, image: false })).package, 'com.android.settings');
  assert.equal(f.adb.calls.length, 1);
  assert.equal(f.adb.calls.some(args => args.join(' ').includes('dumpsys window windows')), false);
  f.adb.custom = true; f.adb.calls = [];
  const body = decode(await f.phone.call('phone_observe', { ui: false, image: false }));
  assert.equal(body.package, 'com.hihonor.hiboard'); assert.equal(body.width, 1080); assert.equal(body.rotation, 0);
  assert.equal(f.adb.calls.filter(args => args.join(' ').includes('dumpsys window windows')).length, 1);
});

test('owner lookup detects a focus change instead of accepting stale ownership', async t => {
  const f = await fixture(t); f.adb.custom = true; f.adb.changedDuringOwnerLookup = true;
  assert.equal(decode(await f.phone.call('phone_observe', { ui: false, image: false })).error, 'PHONE_FRAME_CHANGED_DURING_CAPTURE');
  assert.equal(await f.phone.store.read('frame.json'), undefined);
});

test('a missing exact owner does not substitute a launcher activity package', async t => {
  const f = await fixture(t); f.adb.custom = true; f.adb.invalidOwner = true;
  assert.equal(decode(await f.phone.call('phone_observe', { ui: false, image: false })).error, 'PHONE_DISPLAY_CONTEXT_UNKNOWN');
  assert.equal(await f.phone.store.read('frame.json'), undefined);
});

test('HOME into a custom-owned desktop returns a completed observed result without replaying the key', async t => {
  const f = await fixture(t), lease_id = decode(await f.phone.call('phone_acquire_control', {})).lease_id;
  const frame = decode(await f.phone.call('phone_observe', { ui: false, image: false }));
  const args = { lease_id, frame_id: frame.frame_id, request_id: 'custom-home-request-01', action: { type: 'key', key: 'HOME' }, observation: 'image' };
  const response = await f.phone.call('phone_input', args), body = decode(response);
  assert.equal(body.result.status, 'completed'); assert.equal(body.package, 'com.hihonor.hiboard');
  assert.equal(response.content.filter(content => content.type === 'image').length, 1);
  assert.equal(decode(await f.phone.call('phone_input', args)).replayed, true); assert.equal(f.adb.writes, 1);
});
