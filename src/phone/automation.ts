import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhoneConfig } from './config.js';
import type { TouchPlan } from './gestures.js';

export interface PhoneAutomation {
  ready(): Promise<void>;
  source(): Promise<string>;
  perform(plan: TouchPlan): Promise<void>;
}
type Session = { id: string; serial: string; url: string };
class DriverError extends Error { constructor(readonly code: string, readonly detail?: string) { super('PHONE_AUTOMATION_FAILED'); } }
const lostSession = (error: unknown) => error instanceof DriverError && (error.code === 'invalid session id' ||
  (error.code === 'unknown error' && error.detail?.includes('the instrumentation process is not running')));

// Calls are serialized by PhoneStore across local and tunneled MCP processes.
// Session metadata contains no access token and lives in the private phone state.
export class AppiumAutomation implements PhoneAutomation {
  private session: Session | undefined;
  constructor(private config: PhoneConfig, private request: typeof fetch = fetch) {}
  private async discardSession() {
    if (this.session) {
      try { await this.http(`/session/${this.session.id}`, 'DELETE'); } catch { /* already stopped */ }
    }
    this.session = undefined;
    await rm(join(this.config.state_dir, 'appium-session.json'), { force: true });
  }
  private async http(path: string, method = 'GET', body?: unknown, timeout = 12000): Promise<any> {
    let response: Response;
    try {
      response = await this.request(`${this.config.appium_url}${path}`, {
        method, signal: AbortSignal.timeout(timeout), redirect: 'error',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      });
    } catch { throw new Error('PHONE_AUTOMATION_UNAVAILABLE'); }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('PHONE_AUTOMATION_RESPONSE_TOO_LARGE');
    let envelope: any;
    try { envelope = JSON.parse(text); } catch { throw new Error('PHONE_AUTOMATION_INVALID_RESPONSE'); }
    if (!response.ok || envelope.value?.error) throw new DriverError(envelope.value?.error ?? 'unknown error', envelope.value?.message);
    return envelope.value;
  }
  async ready() {
    if (!this.config.appium_url) throw new Error('PHONE_AUTOMATION_NOT_CONFIGURED');
    if (!this.session) {
      try {
        const saved = JSON.parse(await readFile(join(this.config.state_dir, 'appium-session.json'), 'utf8')) as Session;
        if (/^[\w-]{1,128}$/.test(saved.id) && saved.serial === this.config.serial && saved.url === this.config.appium_url) this.session = saved;
      } catch { /* first connection */ }
    }
    if (this.session) {
      try { await this.http(`/session/${this.session.id}/appium/settings`); return; }
      catch (e) {
        if (!lostSession(e)) throw e;
        await this.discardSession();
      }
    }
    const value = await this.http('/session', 'POST', { capabilities: { alwaysMatch: {
      platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': this.config.serial,
      'appium:deviceName': 'Legion HONOR 80', 'appium:noReset': true, 'appium:fullReset': false,
      'appium:autoLaunch': false, 'appium:forceAppLaunch': false, 'appium:shouldTerminateApp': false,
      'appium:skipUnlock': true, 'appium:skipDeviceInitialization': true, 'appium:skipLogcatCapture': true,
      'appium:mockLocationApp': '',
      'appium:suppressKillServer': true, 'appium:adbPort': 5037, 'appium:systemPort': 8205,
      'appium:newCommandTimeout': 0, 'appium:disableWindowAnimation': false,
      'appium:settings[waitForIdleTimeout]': 0, 'appium:settings[waitForSelectorTimeout]': 0
    }, firstMatch: [{}] } }, 45000);
    if (!value || !/^[\w-]{1,128}$/.test(value.sessionId)) throw new Error('PHONE_AUTOMATION_INVALID_RESPONSE');
    this.session = { id: value.sessionId, serial: this.config.serial, url: this.config.appium_url };
    const path = join(this.config.state_dir, 'appium-session.json'), temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.session), { mode: 0o600 });
    await rename(temporary, path);
  }
  async source(): Promise<string> {
    await this.ready();
    let value: unknown;
    try { value = await this.http(`/session/${this.session!.id}/source`); }
    catch (e) {
      if (!lostSession(e)) throw e;
      await this.discardSession();
      await this.ready();
      value = await this.http(`/session/${this.session!.id}/source`);
    }
    if (typeof value !== 'string' || !value.includes('<hierarchy')) throw new Error('PHONE_UI_DUMP_FAILED');
    return value;
  }
  async perform(plan: TouchPlan) {
    // The service prepares the session before recording the write intent.
    // Never recreate a session or replay a gesture after a dispatch error.
    if (!this.session) throw new Error('PHONE_AUTOMATION_NOT_READY');
    await this.http(`/session/${this.session.id}/actions`, 'POST', { actions: plan.actions });
  }
}
