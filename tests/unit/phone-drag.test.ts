import assert from 'node:assert/strict';
import test from 'node:test';
import { touchPacket } from '../../src/phone/drag.js';

test('scrcpy finger packets preserve down/move/up and cancel separately', () => {
  for (const action of [0, 2, 1, 3] as const) {
    const bytes = touchPacket(action, { x: 321, y: 1620 }, { width: 1080, height: 2400 });
    assert.equal(bytes.length, 32); assert.equal(bytes[0], 2); assert.equal(bytes[1], action);
    assert.equal(bytes.readBigInt64BE(2), -2n);
    assert.equal(bytes.readInt32BE(10), 321); assert.equal(bytes.readInt32BE(14), 1620);
    assert.equal(bytes.readUInt16BE(18), 1080); assert.equal(bytes.readUInt16BE(20), 2400);
    assert.equal(bytes.readUInt16BE(22), action === 1 || action === 3 ? 0 : 65535);
    assert.equal(bytes.readUInt32BE(24), 0); assert.equal(bytes.readUInt32BE(28), 0);
  }
  assert.throws(() => touchPacket(2, { x: 1080, y: 20 }, { width: 1080, height: 2400 }), /OUTSIDE_FRAME/);
});
