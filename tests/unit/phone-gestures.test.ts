import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { touchGesture, touchPoint } from '../../src/phone/gestures.js';
import { uiSnapshot, matchesUi } from '../../src/phone/ui.js';
import { AppiumAutomation } from '../../src/phone/automation.js';
import { PhoneConfigSchema, type PhoneConfig } from '../../src/phone/config.js';

test('touch plans have a coherent finger lifetime and variable bounded hold time', () => {
  const fast = touchGesture([20, 30], {}, () => 0), slow = touchGesture([20, 30], {}, () => 0.999);
  assert.equal(fast.duration_ms, 80); assert.equal(slow.duration_ms, 160);
  for (const plan of [fast, slow]) {
    const actions = plan.actions[0]!.actions;
    assert.deepEqual(actions.map(a => a.type), ['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
    assert.equal(actions[2]!.duration, plan.duration_ms);
    assert.equal(plan.actions[0]!.parameters.pointerType, 'touch');
  }
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    assert.deepEqual(touchPoint([4, 5, 5, 6], random), [4, 5]);
    const [x, y] = touchPoint([100, 200, 300, 300], random);
    assert.ok(x >= 194 && x <= 206 && y >= 244 && y <= 256);
  }
});

test('swipe interpolates through bounded points with varying speed and exact duration/endpoints', () => {
  const plan = touchGesture([100, 800], { to: [150, 200], duration_ms: 401 });
  const moves = plan.actions[0]!.actions.filter(a => a.type === 'pointerMove');
  assert.equal(moves.reduce((sum, action) => sum + Number(action.duration), 0), 401);
  assert.deepEqual(plan.points.at(-1), [150, 200]);
  assert.ok(plan.points.every(([x, y]) => x >= 100 && x <= 150 && y >= 200 && y <= 800));
  const distances = plan.points.slice(1).map((p, i) => Math.abs(p[1] - plan.points[i]![1]));
  assert.ok(Math.max(...distances) > distances[0]!);
});

test('Appium class-tag XML exposes non-clickable and disabled nodes for condition waits', () => {
  const source = '<?xml version="1.0"?><hierarchy rotation="0"><android.widget.TextView package="app" class="android.widget.TextView" text="Ready" enabled="false" displayed="true" clickable="false" bounds="[0,0][100,100]"/></hierarchy>';
  const ui = uiSnapshot(source, 'app', 200, 300);
  assert.equal(ui.elements.length, 0);
  assert.equal(matchesUi(ui, { text: 'Ready' }).length, 1);
  assert.equal(matchesUi(ui, { text: 'Ready' }, true).length, 0);
  assert.throws(() => uiSnapshot(source.replace('/></hierarchy>', '></wrong></hierarchy>'), 'app', 200, 300));
});

test('Appium endpoint validation accepts only loopback endpoints without credentials', () => {
  const config = { enabled: true, hostname: 'test', adb_path: process.execPath, serial: 'test', state_dir: tmpdir() };
  assert.equal(PhoneConfigSchema.parse({ ...config, appium_url: 'http://127.0.0.1:4735' }).appium_url, 'http://127.0.0.1:4735');
  for (const appium_url of ['http://example.com', 'http://127.0.0.1@evil.com', 'https://127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1/?x=y']) {
    assert.equal(PhoneConfigSchema.safeParse({ ...config, appium_url }).success, false);
  }
});

test('Appium sessions persist across service processes and gesture failures are never replayed', async t => {
  const state_dir = await mkdtemp(join(tmpdir(), 'phone-appium-'));
  t.after(() => rm(state_dir, { recursive: true, force: true }));
  const config: PhoneConfig = { enabled: true, hostname: 'test', serial: 'phone1', adb_path: process.execPath, state_dir,
    lease_seconds: 60, frame_seconds: 30, ime_enabled: false, appium_url: 'http://127.0.0.1:4735' };
  let created = 0, dispatched = 0;
  const request = (async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    let value: unknown;
    if (path === '/session') {
      created++;
      const caps = JSON.parse(init.body).capabilities.alwaysMatch;
      assert.equal(caps['appium:noReset'], true); assert.equal(caps['appium:suppressKillServer'], true);
      value = { sessionId: 'session-one' };
    } else if (path.endsWith('/appium/settings')) value = { waitForIdleTimeout: 0 };
    else if (path.endsWith('/source')) value = '<?xml version="1.0"?><hierarchy></hierarchy>';
    else { dispatched++; throw new Error('connection dropped after send'); }
    return new Response(JSON.stringify({ value }), { status: 200 });
  }) as typeof fetch;
  const first = new AppiumAutomation(config, request); await first.source();
  const second = new AppiumAutomation(config, request); await second.source();
  assert.equal(created, 1);
  await assert.rejects(second.perform(touchGesture([1, 2])), /PHONE_AUTOMATION_UNAVAILABLE/);
  assert.equal(dispatched, 1); assert.equal(created, 1);
});

for (const error of ['invalid session id', 'unknown error']) {
  test(`Appium recreates a lost session before input: ${error}`, async t => {
    const state_dir = await mkdtemp(join(tmpdir(), 'phone-appium-recovery-'));
    t.after(() => rm(state_dir, { recursive: true, force: true }));
    const config: PhoneConfig = { enabled: true, hostname: 'test', serial: 'phone1', adb_path: process.execPath, state_dir,
      lease_seconds: 60, frame_seconds: 30, ime_enabled: false, appium_url: 'http://127.0.0.1:4735' };
    let created = 0, deleted = 0, dead = false;
    const request = (async (input: any, init: any) => {
      const path = new URL(String(input)).pathname;
      if (init.method === 'DELETE') { deleted++; return new Response('{"value":null}'); }
      if (path === '/session') { created++; dead = false; return new Response(JSON.stringify({ value: { sessionId: `session-${created}` } })); }
      if (dead) return new Response(JSON.stringify({ value: { error, message: 'the instrumentation process is not running (probably crashed)' } }), { status: 500 });
      return new Response(JSON.stringify({ value: path.endsWith('/source') ? '<hierarchy></hierarchy>' : {} }));
    }) as typeof fetch;
    await new AppiumAutomation(config, request).source();
    dead = true;
    assert.equal(await new AppiumAutomation(config, request).source(), '<hierarchy></hierarchy>');
    assert.equal(created, 2); assert.equal(deleted, 1);
    await new AppiumAutomation(config, request).ready(); assert.equal(created, 2);
  });
}
