import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrollTarget, uiSnapshot } from '../../src/phone/ui.js';
import { nativeScroll, touchGesture, varyScrollDuration } from '../../src/phone/gestures.js';
import { AppiumAutomation } from '../../src/phone/automation.js';
import type { PhoneConfig } from '../../src/phone/config.js';

const list = (children = '', extra = '') => `<android.widget.ScrollView package="app" class="android.widget.ScrollView" enabled="true" scrollable="true" bounds="[0,100][1000,2000]" ${extra}>${children}</android.widget.ScrollView>`;
const inner = '<androidx.recyclerview.widget.RecyclerView package="app" enabled="true" scrollable="true" bounds="[0,500][1000,2000]"/>';
const target = (xml: string) => scrollTarget(uiSnapshot(`<hierarchy>${xml}</hierarchy>`, 'app', 1000, 2000), 'app', 1000, 2000, [800,1800], [800,700]);

test('scroll chooses the inner list rather than its overlapping outer scroller', () => {
  assert.deepEqual(target(list(inner)), {
    xpath: '/hierarchy/android.widget.ScrollView[1]/androidx.recyclerview.widget.RecyclerView[1]',
    bounds: [0,500,1000,2000]
  });
  assert.equal(target(list('', 'displayed="false"')), undefined);
  assert.equal(target(list() + list()), undefined);
  assert.equal(target('<node package="app" enabled="true" bounds="[0,0][1000,2000]"/>'), undefined);
  // Positional paths also distinguish equal-tag siblings without resource IDs.
  assert.match(target(list('<androidx.recyclerview.widget.RecyclerView package="app" enabled="true" scrollable="true" bounds="[0,100][1000,400]"/>' + inner))!.xpath,
    /RecyclerView\[2\]$/);
});

test('native scroll converts finger direction, distance and duration for each axis', () => {
  const bounds: [number, number, number, number] = [0,0,1000,2000];
  assert.deepEqual(nativeScroll('item', bounds, [800,1800], [800,800], 500, () => 0.5),
    {elementId:'item',direction:'down',percent:0.5,speed:2000});
  assert.equal(nativeScroll('item', bounds, [800,800], [800,1800], 500)!.direction, 'up');
  assert.equal(nativeScroll('item', bounds, [800,800], [200,800], 500)!.direction, 'right');
  assert.equal(nativeScroll('item', bounds, [200,800], [800,800], 500)!.direction, 'left');
  assert.equal(nativeScroll('item', bounds, [800,800], [800,800], 500), undefined);
});

test('scroll variation stays bounded, preserves direction and adds no average delay', () => {
  let sum = 0;
  for (let i=0;i<=100;i++) {
    const random=()=>i/100, duration=varyScrollDuration(450,random);
    sum+=duration;
    assert.ok(duration>=414 && duration<=486);
    const plan=nativeScroll('item',[0,0,1000,2000],[800,1800],[800,800],duration,random)!;
    assert.equal(plan.direction,'down');
    assert.ok(plan.percent>=0.485 && plan.percent<=0.515);
    assert.ok(Math.abs(plan.percent*2000/plan.speed*1000-duration)<1);
  }
  assert.equal(sum/101,450);
  assert.equal(varyScrollDuration(100,()=>0),100);
  assert.equal(varyScrollDuration(2000,()=>1),2000);
  assert.equal(nativeScroll('item',[0,0,1000,2000],[800,1999],[800,0],450,()=>1)!.percent,1);
});

test('native scroll resolves a unique target, returns end-of-list and never replays failed dispatch', async t => {
  const state_dir = await mkdtemp(join(tmpdir(), 'native-scroll-'));
  t.after(() => rm(state_dir, {recursive:true,force:true}));
  const config: PhoneConfig = {enabled:true,hostname:'test',serial:'phone',adb_path:process.execPath,state_dir,
    lease_seconds:60,frame_seconds:30,ime_enabled:false,appium_url:'http://127.0.0.1:4735'};
  let dispatched = 0, matches = 1, fail = false;
  const request = (async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    if (path === '/session') return Response.json({value:{sessionId:'scroll-test'}});
    if (path.endsWith('/elements')) {
      assert.deepEqual(JSON.parse(init.body), {using:'xpath',value:'/hierarchy/list[1]'});
      return Response.json({value:Array.from({length:matches}, () => ({'element-6066-11e4-a52e-4f735466cecf':'list-one'}))});
    }
    assert.ok(path.endsWith('/execute/sync'), 'no coordinate fallback after dispatch');
    dispatched++;
    assert.equal(JSON.parse(init.body).script, 'mobile: scrollGesture');
    assert.equal(JSON.parse(init.body).args[0].elementId, 'list-one');
    if (fail) throw new Error('connection lost after dispatch');
    return Response.json({value:false});
  }) as typeof fetch;
  const automation = new AppiumAutomation(config, request);
  await automation.ready();
  for (matches of [0,2]) assert.equal(await automation.resolveScrollTarget('/hierarchy/list[1]'), undefined);
  matches = 1;
  const element = await automation.resolveScrollTarget('/hierarchy/list[1]');
  assert.equal(element, 'list-one');
  const plan = touchGesture([800,1800],{to:[800,800],duration_ms:500});
  plan.scroll = nativeScroll(element!,[0,0,1000,2000],[800,1800],[800,800],500)!;
  assert.deepEqual(await automation.perform(plan), {can_scroll_more:false});
  fail = true;
  await assert.rejects(automation.perform(plan), /PHONE_AUTOMATION_UNAVAILABLE/);
  assert.equal(dispatched, 2);
});
