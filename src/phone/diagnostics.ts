import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PhoneStore, token } from './store.js';

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const select = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(key => object(value)[key] !== undefined).map(key => [key, object(value)[key]]));
const numeric = (value: unknown) => Object.fromEntries(Object.entries(object(value)).filter(([, item]) => typeof item === 'number' && Number.isFinite(item)));

export function responseBody(response: CallToolResult): ObjectValue {
  const first = response.content.find(item => item.type === 'text');
  return first?.type === 'text' ? object(JSON.parse(first.text)) : {};
}

function diagnosticResult(value: unknown): ObjectValue {
  const source = object(value), result = select(source, ['status', 'request_id', 'request_sent', 'completed_steps', 'total_steps',
    'active_step', 'stopped_at', 'error', 'observation_error', 'input_validation', 'observation_attempts', 'target_app_observed']);
  if (source.timing) result.timing = numeric(source.timing);
  if (source.wait) result.wait = select(source.wait, ['status', 'attempts', 'elapsed_ms']);
  if (source.touch) result.touch = select(source.touch, ['backend', 'method', 'duration_ms', 'planned_duration_ms', 'can_scroll_more', 'avoided_overlay']);
  if (Array.isArray(source.steps)) result.steps = source.steps.map((step: ObjectValue) => ({
    ...select(step, ['index', 'action', 'status', 'request_sent', 'elapsed_ms', 'settle_after_ms', 'error']),
    ...(step.input_wait ? { input_wait: select(step.input_wait, ['status', 'attempts', 'elapsed_ms']) } : {}),
    ...(step.result ? { result: diagnosticResult(step.result) } : {})
  }));
  return result;
}

export function compactResponse(response: CallToolResult): CallToolResult {
  const body = responseBody(response);
  for (const key of ['input_validation', 'consistency', 'capture_atomic']) delete body[key];
  if (body.ui?.xml !== undefined) { body.ui = { ...body.ui }; delete body.ui.xml; }
  if (body.result && typeof body.result === 'object') {
    body.result = { ...body.result };
    delete body.result.ui_transition;
    if (body.result.touch) {
      body.result.touch = { ...body.result.touch };
      delete body.result.touch.points;
    }
    if (Array.isArray(body.result.steps)) {
      const failed = body.result.steps.filter((step: ObjectValue) => step.status !== 'completed');
      delete body.result.steps;
      if (failed.length) body.result.failed_steps = failed.map((step: ObjectValue) => ({
        ...select(step, ['index', 'action', 'status', 'request_sent', 'error']),
        ...(step.result?.wait ? { wait: select(step.result.wait, ['status']) } : {})
      }));
    }
  }
  return { ...response, content: [{ type: 'text', text: JSON.stringify(body) }, ...response.content.filter(item => item.type !== 'text')] };
}

export class PhoneDiagnostics {
  private connection = token();
  private previousEnd: number | undefined;
  private store: PhoneStore;
  constructor(stateDir: string, private maxBytes = 2 * 1024 * 1024) { this.store = new PhoneStore(join(stateDir, 'diagnostics')); }

  async record(name: string, requestId: unknown, started: number, duration: number, response: CallToolResult) {
    const ended = Date.now(), traceId = token(), body = responseBody(response);
    const entry = { trace_id: traceId, connection_id: this.connection, tool: name,
      request_id: typeof requestId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(requestId) ? requestId : undefined,
      started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString(), duration_ms: duration,
      idle_before_ms: this.previousEnd === undefined ? undefined : Math.max(0, started - this.previousEnd),
      status: body.error ? 'error' : body.result?.status ?? body.status ?? 'completed', error: body.error,
      replayed: body.replayed === true || undefined, result: diagnosticResult(body.result),
      observation: select(body.observation, ['mode', 'reason']),
      image_count: response.content.filter(item => item.type === 'image').length,
      response_text_bytes: response.content.reduce((sum, item) => sum + (item.type === 'text' ? Buffer.byteLength(item.text) : 0), 0) };
    let recorded = false;
    try {
      await mkdir(this.store.dir, { recursive: true });
      const line = JSON.stringify(entry) + '\n';
      for (let attempt = 0; ; attempt++) {
        try {
          await this.store.lock(async () => {
            const path = join(this.store.dir, 'calls.jsonl');
            const size = await stat(path).then(value => value.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
            if (size && size + Buffer.byteLength(line) > this.maxBytes) {
              await rm(join(this.store.dir, 'calls.previous.jsonl'), { force: true });
              await rename(path, join(this.store.dir, 'calls.previous.jsonl'));
            }
            await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
          });
          recorded = true; break;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'PHONE_BUSY_OR_ABANDONED_LOCK' || attempt >= 4) throw error;
          await delay(10);
        }
      }
    } catch { /* A diagnostic write failure must not change an already dispatched action. */ }
    this.previousEnd = Date.now();
    return { trace_id: traceId, recorded, duration_ms: duration };
  }
}
