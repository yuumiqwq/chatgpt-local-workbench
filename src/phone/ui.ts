import { digest } from './store.js';

type Bounds = [number, number, number, number];
type Node = { tag: string; attrs: Record<string, string>; parent: Node | undefined; children: Node[] };
export type UiElement = { element_id: string; text: string; resource_id: string; description: string; class: string; bounds: Bounds; click_bounds: Bounds };
export type UiNode = { text: string; resource_id: string; description: string; class: string; bounds: Bounds; enabled: boolean };
export type UiSelector = { text?: string | undefined; resource_id?: string | undefined; description?: string | undefined; class?: string | undefined };
export type UiSnapshot = { elements: UiElement[]; anchors: string[]; nodes?: UiNode[]; rawNodes?: Node[] };
export type UiProof = { element_ids: string[]; anchors: string[] };

// Only the bounded, entity-escaped node/hierarchy subset produced by Android's
// UI dump is accepted. No DTD, external entities, HTML or executable content.
function decode(value: string): string {
  return value.replace(/&([^;]*);|&/g, (_whole, entity: string | undefined) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity && Object.hasOwn(named, entity)) return named[entity]!;
    const numeric = entity?.match(/^#(x[0-9a-fA-F]+|[0-9]+)$/)?.[1];
    const cp = numeric ? Number.parseInt(numeric.replace(/^x/, ''), numeric.startsWith('x') ? 16 : 10) : NaN;
    if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('PHONE_UI_DUMP_INVALID');
    return String.fromCodePoint(cp);
  });
}
function parse(xml: string): Node[] {
  if (Buffer.byteLength(xml) > 512 * 1024 || /<!/.test(xml)) throw new Error('PHONE_UI_DUMP_INVALID');
  const nodes: Node[] = [], stack: Node[] = [];
  let cursor = 0, hierarchy = false, closed = false;
  for (const match of xml.matchAll(/<[^>]*>/g)) {
    if (xml.slice(cursor, match.index).trim()) throw new Error('PHONE_UI_DUMP_INVALID');
    cursor = match.index! + match[0].length;
    const tag = match[0];
    if (/^<\?xml\s[^?]*\?>$/.test(tag) && !hierarchy && !nodes.length) continue;
    if (/^<hierarchy(?:\s+[\w-]+="[^"<>]*")*\s*>$/.test(tag) && !hierarchy) { hierarchy = true; continue; }
    if (tag === '</hierarchy>' && hierarchy && !stack.length && !closed) { closed = true; continue; }
    if (!hierarchy || closed) throw new Error('PHONE_UI_DUMP_INVALID');
    const closing = /^<\/([\w.$:-]+)>$/.exec(tag);
    if (closing) { if (stack.pop()?.tag !== closing[1]) throw new Error('PHONE_UI_DUMP_INVALID'); continue; }
    const opening = /^<([A-Za-z_][\w.$:-]*)\s+([\s\S]*?)\s*(\/?)>$/.exec(tag);
    if (!opening || nodes.length >= 4096 || stack.length >= 128) throw new Error('PHONE_UI_DUMP_INVALID');
    const attrs: Record<string, string> = Object.create(null);
    let at = 0;
    for (const attribute of opening[2]!.matchAll(/([\w-]+)="([^"<>]*)"/g)) {
      if (opening[2]!.slice(at, attribute.index).trim() || Object.hasOwn(attrs, attribute[1]!)) throw new Error('PHONE_UI_DUMP_INVALID');
      attrs[attribute[1]!] = decode(attribute[2]!); at = attribute.index! + attribute[0].length;
    }
    if (opening[2]!.slice(at).trim()) throw new Error('PHONE_UI_DUMP_INVALID');
    const node: Node = { tag: opening[1]!, attrs, parent: stack.at(-1), children: [] };
    node.parent?.children.push(node); nodes.push(node);
    if (!opening[3]) stack.push(node);
  }
  if (!closed || stack.length || xml.slice(cursor).trim()) throw new Error('PHONE_UI_DUMP_INVALID');
  return nodes;
}
function bounds(node: Node, width: number, height: number): Bounds | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.attrs.bounds ?? '');
  if (!match) return;
  const b = match.slice(1).map(Number) as Bounds;
  if (b[0] >= b[2] || b[1] >= b[3] || b[2] > width || b[3] > height) return;
  return b;
}
function identity(node: Node) {
  return ['package', 'class', 'resource-id', 'text', 'content-desc', 'clickable', 'checkable', 'checked', 'selected', 'password']
    .map(key => node.attrs[key] ?? '');
}
function parents(node: Node): Node[] { const result: Node[] = []; for (let n: Node | undefined = node; n; n = n.parent) result.unshift(n); return result; }
function subtree(node: Node): unknown { return [identity(node), ...node.children.map(subtree)]; }
function visible(node: Node) { return parents(node).every(n => n.attrs['visible-to-user'] !== 'false' && n.attrs.displayed !== 'false' && n.attrs.password !== 'true'); }
function usable(node: Node) { return visible(node) && parents(node).every(n => n.attrs.enabled === 'true'); }
function contains(b: Bounds, x: number, y: number) { return b[0] <= x && x < b[2] && b[1] <= y && y < b[3]; }

