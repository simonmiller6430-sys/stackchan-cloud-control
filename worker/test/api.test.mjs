import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/api.mjs';
test('API denies access without a configured token and rejects mismatched credentials',async()=>{
  assert.equal(typeof api.authorized,'function');
  assert.equal(await api.authorized(new Request('https://unit.test'),{}),false);
  const token='test-token-at-least-32-characters-long';
  assert.equal(await api.authorized(new Request('https://unit.test',{headers:{Authorization:'Bearer bad'}}),{APP_TOKEN:token}),false);
  assert.equal(await api.authorized(new Request('https://unit.test',{headers:{Authorization:'Bearer '+token}}),{APP_TOKEN:token}),true);
});
test('API whitelist rejects unknown commands and invalid settings',()=>{
  assert.equal(typeof api.command,'function');
  assert.equal(api.command('status',{}).cmd,9);
  assert.equal(api.command('head',{yaw:0,pitch:45}).payload.length,6);
  assert.throws(()=>api.command('shell',{}));
  assert.throws(()=>api.command('volume',{value:101}));
  assert.throws(()=>api.command('brightness',{value:0}));
  assert.throws(()=>api.command('gesture',{name:'unknown'}));
  for(const name of ['constructor','toString','__proto__'])assert.throws(()=>api.command('gesture',{name}));
});
test('photo command matches the firmware cmd=10 packet shape',async()=>{
  const {controlPacket}=await import('../src/protocol.mjs');
  const {cmd,payload}=api.command('photo',{});
  assert.equal(cmd,10);
  // 固件对 cmd=10 只接受 36 字节报文: 11 字节头 + 1 字节占位载荷 + 8 字节 nonce + 16 字节 HMAC。
  assert.equal(payload.length,1,'a 35-byte packet is silently dropped by the firmware');
  const packet=await controlPacket(cmd,payload,'test-secret');
  assert.equal(packet.length,36);
  assert.ok(api.PHOTO_TIMEOUT_MS>=20000,'firmware throttles each photo chunk ~20ms');
});
