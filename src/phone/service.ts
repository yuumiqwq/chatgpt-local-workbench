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
import { uiSnapshot, matchesUi, validateTouchPoint, scrollTarget, scrollObservation, type UiSnapshot } from './ui.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AppiumAutomation, type PhoneAutomation } from './automation.js';
import { touchGesture, touchPoint, nativeScroll, varyScrollDuration, scrollPoints, type TouchPlan, type TouchBounds } from './gestures.js';
import { inputFocusProof } from './focus.js';
import { imageFallbackReason } from './observation.js';
import { parseDisplayContext, parseWindowOwner, type DisplayContext, type PhoneContext } from './context.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const pkg = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(200);
const point = z.number().int().min(0).max(16384);
const auth = { lease_id: id, request_id: id };
const observationMode = z.enum(['auto', 'ui', 'image', 'context']).default('auto');
const selector = z.object({ text: z.string().max(500).optional(), resource_id: z.string().max(500).optional(),
  description: z.string().max(500).optional(), class: z.string().max(200).optional() }).strict().refine(value => Object.keys(value).length > 0);
const waitFor = z.object({ selector, state: z.enum(['visible', 'enabled', 'gone']).default('visible'),
  timeout_ms: z.number().int().min(100).max(30000).default(10000), stable_ms: z.number().int().min(0).max(1000).default(200) }).strict();
const phoneAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap_element'), element_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('tap'), x: point, y: point }).strict(),
  z.object({ type: z.literal('long_press'), x: point, y: point, duration_ms: z.number().int().min(400).max(2000).default(600) }).strict(),
  z.object({ type: z.literal('swipe'), x: point, y: point, to_x: point, to_y: point, duration_ms: z.number().int().min(100).max(2000).default(300) }).strict(),
  z.object({ type: z.literal('scroll'), x: point, y: point, to_x: point, to_y: point, duration_ms: z.number().int().min(100).max(2000).default(300) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL']) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4096), mode: z.enum(['append', 'replace']) }).strict()
]);
export const phoneSchemas = {
  server_status: z.object({}).strict(),
  phone_acquire_control: z.object({}).strict(),
  phone_release_control: z.object({ lease_id: id }).strict(),
  phone_observe: z.object({ ui: z.boolean().default(false), image: z.boolean().default(true), wait_for: waitFor.optional() }).strict(),
  phone_list_apps: z.object({ search: z.string().max(100).default(''), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(100).default(50), refresh: z.boolean().default(false) }).strict(),
  phone_open_app: z.object({ ...auth, package: pkg, wait_for: waitFor.optional(), observation: observationMode }).strict(),
  phone_input: z.object({ ...auth, frame_id: id, wait_for: waitFor.optional(), observation: observationMode, action: phoneAction }).strict(),
  phone_sequence: z.object({ ...auth, frame_id: id,
    steps: z.array(z.object({ action: phoneAction, wait_for: waitFor.optional() }).strict()).min(1).max(8)
      .refine(steps => steps.reduce((total, step) => total + (step.wait_for?.timeout_ms ?? 0), 0) <= 30000),
    input_ready_timeout_ms: z.number().int().min(0).max(5000).default(2000),
    settle_ms: z.number().int().min(0).max(2000).default(0), observation: observationMode }).strict(),
  phone_display: z.object({ ...auth, action: z.enum(['physical_off', 'wake']), observation: observationMode }).strict(),
  phone_recover: z.object({ ...auth, action: z.enum(['check', 'reconnect', 'wake']), observation: observationMode }).strict()
};
export type PhoneTool = keyof typeof phoneSchemas;
type Lease = { hash: string; expires: number; epoch: string };
const leaseSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().finite().nonnegative(), epoch: z.string().min(1) }).strict();
type Frame = { frame_id: string; timestamp: string; at: number; package: string | null; window: string; rotation: number; width: number; height: number; targets?: { id: string; point: [number, number] }[]; input_focus?: string; context_only?: true };
type Request = { fingerprint: string; lease_hash: string; state: 'pending' | 'completed'; result?: unknown };
const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const phoneError = (e: unknown) => e instanceof Error && /^PHONE_[A-Z_]+$|^ADB_FAILED_OR_TIMEOUT$/.test(e.message) ? e.message : 'PHONE_INVALID_REQUEST_OR_STATE';
type SequenceStepResult = { index: number; action: string; status: string; request_sent: boolean; elapsed_ms: number;
  input_wait?: { status: string; attempts: number; elapsed_ms: number }; result?: Record<string, unknown>; error?: string };
