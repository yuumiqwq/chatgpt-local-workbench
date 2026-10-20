import { hostname } from 'node:os';
import { createHmac } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Adb } from './adb.js';
import type { PhoneConfig } from './config.js';
import { PhoneStore, digest, token } from './store.js';
import { VERSION } from '../version.js';
import { HostError } from '../host/host-policy.js';
import { ScrcpyPanel, physicalPanelState, type PhonePanel } from './panel.js';
import { visualSignature, stableTapTarget, stableSwipeTarget, type VisualSignature } from './visual.js';
import { uiSnapshot, uiProof, resolveUiTarget, matchesUi, validateTouchPoint, scrollTarget, type UiProof, type UiSnapshot } from './ui.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AppiumAutomation, type PhoneAutomation } from './automation.js';
import { touchGesture, touchPoint, nativeScroll, varyScrollDuration, type TouchPlan } from './gestures.js';
import { inputFocusProof } from './focus.js';
import { imageFallbackReason } from './observation.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const pkg = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(200);
const point = z.number().int().min(0).max(16384);
const auth = { lease_id: id, request_id: id };
const observationMode = z.enum(['auto', 'ui', 'image']).default('auto');
const selector = z.object({ text: z.string().max(500).optional(), resource_id: z.string().max(500).optional(),
  description: z.string().max(500).optional(), class: z.string().max(200).optional() }).strict().refine(value => Object.keys(value).length > 0);
const waitFor = z.object({ selector, state: z.enum(['visible', 'enabled', 'gone']).default('visible'),
  timeout_ms: z.number().int().min(100).max(30000).default(10000), stable_ms: z.number().int().min(0).max(1000).default(200) }).strict();
export const phoneSchemas = {
  server_status: z.object({}).strict(),
  phone_acquire_control: z.object({}).strict(),
  phone_release_control: z.object({ lease_id: id }).strict(),
  phone_observe: z.object({ ui: z.boolean().default(false), image: z.boolean().default(true), wait_for: waitFor.optional() }).strict(),
  phone_list_apps: z.object({ search: z.string().max(100).default(''), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(100).default(50), refresh: z.boolean().default(false) }).strict(),
  phone_open_app: z.object({ ...auth, package: pkg, wait_for: waitFor.optional(), observation: observationMode }).strict(),
  phone_input: z.object({ ...auth, frame_id: id, wait_for: waitFor.optional(), observation: observationMode, action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('tap_element'), element_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ type: z.literal('tap'), x: point, y: point }).strict(),
    z.object({ type: z.literal('long_press'), x: point, y: point, duration_ms: z.number().int().min(400).max(2000).default(600) }).strict(),
    z.object({ type: z.literal('swipe'), x: point, y: point, to_x: point, to_y: point, duration_ms: z.number().int().min(100).max(2000).default(300) }).strict(),
    z.object({ type: z.literal('scroll'), x: point, y: point, to_x: point, to_y: point, duration_ms: z.number().int().min(100).max(2000).default(300) }).strict(),
    z.object({ type: z.literal('key'), key: z.enum(['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL']) }).strict(),
    z.object({ type: z.literal('text'), text: z.string().min(1).max(4096), mode: z.enum(['append', 'replace']) }).strict()
  ]) }).strict(),
  phone_display: z.object({ ...auth, action: z.enum(['physical_off', 'wake']), observation: observationMode }).strict(),
  phone_recover: z.object({ ...auth, action: z.enum(['check', 'reconnect', 'wake']), observation: observationMode }).strict()
};
export type PhoneTool = keyof typeof phoneSchemas;
type Lease = { hash: string; expires: number; epoch: string };
const leaseSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().finite().nonnegative(), epoch: z.string().min(1) }).strict();
type Frame = { frame_id: string; timestamp: string; at: number; package: string | null; window: string; rotation: number; width: number; height: number; hash?: string; visual?: VisualSignature; ui_proof?: UiProof; input_focus?: string };
type Request = { fingerprint: string; lease_hash: string; state: 'pending' | 'completed'; result?: unknown };
const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

