import assert from 'node:assert/strict';
import test from 'node:test';
import { uiSnapshot, uiProof, resolveUiTarget } from '../../src/phone/ui.js';

const node = (text: string, extra = '', children = '') => `<node package="com.example.app" class="Button" text="${text}" enabled="true" clickable="true" bounds="[100,200][300,300]" ${extra}>${children}</node>`;
const wrap = (children: string) => `<?xml version="1.0"?><hierarchy rotation="0"><node package="com.example.app" class="Root" enabled="true" clickable="false" bounds="[0,0][1080,2400]">${children}</node></hierarchy>`;
const snapshot = (xml: string) => uiSnapshot(xml, 'com.example.app', 1080, 2400);

test('UI subset decodes Unicode/XML entities and maps label children to clickable parents', () => {
  const ui = snapshot(wrap(node('', 'resource-id="app:id/card"', '<node package="com.example.app" class="Text" text="中文 &amp; &#x1F600;" enabled="true" clickable="false" bounds="[110,210][290,290]"/>')));
  const label = ui.elements.find(e => e.text === '中文 & 😀')!;
  assert.ok(label); assert.deepEqual(label.click_bounds, [100, 200, 300, 300]);
  assert.deepEqual(resolveUiTarget(uiProof(ui), ui, label.element_id), {x:200,y:250});
});

test('UI parser rejects DTDs, unknown entities, malformed XML and duplicate attributes', () => {
  for (const xml of ['<!DOCTYPE hierarchy>'+wrap(node('x')), wrap(node('&external;')), wrap(node('x')).replace('</hierarchy>',''),
    wrap(node('x', 'text="duplicate"')), wrap(node('x')).replace('</node></hierarchy>','</hierarchy>'), '<hierarchy><script/></hierarchy>']) {
    assert.throws(() => snapshot(xml), /PHONE_UI_DUMP_INVALID/);
  }
});

test('disabled, invisible, password, out-of-bounds and foreign-package controls are excluded', () => {
  for (const xml of [wrap(node('x')).replace('enabled="true"','enabled="false"'), wrap(node('x', 'visible-to-user="false"')),
    wrap(node('secret', 'password="true"')), wrap(node('x')).replace('[100,200][300,300]','[100,200][1300,300]'),
    wrap(node('x')).replaceAll('com.example.app','com.other.app')]) assert.equal(snapshot(xml).elements.length, 0);
});

test('same subtree changing unrelated content keeps target, changing price inside it invalidates target', () => {
  const label = '<node package="com.example.app" class="Text" text="10" enabled="true" bounds="[110,210][290,290]"/>';
  const before = snapshot(wrap(node('Buy','',label)));
  const after = snapshot(wrap(node('Buy','',label.replace('text="10"','text="100"'))));
  assert.throws(() => resolveUiTarget(uiProof(before), after, before.elements[0]!.element_id), /PHONE_UI_TARGET_CHANGED/);
});

test('overlapping unrelated clickable elements and duplicate matches are not eligible', () => {
  const one = snapshot(wrap(node('x'))), two = snapshot(wrap(node('x')+node('overlay')));
  assert.equal(two.elements.length,0);
  assert.throws(() => resolveUiTarget(uiProof(one), two, one.elements[0]!.element_id), /PHONE_UI_TARGET_CHANGED/);
  const duplicate = {...one,elements:[...one.elements,...one.elements]};
  assert.throws(() => resolveUiTarget(uiProof(one), duplicate, one.elements[0]!.element_id), /AMBIGUOUS/);
  assert.throws(() => resolveUiTarget(uiProof(duplicate), one, one.elements[0]!.element_id), /AMBIGUOUS/);
});

test('majority page-anchor replacement refuses an otherwise identical button', () => {
  const other = (text: string, i: number) => `<node package="com.example.app" class="Text" text="${text}${i}" enabled="true" bounds="[0,${500+i*100}][300,${590+i*100}]"/>`;
  const before = snapshot(wrap(node('x')+[0,1,2,3].map(i=>other('old',i)).join('')));
  const after = snapshot(wrap(node('x')+[0,1,2,3].map(i=>other('new',i)).join('')));
  assert.throws(() => resolveUiTarget(uiProof(before), after, before.elements[0]!.element_id), /PHONE_UI_PAGE_CHANGED/);
});