type SequenceResult = { status: 'running' | 'completed' | 'stopped' | 'outcome_unknown'; request_id: string;
  completed_steps: number; total_steps: number; steps: SequenceStepResult[]; active_step?: number; stopped_at?: number;
  error?: string; observation_error?: string; timing: { total_ms: number; final_observation_ms: number; settle_ms: number } };

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
  private async resolveContext(parsed: DisplayContext): Promise<PhoneContext> {
    const { focus, ...context } = parsed;
    if (context.package) return { ...context, package: context.package };
    // Custom window titles do not identify their owner. Resolve only these cases
    // from the exact window, then verify that the display did not change meanwhile.
    const output = await this.shell('dumpsys window windows; echo __WB_WINDOW_OWNER_CONTEXT__; dumpsys window displays; wm size');
    const parts = output.split(/^__WB_WINDOW_OWNER_CONTEXT__\r?$/m);
    if (parts.length !== 2) throw new Error('PHONE_DISPLAY_CONTEXT_UNKNOWN');
    if (JSON.stringify(parseDisplayContext(parts[1]!)) !== JSON.stringify(parsed)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    return { ...context, package: parseWindowOwner(parts[0]!, focus) };
  }
  private async context() {
    return this.resolveContext(parseDisplayContext(await this.shell('dumpsys window displays; wm size')));
  }
  private async contextAndFocus(before?: PhoneContext) {
    // Fixed programs keep the same read ordering while sharing one ADB process.
    const output = await this.shell(before
      ? 'dumpsys input_method; echo __WB_INPUT_CONTEXT__; dumpsys window displays; wm size'
      : 'dumpsys window displays; wm size; echo __WB_CONTEXT_INPUT__; dumpsys input_method; echo __WB_INPUT_CONTEXT__; dumpsys window displays; wm size');
    const parts = output.split(/^__WB_(?:CONTEXT_INPUT|INPUT_CONTEXT)__\r?$/m);
    if (parts.length !== (before ? 2 : 3)) throw new Error('PHONE_DISPLAY_CONTEXT_UNKNOWN');
    const afterParsed = parseDisplayContext(parts.at(-1)!);
    if (!before && JSON.stringify(parseDisplayContext(parts[0]!)) !== JSON.stringify(afterParsed)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    const after = await this.resolveContext(afterParsed);
    if (before && JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PHONE_FRAME_CHANGED_DURING_CAPTURE');
    return { after, focus: inputFocusProof(parts.at(-2)!, after.package) };
  }
  private async readUi(context: Awaited<ReturnType<PhoneService['context']>>) {
    const raw = this.automation ? await this.automation.source() : (await this.adb.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'])).toString('utf8');
    const xml = /((?:<\?xml[^?]*\?>\s*)?<hierarchy[\s\S]*?<\/hierarchy>)/.exec(raw)?.[1];
    if (!xml) throw new Error('PHONE_UI_DUMP_FAILED');
    return { xml, snapshot: uiSnapshot(xml, context.package, context.width, context.height) };
  }
  private async prepareIme() {
    if (!this.config.ime_enabled) return { status: 'not_configured' };
    const target = 'org.workbench.ime/.WorkbenchIme';
    try {
      if ((await this.shell('settings', 'get', 'secure', 'default_input_method')).trim() === target)
        return { status: 'ready', changed: false };
      const installed = (await this.shell('ime', 'list', '-a', '-s')).trim().split(/\r?\n/);
      if (!installed.includes(target)) return { status: 'unavailable', error: 'PHONE_IME_NOT_INSTALLED' };
      const enabled = (await this.shell('settings', 'get', 'secure', 'enabled_input_methods')).trim().split(':').map(value => value.split(';')[0]);
      if (!enabled.includes(target)) await this.shell('ime', 'enable', target);
      await this.shell('ime', 'set', target);
      // Switching is acknowledged before subsequent observations establish focus.
      for (let attempt = 0; attempt < 4; attempt++) {
        if ((await this.shell('settings', 'get', 'secure', 'default_input_method')).trim() === target)
          return { status: 'ready', changed: true };
        if (attempt < 3) await delay(100);
      }
      return { status: 'unavailable', error: 'PHONE_IME_SELECTION_UNCONFIRMED' };
    } catch {
      return { status: 'unavailable', error: 'PHONE_IME_PREPARATION_FAILED' };
    }
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
    // Store only opaque IDs and coordinates from the observation. Input consumes
    // these targets directly; page text, subtree and pixel equality are not gates.
    const targets = fresh?.snapshot.elements.map(element => {
      const center: [number, number] = [Math.floor((element.bounds[0]+element.bounds[2])/2), Math.floor((element.bounds[1]+element.bounds[3])/2)];
      const chosen = this.automation ? touchPoint(element.bounds) : center;
      return {id:element.element_id,point:validateTouchPoint(fresh!.snapshot,element.element_id,chosen) ? chosen : center};
    });
    if (image === false || (image === 'auto' && !reason)) {
      if (!fresh) throw new Error('PHONE_UI_DUMP_FAILED');
      const capturedAt = this.now(), {focus, after} = await this.contextAndFocus(before);
      const frame: Frame = { ...after, frame_id: token(), timestamp: new Date(capturedAt).toISOString(), at: capturedAt, ...(targets ? {targets} : {}), ...(focus ? {input_focus:focus} : {}) };
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
    // A full serialized response stays comfortably below the tunnel's 10 MiB limit.
    const { default: sharp } = await import('sharp');
    // Encoding does not touch the device; overlap it with the final context read.
    // Settle both jobs before leaving the device lock, including on failure.
    const results = await Promise.allSettled([
      this.contextAndFocus(before),
      sharp(png, { limitInputPixels: 40_000_000 }).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .timeout({ seconds: 3 }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    ]);
    const [contextResult, imageResult] = results;
    if (contextResult.status === 'rejected') throw contextResult.reason;
    if (imageResult.status === 'rejected') throw imageResult.reason;
    const {focus, after} = contextResult.value, rendered = imageResult.value;
    const frame: Frame = { ...after, frame_id: token(), timestamp: new Date(capturedAt).toISOString(), at: capturedAt, width, height,
      ...(targets ? {targets} : {}), ...(focus ? {input_focus:focus} : {}) };
    if (rendered.data.length > 3 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(uiResult)) > 512 * 1024) throw new Error('PHONE_OBSERVATION_TOO_LARGE');
    await this.store.save('frame.json', frame);
    return { frame, png: rendered.data, ui: uiResult, ...(semantic ? { semantic } : {}), rendered: { width: rendered.info.width, height: rendered.info.height }, reason: reason ?? 'requested_image' };
  }
  private async captureContext(): Promise<Awaited<ReturnType<PhoneService['capture']>>> {
    const {focus, after} = await this.contextAndFocus();
    const at = this.now();
    const frame: Frame = { ...after, at, timestamp: new Date(at).toISOString(), frame_id: token(),
      context_only: true, ...(focus ? {input_focus: focus} : {}) };
    await this.store.save('frame.json', frame);
    return { frame, ui: {status:'not_requested'}, rendered: null, reason:'requested_context' };
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
    const { at: _at, window: _window, targets: _targets, input_focus: _focus, ...frame } = o.frame;
    return { content: [{ type: 'text', text: JSON.stringify({ ...frame, ui: o.ui, flag_secure: 'unknown', capture_atomic: false,
      rendered: o.rendered, coordinate_space: 'original_physical_pixels',
      observation: { mode: o.frame.context_only ? 'context' : o.png ? 'image' : 'ui', reason: o.reason,
        input_ready: !!o.frame.input_focus },
      input_validation: 'No pixel, target-region, gesture-region, subtree or page-anchor comparison. tap_element uses coordinates from the referenced observation. Inputs check frame age, window/package/dimensions/rotation and coordinate bounds; text confirms the active IME connection. Lease, pause and request deduplication remain enforced.',
      consistency: `${o.frame.context_only ? 'context only; page content not observed' : o.png ? 'fresh PNG' : 'fresh UI hierarchy'}; focused window, package, physical dimensions and rotation checked before and after; UI XML has a short collection race; secure regions remain unknown`, result: extra }) },
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
    return { hostname: hostname(), service_version: VERSION, phone_protocol_version: '1', input_validation_version: 'context-only-v4', capabilities: Object.keys(phoneSchemas),
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
  private async sequenceTextReady(expected: Frame, key: string, timeout: number, refreshAfterTap = false) {
    const start = performance.now(), deadline = start + timeout;
    let frame = expected, attempts = 0;
    if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
    // An existing connection is verified by write(); waiting must not replace it.
    // Only a proven pre-dispatch focus race following this sequence's tap may
    // request a fresh connection. The original window/context still has to match.
    if (refreshAfterTap) { const { input_focus: _focus, ...unfocused } = expected; frame = unfocused; }
    while (!frame.input_focus && performance.now() < deadline) {
      await this.lease(key);
      const current = await this.captureContext();
      attempts++;
      if (['window', 'package', 'rotation', 'width', 'height'].some(k => current.frame[k as keyof Frame] !== expected[k as keyof Frame]))
        throw new Error('PHONE_FRAME_CHANGED');
      frame = current.frame;
      if (frame.input_focus) break;
      if (performance.now() < deadline) await delay(Math.min(100, deadline - performance.now()));
    }
    return { frame, wait: { status: frame.input_focus ? 'matched' : 'timeout', attempts, elapsed_ms: Math.round(performance.now() - start) } };
  }
  private async sequenceObservation(mode: z.infer<typeof observationMode>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return mode === 'context' ? await this.captureContext() : await this.capture(mode !== 'image', mode === 'auto' ? 'auto' : mode === 'image');
      } catch (e) {
        if (attempt >= 2 || !['PHONE_FRAME_CHANGED_DURING_CAPTURE', 'PHONE_DISPLAY_CONTEXT_UNKNOWN'].includes(phoneError(e))) throw e;
        await delay(100 * (attempt + 1));
      }
    }
  }
  private async sequence(args: z.infer<typeof phoneSchemas.phone_sequence>): Promise<CallToolResult> {
    const started = performance.now(), key = args.lease_id;
    const waitBudget = args.settle_ms + args.steps.reduce((total, step) => total + (step.wait_for?.timeout_ms ?? 0)
      + (step.action.type === 'text' ? args.input_ready_timeout_ms : 0), 0);
    if (waitBudget > 30000) throw new Error('PHONE_SEQUENCE_WAIT_BUDGET_EXCEEDED');
    const file = `request-${digest(args.request_id)}.json`;
    const fingerprint = createHmac('sha256', key).update(JSON.stringify({ name: 'phone_sequence', ...args, lease_id: undefined })).digest('hex');
    const previous = await this.store.read<Request>(file);
    if (previous) {
      if (previous.lease_hash !== digest(key) || previous.fingerprint !== fingerprint) throw new Error('PHONE_REQUEST_CONFLICT');
      const saved = previous.result as SequenceResult | undefined;
      const status = previous.state === 'pending' ? 'outcome_unknown' : saved?.status ?? 'outcome_unknown';
      return json({ request_id: args.request_id, status, replayed: true, result: saved ? { ...saved, status } : undefined,
        observation: 'not_replayed; call phone_observe for a fresh frame' });
    }
    return this.controlled(key, async () => {
      if ((await readdir(this.store.dir)).filter(n => n.startsWith('request-')).length + args.steps.length + 1 > 10000) throw new Error('PHONE_JOURNAL_FULL');
      if (await this.store.read(file)) throw new Error('PHONE_REQUEST_RETRY');
      let frame = await this.store.read<Frame>('frame.json');
      if (!frame || frame.frame_id !== args.frame_id || this.now() - frame.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
      const result: SequenceResult = { status: 'running', request_id: args.request_id, completed_steps: 0, total_steps: args.steps.length, steps: [],
        timing: { total_ms: 0, final_observation_ms: 0, settle_ms: 0 } };
      const save = (state: Request['state']) => this.store.save(file, { fingerprint, lease_hash: digest(key), state, result });
      await save('pending');
      let journalFailed = false;
      const persist = async (state: Request['state']) => {
        try { await save(state); return true; }
        catch {
          journalFailed = true; result.status = 'outcome_unknown'; result.error = 'PHONE_SEQUENCE_JOURNAL_FAILED';
          this.fault(result.error); return false;
        }
      };
      let finalResponse: CallToolResult | undefined;
      for (const [index, step] of args.steps.entries()) {
        result.active_step = index;
        // Persist the next index before any input. A crashed sequence is reported,
        // never resumed automatically, even when its completed child receipts exist.
        if (!await persist('pending')) break;
        const stepStarted = performance.now();
        const progress: SequenceStepResult = { index, action: step.action.type, status: 'stopped', request_sent: false, elapsed_ms: 0 };
        try {
          await this.lease(key);
          const inputStarted = performance.now(), inputDeadline = inputStarted + args.input_ready_timeout_ms;
          if (step.action.type === 'text') {
            if (!this.config.ime_enabled) throw new Error('PHONE_IME_NOT_CONFIGURED');
            const ready = await this.sequenceTextReady(frame, key, args.input_ready_timeout_ms);
            frame = ready.frame; progress.input_wait = ready.wait;
            if (ready.wait.status !== 'matched') throw new Error('PHONE_INPUT_READY_TIMEOUT');
          }
          const last = index === args.steps.length - 1;
          const mode = last && args.settle_ms === 0 && !(args.observation === 'context' && step.wait_for) ? args.observation
            : step.wait_for || args.steps[index + 1]?.action.type === 'tap_element' ? 'ui' : 'context';
          const childRequestId = digest(`phone_sequence:${args.request_id}:${index}`);
          let response: CallToolResult;
          for (;;) {
            try {
              response = await this.write('phone_input', phoneSchemas.phone_input.parse({ lease_id: key,
                request_id: childRequestId, frame_id: frame.frame_id,
                action: step.action, wait_for: step.wait_for, observation: mode }), true);
              break;
            } catch (e) {
              const previousAction = args.steps[index - 1]?.action.type;
              if (phoneError(e) !== 'PHONE_UI_TEXT_FOCUS_CHANGED' || step.action.type !== 'text'
                || !['tap', 'tap_element'].includes(previousAction ?? '')) throw e;
              // This exact rejection occurs before write() journals or dispatches
              // text. An existing receipt must never be replayed as a new attempt.
              if (await this.store.read(`request-${digest(childRequestId)}.json`)) throw new Error('PHONE_OUTCOME_UNKNOWN');
              const remaining = inputDeadline - performance.now();
              if (remaining <= 0) {
                progress.input_wait = { status: 'timeout', attempts: progress.input_wait?.attempts ?? 0,
                  elapsed_ms: Math.round(performance.now() - inputStarted) };
                throw new Error('PHONE_INPUT_READY_TIMEOUT');
              }
              const ready = await this.sequenceTextReady(frame, key, remaining, true);
              frame = ready.frame;
              progress.input_wait = { ...ready.wait, attempts: (progress.input_wait?.attempts ?? 0) + ready.wait.attempts,
                elapsed_ms: Math.round(performance.now() - inputStarted) };
              if (ready.wait.status !== 'matched') throw new Error('PHONE_INPUT_READY_TIMEOUT');
            }
          }
          const first = response.content[0];
          if (first?.type !== 'text') throw new Error('PHONE_SEQUENCE_RESULT_INVALID');
          const body = JSON.parse(first.text) as { frame_id?: string; status?: string; result?: Record<string, unknown> };
          const stepResult = body.result;
          progress.request_sent = stepResult?.request_sent === true || body.status === 'outcome_unknown';
          if (stepResult) progress.result = stepResult;
          // A completed dispatch can still report a wait timeout. Its final frame
          // already describes that failure and does not need another screenshot.
          if (body.frame_id && last && args.settle_ms === 0 && mode === args.observation) {
            finalResponse = response;
            result.timing.final_observation_ms = Number((stepResult?.timing as { observation_ms?: number } | undefined)?.observation_ms ?? 0);
          }
          const wait = stepResult?.wait as { status?: string } | undefined;
          if (body.status === 'outcome_unknown') {
            progress.status = result.status = 'outcome_unknown'; result.error = 'PHONE_OUTCOME_UNKNOWN';
          } else if (stepResult?.status !== 'completed' || !body.frame_id) {
            throw new Error('PHONE_SEQUENCE_RESULT_INVALID');
          } else if (wait && wait.status !== 'matched') {
            progress.status = result.status = 'stopped'; result.error = wait.status === 'timeout' ? 'PHONE_SEQUENCE_WAIT_TIMEOUT' : 'PHONE_SEQUENCE_WAIT_UNAVAILABLE';
          } else {
            const nextFrame = await this.store.read<Frame>('frame.json');
            if (!nextFrame || nextFrame.frame_id !== body.frame_id) throw new Error('PHONE_SEQUENCE_RESULT_INVALID');
            frame = nextFrame; progress.status = 'completed'; result.completed_steps++;
          }
        } catch (e) {
          progress.error = result.error = phoneError(e);
          progress.status = result.status = result.error === 'PHONE_OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'stopped';
          if (result.status === 'outcome_unknown') progress.request_sent = true;
        }
        progress.elapsed_ms = Math.round(performance.now() - stepStarted);
        result.steps.push(progress);
        delete result.active_step;
        if (progress.status !== 'completed') result.stopped_at = index;
        if (!await persist('pending') || progress.status !== 'completed') break;
      }
      if (result.status === 'running') result.status = 'completed';
      if (!finalResponse) {
        const observationStarted = performance.now();
        if (result.status === 'completed' && args.settle_ms) {
          await delay(args.settle_ms); result.timing.settle_ms = args.settle_ms;
        }
        try { finalResponse = this.observation(await this.sequenceObservation(args.observation)); }
        catch (e) {
          result.observation_error = phoneError(e);
          if (result.status === 'completed') { result.status = 'stopped'; result.error = 'PHONE_SEQUENCE_OBSERVATION_FAILED'; }
          try { finalResponse = this.observation(await this.captureContext()); } catch { /* The result still reports every completed step. */ }
        }
        result.timing.final_observation_ms = Math.round(performance.now() - observationStarted) - result.timing.settle_ms;
      }
      result.timing.total_ms = Math.round(performance.now() - started);
      if (!journalFailed) await persist('completed');
      await this.renew(key).catch(() => {});
      if (!finalResponse) return json({ result, observation: 'unavailable; call phone_observe before continuing' });
      const first = finalResponse.content[0];
      if (first?.type !== 'text') throw new Error('PHONE_SEQUENCE_RESULT_INVALID');
      return { content: [{ type: 'text', text: JSON.stringify({ ...JSON.parse(first.text), result }) }, ...finalResponse.content.slice(1)] };
    });
  }
  private async write(name: PhoneTool, args: Record<string, unknown>, lockHeld = false) {
    const started = performance.now();
    if (args.observation === 'context' && args.wait_for) throw new Error('PHONE_CONTEXT_WAIT_UNSUPPORTED');
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
    const operation = async () => {
      if ((await readdir(this.store.dir)).filter(n => n.startsWith('request-')).length >= 10000) throw new Error('PHONE_JOURNAL_FULL');
      // The lock serializes reads as well as writes to the device and the journal.
      if (await this.store.read(file)) throw new Error('PHONE_REQUEST_RETRY');
      const completedWithoutDispatch = async (result: unknown) => {
        await this.store.save(file, { fingerprint, lease_hash: digest(key), state: 'completed', result });
        return json(result);
      };
      let command: string[] | undefined;
      let gesture: TouchPlan | undefined;
      let scrollBefore: UiSnapshot | undefined;
      let scrollRegion: TouchBounds | undefined;
      let scrollHorizontal = false;
      let scrollAvoidedOverlay = false;
      let turnPanelOff = false;
      let inputValidation: 'observed_ui_target' | 'fresh_input_connection' | 'fresh_context' | undefined;
      if (name === 'phone_input') {
        const input = phoneSchemas.phone_input.parse(args);
        const expected = await this.store.read<Frame>('frame.json');
        if (!expected || expected.frame_id !== input.frame_id || this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
        const a = input.action;
        const scrollDuration = a.type === 'scroll' ? varyScrollDuration(a.duration_ms) : undefined;
        if ('x' in a && (a.x >= expected.width || a.y >= expected.height || ('to_x' in a && (a.to_x >= expected.width || a.to_y >= expected.height)))) throw new Error('PHONE_COORDINATES_OUTSIDE_FRAME');
        if (a.type === 'tap_element') {
          const before = await this.context();
          if (['window', 'package', 'rotation', 'width', 'height'].some(k => before[k as keyof typeof before] !== expected[k as keyof Frame])) throw new Error('PHONE_FRAME_CHANGED');
          if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
          const targets = expected.targets?.filter(target => target.id === a.element_id);
          if (!targets || targets.length !== 1) throw new Error('PHONE_UI_TARGET_UNKNOWN_OR_AMBIGUOUS');
          const target = targets[0]!.point;
          inputValidation = 'observed_ui_target';
          if (this.automation) gesture = touchGesture(target);
          else command = ['input', 'tap', String(target[0]), String(target[1])];
        } else {
          const current = await this.context();
          if (this.now() - expected.at > this.config.frame_seconds * 1000) throw new Error('PHONE_FRAME_EXPIRED');
          if (current.window !== expected.window || current.package !== expected.package || current.rotation !== expected.rotation || current.width !== expected.width || current.height !== expected.height) throw new Error('PHONE_FRAME_CHANGED');
          inputValidation = 'fresh_context';
          if (a.type === 'text') {
            if (!expected.input_focus || expected.input_focus !== (await this.contextAndFocus(current)).focus) throw new Error('PHONE_UI_TEXT_FOCUS_CHANGED');
            inputValidation = 'fresh_input_connection';
          }
          if (this.automation && ['tap', 'long_press', 'swipe', 'scroll'].includes(a.type) && 'x' in a) {
            gesture = a.type === 'swipe' || a.type === 'scroll' ? touchGesture([a.x, a.y], { to: [a.to_x, a.to_y], duration_ms: scrollDuration ?? a.duration_ms })
              : touchGesture([a.x, a.y], a.type === 'long_press' ? { duration_ms: a.duration_ms } : {});
            if (a.type === 'scroll') {
              const scrollContext = { package: current.package!, window: current.window, rotation: current.rotation, width: current.width, height: current.height };
              let snapshot: UiSnapshot | undefined;
              try { snapshot = (await this.readUi(scrollContext)).snapshot; }
              catch (e) {
                if (!(e instanceof Error) || !['PHONE_UI_DUMP_INVALID', 'PHONE_UI_DUMP_FAILED'].includes(e.message)) throw e;
              }
              scrollBefore = snapshot;
              scrollRegion = [0,0,current.width,current.height];
              scrollHorizontal = Math.abs(a.to_x-a.x)>Math.abs(a.to_y-a.y);
              const target = snapshot && scrollTarget(snapshot, current.package!, current.width, current.height, [a.x, a.y], [a.to_x, a.to_y]);
              if (target) {
                scrollRegion = target.bounds;
                if (target.gesture_bounds === null) throw new Error('PHONE_SCROLL_AREA_OCCLUDED');
                if (target.gesture_bounds) {
                  const [from,to]=scrollPoints(target.gesture_bounds,[a.x,a.y],[a.to_x,a.to_y]);
                  gesture=touchGesture(from,{to,duration_ms:scrollDuration!});
                  scrollAvoidedOverlay=true;
                } else if (this.automation.resolveScrollTarget) {
                  const elementId = await this.automation.resolveScrollTarget(target.xpath);
                  if (elementId) {
                    const scroll = nativeScroll(elementId, target.bounds, [a.x, a.y], [a.to_x, a.to_y], scrollDuration!);
                    if (scroll) gesture.scroll = scroll;
                  }
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
        const observationStarted = performance.now();
        if (!waitCondition && mode !== 'context') await delay(250);
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
            observation = mode === 'context' ? await this.captureContext() : fallbackReason ? await this.capture(false)
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
            : { backend: 'appium_uiautomator2', method: 'pointer_actions', duration_ms: gesture.duration_ms, points: gesture.points,
                ...(scrollAvoidedOverlay ? {avoided_overlay:true} : {}) } : undefined,
          scroll_observation: name === 'phone_input' && (args.action as {type:string}).type === 'scroll'
            ? scrollObservation(scrollBefore,observation.semantic,scrollRegion,scrollHorizontal) : undefined,
          wait: waitResult,
          observation_attempts: observationAttempts,
          ui_transition: name === 'phone_input' ? mode === 'context'
            ? 'page content deferred; input_ready reports the active IME connection'
            : 'fresh post-action observation returned; caller must check the intended result' : undefined,
          physical_panel_state: panelState,
          target_app_observed: name === 'phone_open_app' ? observation.frame.package === args.package : undefined,
          timing: { before_observation_ms: Math.round(observationStarted-started),
            observation_ms: Math.round(performance.now()-observationStarted),
            total_ms: Math.round(performance.now()-started) } };
        await this.store.save(file, { ...record, state: 'completed', result });
        // A paused or expired lease is never silently resurrected.
        await this.renew(key).catch(() => {});
        return this.observation(observation, result);
      } catch {
        this.fault('PHONE_OUTCOME_UNKNOWN');
        return json({ status: 'outcome_unknown', request_id: requestId, observation: 'unavailable; do not repeat under a new request_id' });
      }
    };
    return lockHeld ? operation() : this.controlled(key, operation);
  }
  async call(name: PhoneTool, raw: unknown): Promise<CallToolResult> {
    try {
      const args = phoneSchemas[name].parse(raw) as Record<string, unknown>;
      if (name === 'phone_sequence') return await this.sequence(phoneSchemas.phone_sequence.parse(args));
      if (['phone_input', 'phone_open_app', 'phone_display', 'phone_recover'].includes(name)) return await this.write(name, args);
      return await this.store.lock(async () => {
        if (name === 'server_status') return json(await this.status());
        if (name === 'phone_observe') {
          if (args.ui === false && args.image === false && !args.wait_for) return this.observation(await this.captureContext());
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
        const textInput = await this.prepareIme();
        const leaseId = token(), expires = this.now() + this.config.lease_seconds * 1000;
        await this.store.save('lease.json', { hash: digest(leaseId), expires, epoch: await this.epoch() });
        return json({ lease_id: leaseId, expires_at: new Date(expires).toISOString(), identity: 'bearer_capability; actual client account unknown', text_input: textInput });
      });
    } catch (e) {
      const message = phoneError(e);
      this.fault(message);
      return { isError: true, ...json({ error: message }) };
    }
  }
}