export class PhoneService {
  readonly store: PhoneStore;
  private apps: { at: number; packages: string[] } | undefined;
  private faults: { at: string; code: string }[] = [];
  private fault(code: string) {
    this.faults.push({ at: new Date(this.now()).toISOString(), code });
    this.faults = this.faults.slice(-20);
  }
  constructor(readonly config: PhoneConfig, private adb: Adb, private now = Date.now,
    private panel: PhonePanel | undefined = config.scrcpy_path ? new ScrcpyPanel(config) : undefined,
    private automation: PhoneAutomation | undefined = config.appium_url ? new AppiumAutomation(config) : undefined) { this.store = new PhoneStore(config.state_dir); }
  private async shell(...args: string[]) { return (await this.adb.run(['shell', ...args])).toString('utf8'); }
  private async epoch() {
    const epoch = await this.store.read<unknown>('epoch.json');
    if (epoch === undefined) return 'initial';
    if (typeof epoch !== 'string' || !/^[a-f0-9]{64}$/.test(epoch)) throw new Error('PHONE_STATE_CORRUPT');
    return epoch;
  }
  private async readLease(): Promise<Lease | undefined> {
    const raw = await this.store.read<unknown>('lease.json');
    if (raw === undefined || raw === null) return;
    const result = leaseSchema.safeParse(raw);
    if (!result.success) throw new Error('PHONE_STATE_CORRUPT');
    return result.data;
  }
  private async lease(key: string) {
    if (await this.store.paused()) throw new Error('PHONE_ADMIN_PAUSED');
    const lease = await this.readLease();
    if (!lease || lease.hash !== digest(key) || lease.expires <= this.now() || lease.epoch !== await this.epoch()) throw new Error('PHONE_LEASE_INVALID');
    return lease;
  }
  private async renew(key: string) { const lease = await this.lease(key); await this.store.save('lease.json', { ...lease, expires: this.now() + this.config.lease_seconds * 1000 }); }
  private async controlled<T>(key: string, operation: () => Promise<T>) {
    return this.store.lock(async () => {
      await this.renew(key);
      let heartbeat = Promise.resolve();
      const timer = setInterval(() => {
        heartbeat = heartbeat.then(() => this.renew(key)).catch(() => {});
      }, Math.min(5000, this.config.lease_seconds * 1000 / 3));
      try { return await operation(); }
      finally { clearInterval(timer); await heartbeat; }
    });
  }
  async assertHostCommandAllowed() {
    // Block all generic commands during control, including shells and wrappers; matching argv alone is bypassable.
    const lease = await this.readLease();
    if (await this.store.paused() || (lease && lease.expires > this.now() && lease.epoch === await this.epoch())) throw new HostError('PHONE_MAINTENANCE_COMMAND_BLOCKED', 'Generic host commands are maintenance authority and are blocked while phone control is leased or paused.');
  }
  async maintenanceCommand<T>(operation: () => Promise<T>): Promise<T> {
    return this.store.lock(async () => { await this.assertHostCommandAllowed(); return operation(); });
  }
  private async context() {
    // Fixed shell program, no caller-controlled interpolation. One bounded process per context.
    const w = await this.shell('dumpsys window; wm size');
    const focus = /mCurrentFocus=(Window\{[^\r\n}]+\})/.exec(w)?.[1];
    const packageName = focus ? /\s([A-Za-z][\w.]*)\//.exec(focus)?.[1] ?? null : null;
    const degrees = /mRotation=ROTATION_(0|90|180|270)\b/.exec(w)?.[1];
    const rawRotation = /(?:mRotation|rotation)=([0-3])\b/.exec(w)?.[1];
    const size = /Physical size: (\d+)x(\d+)/.exec(w);
    const override = /Override size: (\d+)x(\d+)/.exec(w);
    if ((degrees === undefined && rawRotation === undefined) || !packageName || !size || !focus) throw new Error('PHONE_DISPLAY_CONTEXT_UNKNOWN');
    if (override && (override[1] !== size[1] || override[2] !== size[2])) throw new Error('PHONE_DISPLAY_OVERRIDE_UNSUPPORTED');
    const rotation = degrees === undefined ? Number(rawRotation) : Number(degrees) / 90;
    return { package: packageName, window: digest(focus), rotation, width: Number(size[rotation % 2 ? 2 : 1]), height: Number(size[rotation % 2 ? 1 : 2]) };
  }
  private async readUi(context: Awaited<ReturnType<PhoneService['context']>>) {
    const raw = this.automation ? await this.automation.source() : (await this.adb.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'])).toString('utf8');
    const xml = /((?:<\?xml[^?]*\?>\s*)?<hierarchy[\s\S]*?<\/hierarchy>)/.exec(raw)?.[1];
    if (!xml) throw new Error('PHONE_UI_DUMP_FAILED');
    return { xml, snapshot: uiSnapshot(xml, context.package, context.width, context.height) };
  }
  private async inputFocus(packageName: string): Promise<string | undefined> {
    try { return inputFocusProof(await this.shell('dumpsys', 'input_method'), packageName); }
    catch { return undefined; }
  }
  private async capture(ui: boolean, image: boolean | 'auto' = true): Promise<{ frame: Frame; png?: Buffer; ui: unknown; rendered: { width: number; height: number } | null; semantic?: UiSnapshot; reason?: string }> {
    if (!ui && !image) throw new Error('PHONE_OBSERVATION_REQUIRED');
    const before = await this.context();
    let fresh: Awaited<ReturnType<PhoneService['readUi']>> | undefined;
    let reason: string | undefined;
    let uiResult: unknown = { status: 'not_requested' };
    if (ui || image === 'auto') {
      try { fresh = await this.readUi(before); }
      catch (e) {
        if (image !== 'auto') throw e;
        reason = 'ui_unavailable'; uiResult = { status: 'unavailable', trusted: false };
      }
      if (fresh) {
        uiResult = { status: 'fresh', ...(image === true ? {xml:fresh.xml} : {}),
          elements: fresh.snapshot.elements, nodes: fresh.snapshot.nodes, trusted: false };
        if (Buffer.byteLength(JSON.stringify(uiResult)) > 512 * 1024) {
          if (image !== 'auto') throw new Error('PHONE_OBSERVATION_TOO_LARGE');
          fresh = undefined; reason = 'ui_too_large'; uiResult = { status: 'too_large', trusted: false };
        } else if (image === 'auto') reason = imageFallbackReason(fresh.snapshot, before.width, before.height);
      }
    }
    if (image === false || (image === 'auto' && !reason)) {
      if (!fresh) throw new Error('PHONE_UI_DUMP_FAILED');
      const capturedAt = this.now(), focus = await this.inputFocus(before.package), after = await this.context();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
      const frame: Frame = { ...after, frame_id: token(), timestamp: new Date(capturedAt).toISOString(), at: capturedAt, ui_proof: uiProof(fresh.snapshot), ...(focus ? {input_focus:focus} : {}) };
      await this.store.save('frame.json', frame);
      return { frame, ui: uiResult, semantic: fresh.snapshot, rendered: null, reason: image === 'auto' ? 'ui_sufficient' : 'requested_ui' };
    }
    const png = await this.adb.run(['exec-out', 'screencap', '-p']);
    const capturedAt = this.now();
    if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString() !== 'IHDR') throw new Error('PHONE_SCREENSHOT_FAILED');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384) throw new Error('PHONE_INVALID_PNG');
    if (width !== before.width || height !== before.height) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    const semantic = fresh?.snapshot;
    const focus = await this.inputFocus(before.package), after = await this.context();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    // A full serialized response stays comfortably below the tunnel's 10 MiB limit.
    // Coordinate validation and hashes always use the original physical raster.
    const { default: sharp } = await import('sharp');
    const rgb = await sharp(png, { limitInputPixels: 40_000_000 }).removeAlpha().toColourspace('srgb')
      .timeout({ seconds: 3 }).raw().toBuffer();
    const frame: Frame = { ...after, frame_id: token(), timestamp: new Date(capturedAt).toISOString(), at: capturedAt, width, height,
      visual: visualSignature(rgb, width, height), ...(semantic ? { ui_proof: uiProof(semantic) } : {}), ...(focus ? {input_focus:focus} : {}) };
    const rendered = await sharp(png, { limitInputPixels: 40_000_000 }).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .timeout({ seconds: 3 }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    if (rendered.data.length > 3 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(uiResult)) > 512 * 1024) throw new Error('PHONE_OBSERVATION_TOO_LARGE');
    await this.store.save('frame.json', frame);
    return { frame, png: rendered.data, ui: uiResult, ...(semantic ? { semantic } : {}), rendered: { width: rendered.info.width, height: rendered.info.height }, reason: reason ?? 'requested_image' };
  }
  private async waitUntil(condition: z.infer<typeof waitFor>, image: boolean) {
    const start = performance.now(), deadline = start + condition.timeout_ms;
    let stableSince = start, previous = '', attempts = 0;
    let last: Awaited<ReturnType<PhoneService['capture']>> | undefined;
    do {
      attempts++;
      try {
        const current = await this.capture(true, image);
        last = current;
        const matches = matchesUi(current.semantic!, condition.selector, condition.state === 'enabled');
        const matched = condition.state === 'gone' ? matches.length === 0 : matches.length > 0;
        const signature = JSON.stringify([current.frame.package, current.frame.window, matches]);
        if (!matched || signature !== previous) stableSince = performance.now();
        previous = signature;
        if (matched && performance.now() - stableSince >= condition.stable_ms) {
          return { observation: current, wait: { status: 'matched', attempts, elapsed_ms: Math.round(performance.now() - start) } };
        }
      } catch (e) {
        if (!(e instanceof Error) || !['PHONE_FRAME_CHANGED_DURING_CAPTURE', 'PHONE_DISPLAY_CONTEXT_UNKNOWN'].includes(e.message)) throw e;
        previous = ''; stableSince = performance.now();
      }
      if (performance.now() >= deadline) break;
      await delay(Math.min(150, Math.max(0, deadline - performance.now())));
    } while (performance.now() < deadline);
    if (!last) throw new Error('PHONE_WAIT_OBSERVATION_UNAVAILABLE');
    return { observation: last, wait: { status: 'timeout', attempts, elapsed_ms: Math.round(performance.now() - start) } };
  }
  private observation(o: Awaited<ReturnType<PhoneService['capture']>>, extra: unknown = {}): CallToolResult {
    const { hash: _hash, at: _at, visual: _visual, window: _window, ui_proof: _proof, input_focus: _focus, ...frame } = o.frame;
    return { content: [{ type: 'text', text: JSON.stringify({ ...frame, ui: o.ui, flag_secure: 'unknown', capture_atomic: false,
      rendered: o.rendered, coordinate_space: 'original_physical_pixels',
      observation: { mode: o.png ? 'image' : 'ui', reason: o.reason },
      input_validation: 'No whole-screen pixel comparison or changed-area threshold. tap_element revalidates the target and page anchors. Coordinate tap/long_press protect the target neighborhood; swipe protects its gesture region. Use scroll for ordinary navigation, with context checks only. Text revalidates the focused EditText or active IME connection. Keys use context checks. All paths check fresh window/package/dimensions/rotation.',
      consistency: `${o.png ? 'fresh PNG' : 'fresh UI hierarchy'}; focused window, package, physical dimensions and rotation checked before and after; UI XML has a short collection race; secure regions remain unknown`, result: extra }) },
    ...(o.png ? [{ type: 'image' as const, mimeType: 'image/png', data: o.png.toString('base64') }] : [])] };
  }
  private async status() {
    const probe = async (args: string[]) => { try { return await this.shell(...args); } catch { return null; } };
    let state = 'unknown';
    try {
      const devices = (await this.adb.run(['devices'])).toString();
      state = new RegExp(`^${this.config.serial}\\s+(\\w+)`, 'm').exec(devices)?.[1] ?? 'disconnected';
    } catch { /* bounded probe, no guessed authorization */ }
    const battery = state === 'device' ? await probe(['dumpsys', 'battery']) : null;
    const number = (pattern: RegExp) => { const match = battery?.match(pattern); return match ? Number(match[1]) : null; };
    const level = number(/level:\s*(\d+)/), scale = number(/scale:\s*(\d+)/), chargingStatus = number(/status:\s*(\d+)/);
    const memory = state === 'device' ? await probe(['cat', '/proc/meminfo']) : null;
    const disk = state === 'device' ? await probe(['df', '-k', '/data']) : null;
    const display = state === 'device' ? await probe(['dumpsys', 'power']) : null;
    const size = state === 'device' ? await probe(['wm', 'size']) : null;
    const surface = state === 'device' && this.panel ? await probe(['dumpsys', 'SurfaceFlinger']) : null;
    const physicalSize = size ? /Physical size: (\d+)x(\d+)/.exec(size) : null;
    return { hostname: hostname(), service_version: VERSION, phone_protocol_version: '1', input_validation_version: 'action-target-v3', capabilities: Object.keys(phoneSchemas),
      semantic_input: { observe: { ui: true, image: false }, action: 'tap_element', target: 'element_id from fresh ui.elements; identify by text/resource_id/description', post_action_observation_retries: 2,
        touch_backend: this.automation ? 'appium_uiautomator2' : 'adb', condition_wait: true,
        scroll_backend: this.automation?.resolveScrollTarget ? 'innermost_scrollable_then_touch' : 'touch',
        scroll_variation: { duration_percent: 8, native_distance_percent: 3, added_pause_ms: 0 },
        post_action_observation: 'auto_ui_with_image_fallback' },
      tunnel_status: 'unknown', adb: { serial: this.config.serial, state }, first_unlock: 'unknown',
      battery: { percent: level !== null && scale !== null && scale > 0 ? level * 100 / scale : null,
        charging: chargingStatus === 2 ? true : chargingStatus !== null && [3, 4, 5].includes(chargingStatus) ? false : null,
        external_power: battery && /(?:AC|USB|Wireless) powered: (true|false)/.test(battery) ? /(?:AC|USB|Wireless) powered: true/.test(battery) : null,
        temperature_celsius: number(/temperature:\s*(-?\d+)/) === null ? null : number(/temperature:\s*(-?\d+)/)! / 10 },
      memory: memory ? { status: 'reported', mem_total_kib: /MemTotal:\s*(\d+)/.exec(memory)?.[1] ?? null, mem_available_kib: /MemAvailable:\s*(\d+)/.exec(memory)?.[1] ?? null } : null,
      disk: disk ? { status: 'reported', data_df_kib: disk.slice(0, 2048) } : null,
      display: { wakefulness: display ? /mWakefulness=(\w+)/.exec(display)?.[1] ?? 'unknown' : 'unknown', physical_off_supported: !!this.panel,
        dark_on_automatic_wake: !!this.config.dark_on_wake,
        physical_width: physicalSize ? Number(physicalSize[1]) : null, physical_height: physicalSize ? Number(physicalSize[2]) : null,
        rotation: 'unknown; available in a fresh observation', physical_panel_state: surface ? physicalPanelState(surface) : 'unknown' },
      admin_paused: await this.store.paused(), recent_faults: this.faults };
  }
  private async listApps(args: z.infer<typeof phoneSchemas.phone_list_apps>) {
    if (!this.apps || args.refresh || this.now() - this.apps.at > 60000) {
      const output = await this.shell('cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER');
      if (/Error|Exception|Unknown command/.test(output)) throw new Error('PHONE_APP_QUERY_FAILED');
      this.apps = { at: this.now(), packages: [...new Set(output.split(/\r?\n/).map(s => s.trim().split('/')[0] ?? '').filter(s => pkg.safeParse(s).success))].sort() };
    }
    const matches = this.apps.packages.filter(p => p.toLowerCase().includes(args.search.toLowerCase()));
    return json({ packages: matches.slice(args.offset, args.offset + args.limit), total: matches.length, cached_at: this.apps.at });
  }
  private async write(name: PhoneTool, args: Record<string, unknown>) {
    const key = args.lease_id as string, requestId = args.request_id as string;
    const file = `request-${digest(requestId)}.json`, fingerprint = createHmac('sha256', key).update(JSON.stringify({
      name, ...args, lease_id: undefined, ...(args.observation === 'auto' ? {observation:undefined} : {})
    })).digest('hex');
    // Check the durable receipt even if a crashed process left the operation lock behind.
    const previous = await this.store.read<Request>(file);
    if (previous) {
      if (previous.lease_hash !== digest(key) || previous.fingerprint !== fingerprint) throw new Error('PHONE_REQUEST_CONFLICT');
      return json({ request_id: requestId, status: previous.state === 'pending' ? 'outcome_unknown' : 'completed', replayed: true,
        result: previous.result, observation: 'not_replayed; call phone_observe for a fresh frame' });
    }
    return this.controlled(key, async () => {
      if ((await readdir(this.store.dir)).filter(n => n.startsWith('request-')).length >= 10000) throw new Error('PHONE_JOURNAL_FULL');
      // The lock serializes reads as well as writes to the device and the journal.
      if (await this.store.read(file)) throw new Error('PHONE_REQUEST_RETRY');
      const completedWithoutDispatch = async (result: unknown) => {
        await this.store.save(file, { fingerprint, lease_hash: digest(key), state: 'completed', result });
        return json(result);
      };
      let command: string[] | undefined;
      let gesture: TouchPlan | undefined;
      let turnPanelOff = false;
      let inputValidation: 'stable_target_region' | 'stable_gesture_region' | 'fresh_ui_target' | 'fresh_ui_text_target' | 'fresh_input_connection' | 'fresh_context' | undefined;
      if (name === 'phone_input') {
        const input = phoneSchemas.phone_input.parse(args);
        const expected = await this.store.read<Frame>('frame.json');
        if (!expected || expected.frame_id !== input.frame_id || this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
        const a = input.action;
        const scrollDuration = a.type === 'scroll' ? varyScrollDuration(a.duration_ms) : undefined;
        if ('x' in a && (a.x >= expected.width || a.y >= expected.height || ('to_x' in a && (a.to_x >= expected.width || a.to_y >= expected.height)))) throw new Error('PHONE_COORDINATES_OUTSIDE_FRAME');
        if (a.type === 'tap_element' || (a.type === 'text' && expected.ui_proof?.focused_editable_id)) {
          const before = await this.context();
          if (['window', 'package', 'rotation', 'width', 'height'].some(k => before[k as keyof typeof before] !== expected[k as keyof Frame])) throw new Error('PHONE_FRAME_CHANGED');
          const fresh = await this.readUi(before), after = await this.context();
          if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
          if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
          const elementId = a.type === 'tap_element' ? a.element_id : expected.ui_proof!.focused_editable_id!;
          if (a.type === 'text' && uiProof(fresh.snapshot).focused_editable_id !== elementId) throw new Error('PHONE_UI_TEXT_FOCUS_CHANGED');
          const target = resolveUiTarget(expected.ui_proof, fresh.snapshot, elementId);
          inputValidation = a.type === 'text' ? 'fresh_ui_text_target' : 'fresh_ui_target';
          if (a.type !== 'text') {
            if (this.automation) {
              const bounds = fresh.snapshot.elements.find(element => element.element_id === elementId)!.bounds;
              const chosen = touchPoint(bounds);
              gesture = touchGesture(validateTouchPoint(fresh.snapshot, elementId, chosen) ? chosen : [target.x, target.y]);
            } else command = ['input', 'tap', String(target.x), String(target.y)];
          }
        } else {
          const needsImage = a.type === 'tap' || a.type === 'long_press' || a.type === 'swipe';
          if (needsImage && !expected.visual) throw new Error('PHONE_IMAGE_OBSERVATION_REQUIRED');
          const current = needsImage ? (await this.capture(false)).frame : await this.context();
          if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
          if (current.window !== expected.window || current.package !== expected.package || current.rotation !== expected.rotation || current.width !== expected.width || current.height !== expected.height) throw new Error('PHONE_FRAME_CHANGED');
          inputValidation = 'fresh_context';
          if (needsImage) {
            const visual = (current as Frame).visual;
            if (!expected.visual || !visual) throw new Error('PHONE_FRAME_CHANGED');
            const stable = a.type === 'swipe'
              ? stableSwipeTarget(expected.visual, visual, expected.width, expected.height, a.x, a.y, a.to_x, a.to_y)
              : (a.type === 'tap' || a.type === 'long_press') &&
                stableTapTarget(expected.visual, visual, expected.width, expected.height, a.x, a.y);
            if (!stable) throw new Error('PHONE_FRAME_CHANGED');
            inputValidation = a.type === 'swipe' ? 'stable_gesture_region' : 'stable_target_region';
          }
          if (a.type === 'text') {
            if (!expected.input_focus || expected.input_focus !== await this.inputFocus(current.package!)) throw new Error('PHONE_UI_TEXT_FOCUS_CHANGED');
            if (JSON.stringify(current) !== JSON.stringify(await this.context())) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
            inputValidation = 'fresh_input_connection';
          }
          if (this.automation && ['tap', 'long_press', 'swipe', 'scroll'].includes(a.type) && 'x' in a) {
            gesture = a.type === 'swipe' || a.type === 'scroll' ? touchGesture([a.x, a.y], { to: [a.to_x, a.to_y], duration_ms: scrollDuration ?? a.duration_ms })
              : touchGesture([a.x, a.y], a.type === 'long_press' ? { duration_ms: a.duration_ms } : {});
            if (a.type === 'scroll' && this.automation.resolveScrollTarget) {
              const scrollContext = { package: current.package!, window: current.window, rotation: current.rotation, width: current.width, height: current.height };
              let snapshot: UiSnapshot | undefined;
              try { snapshot = (await this.readUi(scrollContext)).snapshot; }
              catch (e) {
                if (!(e instanceof Error) || !['PHONE_UI_DUMP_INVALID', 'PHONE_UI_DUMP_FAILED'].includes(e.message)) throw e;
              }
              const target = snapshot && scrollTarget(snapshot, current.package!, current.width, current.height, [a.x, a.y], [a.to_x, a.to_y]);
              if (target) {
                const elementId = await this.automation.resolveScrollTarget(target.xpath);
                if (elementId) {
                  const scroll = nativeScroll(elementId, target.bounds, [a.x, a.y], [a.to_x, a.to_y], scrollDuration!);
                  if (scroll) gesture.scroll = scroll;
                }
              }
              if (JSON.stringify(await this.context()) !== JSON.stringify(scrollContext)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
              if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
            }
          }
          if (a.type === 'tap') command = ['input', 'tap', String(a.x), String(a.y)];
          else if (a.type === 'long_press') command = ['input', 'swipe', String(a.x), String(a.y), String(a.x), String(a.y), String(a.duration_ms)];
          else if (a.type === 'swipe' || a.type === 'scroll') command = ['input', 'swipe', String(a.x), String(a.y), String(a.to_x), String(a.to_y), String(scrollDuration ?? a.duration_ms)];
          else if (a.type === 'key') command = ['input', 'keyevent', `KEYCODE_${a.key}`];
          if (gesture) command = undefined;
        }
        if (a.type === 'text') {
          if (!this.config.ime_enabled) throw new Error('PHONE_IME_NOT_CONFIGURED');
          if ((await this.shell('settings', 'get', 'secure', 'default_input_method')).trim() !== 'org.workbench.ime/.WorkbenchIme') throw new Error('PHONE_IME_NOT_SELECTED');
          command = ['am', 'broadcast', '-a', 'org.workbench.ime.INPUT', '-p', 'org.workbench.ime', '--es', 'payload', Buffer.from(a.text).toString('base64'), '--es', 'mode', a.mode];
        }
      } else if (name === 'phone_open_app') {
        const output = await this.shell('cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', args.package as string);
        const component = output.trim().split(/\r?\n/).at(-1) ?? '';
        if (!/^[A-Za-z][\w.]*\/[A-Za-z_.][\w.$]*$/.test(component) || component.split('/')[0] !== args.package) throw new Error('PHONE_APP_NOT_LAUNCHABLE');
        command = ['am', 'start', '-n', `'${component}'`];
      } else if (name === 'phone_display') {
        if (args.action === 'physical_off') {
          if (!this.panel) return completedWithoutDispatch({ status: 'unsupported_unverified', physical_screen_off: 'unknown', recovery: 'A locally validated scrcpy panel controller must be configured.' });
          turnPanelOff = true;
        } else command = ['input', 'keyevent', 'KEYCODE_WAKEUP'];
      } else if (args.action === 'check') {
        const status = await this.status();
        return completedWithoutDispatch({ ...status, status: status.adb.state === 'device' ? 'connection_available_first_unlock_unknown' : 'needs_user_action' });
      }
      else if (args.action === 'reconnect') {
        // adb reconnect can affect transport state held by Phone-Host. Probe only in this implementation.
        return completedWithoutDispatch({ status: 'needs_user_action', action: 'Reconnect USB and authorize this OS account on the phone; shared ADB server and Phone-Host remain untouched.', first_unlock: 'unknown' });
      } else command = ['input', 'keyevent', 'KEYCODE_WAKEUP'];
      if (command?.includes('KEYCODE_WAKEUP') && this.config.dark_on_wake) {
        // Do not blank a screen that the user has manually lit while Android is
        // already awake. Restore darkness only after an automatic wake from sleep.
        turnPanelOff = !/mWakefulness=Awake\b/.test(await this.shell('dumpsys', 'power'));
      }
      if (gesture) await this.automation!.ready();
      await this.renew(key);
      const record: Request = { fingerprint, lease_hash: digest(key), state: 'pending' };
      await this.store.save(file, record);
      await this.lease(key); // Local pause revokes the capability before dispatch.
      try {
        const touchResult = gesture ? await this.automation!.perform(gesture) : undefined;
        const output = command ? await this.shell(...command) : '';
        let panelState: 'off' | 'on' | 'unknown' | undefined;
        if (turnPanelOff) {
          if (!this.panel) throw new Error('PHONE_PANEL_NOT_CONFIGURED');
          await this.panel.turnOff();
          panelState = physicalPanelState(await this.shell('dumpsys', 'SurfaceFlinger'));
          if (panelState !== 'off') throw new Error('PHONE_PANEL_OFF_UNCONFIRMED');
        }
        if (name === 'phone_input' && (args.action as {type: string}).type === 'text' && !/result=1\b/.test(output)) throw new Error('PHONE_IME_UNCONFIRMED');
        // Navigation may briefly remove focus or change the window during a
        // screenshot. Retry only reads, never the action or its request ID.
        const waitCondition = args.wait_for ? waitFor.parse(args.wait_for) : undefined;
        const mode = observationMode.parse(args.observation);
        if (!waitCondition) await delay(250);
        let observation: Awaited<ReturnType<PhoneService['capture']>> | undefined;
        let waitResult: { status: string; attempts: number; elapsed_ms: number } | undefined;
        let fallbackReason: string | undefined;
        let observationAttempts = 0;
        if (waitCondition) {
          const started = performance.now();
          try {
            const waited = await this.waitUntil(waitCondition, false);
            observation = waited.observation; waitResult = waited.wait; observationAttempts = waited.wait.attempts;
          } catch (e) {
            if (mode === 'ui') throw e;
            waitResult = { status: 'unavailable', attempts: 0, elapsed_ms: Math.round(performance.now() - started) };
          }
          if (observation) {
            const reason = mode === 'image' ? 'requested_image' : mode === 'auto'
              ? (waitResult?.status === 'timeout' ? 'condition_timeout' : imageFallbackReason(observation.semantic!, observation.frame.width, observation.frame.height)) : undefined;
            if (reason) {
              fallbackReason = reason;
              observation = undefined;
            } else observation.reason = mode === 'auto' ? 'ui_sufficient' : 'requested_ui';
          }
        }
        for (let attempt = 0; !observation && attempt < 3; attempt++) {
          observationAttempts++;
          try {
            observation = fallbackReason ? await this.capture(false)
              : await this.capture(mode !== 'image', mode === 'auto' ? 'auto' : mode === 'image');
            if (fallbackReason) observation.reason = fallbackReason;
            break;
          }
          catch (e) {
            if (!(e instanceof Error) || !['PHONE_FRAME_CHANGED_DURING_CAPTURE', 'PHONE_DISPLAY_CONTEXT_UNKNOWN'].includes(e.message) || attempt === 2) throw e;
            await delay(250 * (attempt + 1));
          }
        }
        if (!observation) throw new Error('PHONE_SCREENSHOT_FAILED');
        const result = { status: 'completed', request_id: requestId, request_sent: true,
          input_validation: inputValidation,
          touch: gesture ? gesture.scroll
            ? { backend: 'appium_uiautomator2', method: 'scrollGesture', direction: gesture.scroll.direction,
                percent: gesture.scroll.percent, speed: gesture.scroll.speed, planned_duration_ms: gesture.duration_ms, can_scroll_more: touchResult?.can_scroll_more }
            : { backend: 'appium_uiautomator2', method: 'pointer_actions', duration_ms: gesture.duration_ms, points: gesture.points } : undefined,
          wait: waitResult,
          observation_attempts: observationAttempts,
          ui_transition: name === 'phone_input' ? 'fresh post-action observation returned; caller must check the intended result' : undefined,
          physical_panel_state: panelState,
          target_app_observed: name === 'phone_open_app' ? observation.frame.package === args.package : undefined };
        await this.store.save(file, { ...record, state: 'completed', result });
        // A paused or expired lease is never silently resurrected.
        await this.renew(key).catch(() => {});
        return this.observation(observation, result);
      } catch {
        this.fault('PHONE_OUTCOME_UNKNOWN');
        return json({ status: 'outcome_unknown', request_id: requestId, observation: 'unavailable; do not repeat under a new request_id' });
      }
    });
  }
  async call(name: PhoneTool, raw: unknown): Promise<CallToolResult> {
    try {
      const args = phoneSchemas[name].parse(raw) as Record<string, unknown>;
      if (['phone_input', 'phone_open_app', 'phone_display', 'phone_recover'].includes(name)) return await this.write(name, args);
      return await this.store.lock(async () => {
        if (name === 'server_status') return json(await this.status());
        if (name === 'phone_observe') {
          if (args.wait_for) {
            const waited = await this.waitUntil(waitFor.parse(args.wait_for), args.image as boolean);
            return this.observation(waited.observation, { wait: waited.wait });
          }
          return this.observation(await this.capture(args.ui as boolean, args.image as boolean));
        }
        if (name === 'phone_list_apps') return this.listApps(phoneSchemas.phone_list_apps.parse(args));
        if (name === 'phone_release_control') {
          const current = await this.readLease();
          if (current?.hash === digest(args.lease_id as string)) await this.store.save('lease.json', null);
          return json({ released: true });
        }
        if (await this.store.paused()) throw new Error('PHONE_ADMIN_PAUSED');
        const current = await this.readLease();
        if (current && current.expires > this.now() && current.epoch === await this.epoch()) return json({ status: 'busy', expires_at: new Date(current.expires).toISOString() });
        const leaseId = token(), expires = this.now() + this.config.lease_seconds * 1000;
        await this.store.save('lease.json', { hash: digest(leaseId), expires, epoch: await this.epoch() });
        return json({ lease_id: leaseId, expires_at: new Date(expires).toISOString(), identity: 'bearer_capability; actual client account unknown' });
      });
    } catch (e) {
      const message = e instanceof Error && /^PHONE_[A-Z_]+$|^ADB_FAILED_OR_TIMEOUT$/.test(e.message) ? e.message : 'PHONE_INVALID_REQUEST_OR_STATE';
      this.fault(message);
      return { isError: true, ...json({ error: message }) };
    }
  }
}
