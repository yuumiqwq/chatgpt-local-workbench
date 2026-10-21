import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { PhoneDiagnostics, compactResponse, responseBody } from '../../src/phone/diagnostics.js';

test('diagnostics rotate bounded files and serialize concurrent writers without storing page content', async t => {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'phone-diagnostics-test-'));
  t.after(async () => { assert.ok(!relative(root, resolve(dir)).startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  const a = new PhoneDiagnostics(dir, 1800), b = new PhoneDiagnostics(dir, 1800);
  const response = { content: [{ type: 'text' as const, text: JSON.stringify({ lease_id: 'secret-bearer', ui: { xml: 'private page' },
    result: { status: 'completed', timing: { total_ms: 5 }, steps: [{ index: 0, action: 'text', status: 'completed', text: 'secret password' }] } }) }] };
  for (let round = 0; round < 5; round++) {
    const results = await Promise.all([a.record('phone_sequence', 'diagnostic-request-01', Date.now(), 5, response), b.record('phone_sequence', 'diagnostic-request-02', Date.now(), 5, response)]);
    assert.ok(results.every(item => item.recorded));
  }
  const files = (await readdir(join(dir, 'diagnostics'))).filter(name => name.endsWith('.jsonl'));
  assert.deepEqual(files.sort(), ['calls.jsonl', 'calls.previous.jsonl']);
  for (const file of files) {
    const data = await readFile(join(dir, 'diagnostics', file), 'utf8'); assert.ok(Buffer.byteLength(data) <= 1800);
    for (const line of data.trim().split('\n')) assert.equal(JSON.parse(line).result.steps[0].action, 'text');
    for (const secret of ['secret-bearer', 'private page', 'secret password']) assert.ok(!data.includes(secret));
  }
});

test('compact observations preserve interaction information and errors while removing verbose detail', () => {
  const response = { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ frame_id: 'frame', coordinate_space: 'original_physical_pixels',
    consistency: 'long explanation', ui: { xml: '<xml/>', elements: [{ element_id: 'target' }] },
    result: { status: 'stopped', completed_steps: 1, error: 'PHONE_SEQUENCE_WAIT_TIMEOUT',
      steps: [{ index: 0, status: 'completed' }, { index: 1, status: 'stopped', request_sent: true, result: { wait: { status: 'timeout' } } }] } }) }] };
  const compact = compactResponse(response), body = responseBody(compact);
  assert.equal(compact.isError, true); assert.equal(body.frame_id, 'frame'); assert.equal(body.ui.elements[0].element_id, 'target');
  assert.equal(body.ui.xml, undefined); assert.equal(body.consistency, undefined); assert.equal(body.result.steps, undefined);
  assert.equal(body.result.failed_steps[0].index, 1); assert.equal(body.result.failed_steps[0].wait.status, 'timeout');
});