export function uiSnapshot(xml: string, packageName: string, width: number, height: number): UiSnapshot {
  const nodes = parse(xml), elements: UiElement[] = [], anchors: string[] = [];
  for (const node of nodes) {
    if (node.attrs.package !== packageName || !usable(node)) continue;
    const b = bounds(node, width, height);
    if (!b) continue;
    const path = parents(node);
    // Store hashes only; node text and resource IDs remain response data.
    if (node.attrs.text || node.attrs['content-desc'] || node.attrs['resource-id']) anchors.push(digest(JSON.stringify(path.map(identity))));
    const target = [...path].reverse().find(n => n.attrs.clickable === 'true');
    const click = target && bounds(target, width, height);
    if (!target || !click || (!node.attrs.text && !node.attrs['content-desc'] && !node.attrs['resource-id'])) continue;
    const x = Math.floor((b[0] + b[2]) / 2), y = Math.floor((b[1] + b[3]) / 2);
    if (!contains(click, x, y)) continue;
    // Refuse a point covered by an unrelated clickable node in the current tree.
    if (nodes.some(other => {
      if (other === target || other === node || other.attrs.clickable !== 'true' || !usable(other)) return false;
      if (parents(target).includes(other) || parents(other).includes(target)) return false;
      const ob = bounds(other, width, height); return ob && contains(ob, x, y);
    })) continue;
    const element_id = digest(JSON.stringify([path.map(identity), b, click, subtree(target)]));
    elements.push({ element_id, text: node.attrs.text ?? '', resource_id: node.attrs['resource-id'] ?? '',
      description: node.attrs['content-desc'] ?? '', class: node.attrs.class ?? '', bounds: b, click_bounds: click });
  }
  const visibleNodes: UiNode[] = [];
  for (const node of nodes) {
    const b = bounds(node, width, height);
    if (node.attrs.package !== packageName || !visible(node) || !b) continue;
    visibleNodes.push({ text: node.attrs.text ?? '', resource_id: node.attrs['resource-id'] ?? '',
      description: node.attrs['content-desc'] ?? '', class: node.attrs.class ?? '', bounds: b, enabled: usable(node) });
  }
  return { elements, anchors: [...new Set(anchors)], nodes: visibleNodes, rawNodes: nodes };
}
export function matchesUi(snapshot: UiSnapshot, selector: UiSelector, enabled = false): UiNode[] {
  return (snapshot.nodes ?? []).filter(node => (!enabled || node.enabled) &&
    Object.entries(selector).every(([key, value]) => value === undefined || node[key as keyof UiSelector] === value));
}
export function validateTouchPoint(snapshot: UiSnapshot, elementId: string, point: [number, number]): boolean {
  const element = snapshot.elements.find(item => item.element_id === elementId);
  if (!element || !contains(element.bounds, ...point) || !contains(element.click_bounds, ...point)) return false;
  const center: [number, number] = [Math.floor((element.bounds[0] + element.bounds[2]) / 2), Math.floor((element.bounds[1] + element.bounds[3]) / 2)];
  // Preserve the center's clickable-node membership when varying the touch point.
  return (snapshot.rawNodes ?? []).every(node => {
    if (node.attrs.clickable !== 'true' || !usable(node)) return true;
    const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.attrs.bounds ?? '')?.slice(1).map(Number) as Bounds | undefined;
    return !b || contains(b, ...point) === contains(b, ...center);
  });
}
export function uiProof(ui: UiSnapshot): UiProof { return { element_ids: ui.elements.map(e => e.element_id), anchors: ui.anchors }; }
export function resolveUiTarget(expected: UiProof | undefined, current: UiSnapshot, elementId: string) {
  if (!expected || !Array.isArray(expected.element_ids) || !Array.isArray(expected.anchors)) throw new Error('PHONE_UI_OBSERVATION_REQUIRED');
  if (expected.element_ids.filter(id => id === elementId).length !== 1) throw new Error('PHONE_UI_TARGET_UNKNOWN_OR_AMBIGUOUS');
  const matches = current.elements.filter(e => e.element_id === elementId);
  if (matches.length !== 1) throw new Error('PHONE_UI_TARGET_CHANGED_OR_AMBIGUOUS');
  const previous = new Set(expected.anchors), fresh = new Set(current.anchors);
  const shared = [...previous].filter(id => fresh.has(id)).length;
  if (!shared || shared / Math.max(previous.size, fresh.size) < 0.5) throw new Error('PHONE_UI_PAGE_CHANGED');
  const b = matches[0]!.bounds;
  return { x: Math.floor((b[0] + b[2]) / 2), y: Math.floor((b[1] + b[3]) / 2) };
}
