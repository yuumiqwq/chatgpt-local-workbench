import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import type { PhoneConfig } from './config.js';

export interface PhonePanel { turnOff(): Promise<void> }

// Logical Android wakefulness stays ON while SurfaceFlinger disables the panel.
// Never mistake the scrcpy virtual display's power mode for the physical panel.
export function physicalPanelState(text: string): 'off' | 'on' | 'unknown' {
  const internal = text.split(/(?=^[ \t]*(?:Virtual )?Display \d)/m)
    .filter(block => /^[ \t]*Display \d+[ \t]*\r?\n/.test(block) && /connectionType=Internal\b/.test(block));
  if (internal.length !== 1) return 'unknown';
  const mode = /\bpowerMode=(Off|On)\b/.exec(internal[0]!)?.[1];
  return mode === 'Off' ? 'off' : mode === 'On' ? 'on' : 'unknown';
}

export class ScrcpyPanel implements PhonePanel {
  constructor(private config: PhoneConfig) {}
  turnOff(): Promise<void> {
    if (!this.config.scrcpy_path) return Promise.reject(new Error('PHONE_PANEL_NOT_CONFIGURED'));
    const executable = this.config.scrcpy_path;
    // A separate, one-second control-only client. Existing mirror and Phone-Host
    // remain running. No-cleanup retains only our power-mode change on exit.
    return new Promise((resolve, reject) => execFile(executable, [
      `--serial=${this.config.serial}`, '--no-video', '--no-audio', '--no-window',
      '--no-power-on', '--no-cleanup', '--turn-screen-off', '--time-limit=1'
    ], { cwd: dirname(executable), timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, ADB: this.config.adb_path, ADB_SERVER_SOCKET: 'tcp:localhost:5037' }
    }, error => error ? reject(new Error('PHONE_PANEL_OFF_UNCONFIRMED')) : resolve()));
  }
}
