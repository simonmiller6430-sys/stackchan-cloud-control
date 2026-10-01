import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as protocol from '../src/protocol.mjs';

test('head command rejects unsafe range and packs signed int16 bounds', () => {
  assert.equal(typeof protocol.headPayload, 'function');
  assert.deepEqual([...protocol.headPayload(-128,85,900)], [255,128,0,85,3,132]);
  for (const values of [[129,45,900],[0,0,900],[0,45,99],[NaN,45,900],[0,45.5,900]]) assert.throws(()=>protocol.headPayload(...values));
});
test('control packet matches existing Python HMAC protocol', async () => {
  assert.equal(typeof protocol.controlPacket, 'function');
  const packet = await protocol.controlPacket(2, new Uint8Array([0,0,0,45,3,132]), 'test-secret', {id:new Uint8Array([1,2,3,4]),time:1790484000,nonce:new Uint8Array(8)});
  assert.equal(packet.length,41);
  assert.deepEqual([...packet.slice(0,7)],[5,2,2,1,2,3,4]);
  assert.deepEqual(Buffer.from(packet.slice(-16)),createHmac('sha256','test-secret').update(packet.slice(0,-16)).digest().subarray(0,16));
});
test('MQTT parser handles fragmented and coalesced packets', () => {
  assert.equal(typeof protocol.MqttDecoder, 'function');
  const d = new protocol.MqttDecoder();
  assert.deepEqual(d.push(new Uint8Array([32,2,0])),[]);
  assert.deepEqual(d.push(new Uint8Array([0,208,0])).map(x=>[x.type,[...x.body]]),[[2,[0,0]],[13,[]]]);
});
test('photo assembler deduplicates chunks and waits for missing bytes', () => {
  assert.equal(typeof protocol.PhotoAssembler, 'function');
  const p = new protocol.PhotoAssembler();
  p.push(new Uint8Array([1,1,64,0,240]));
  p.push(new Uint8Array([2,0,0,255,216,255]));
  p.push(new Uint8Array([2,0,0,255,216,255]));
  p.push(new Uint8Array([3,0,0,0,5]));
  assert.equal(p.result(),null);
  p.push(new Uint8Array([1,1,64,0,240]));
  p.push(new Uint8Array([2,0,1,255,217]));
  assert.deepEqual([...p.result()],[255,216,255,255,217]);
});
