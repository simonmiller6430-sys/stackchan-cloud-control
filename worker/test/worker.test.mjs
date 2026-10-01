import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
test('mobile interface is public but robot API still requires authentication',async()=>{
 const env={ASSETS:{fetch:async()=>new Response('StackChan 手机控制')},APP_TOKEN:'a'.repeat(64)};
 const home=await worker.fetch(new Request('https://unit.test/'),env);
 assert.equal(home.status,200);assert.match(await home.text(),/手机控制/);
 const api=await worker.fetch(new Request('https://unit.test/api/status',{method:'POST'}),env);
 assert.equal(api.status,401);
});
test('photo endpoint is authenticated, POST-only and fails closed without provisioning',async()=>{
 const env={ASSETS:{fetch:async()=>new Response('page')},APP_TOKEN:'a'.repeat(64)};
 const unauthenticated=await worker.fetch(new Request('https://unit.test/api/photo',{method:'POST'}),env);
 assert.equal(unauthenticated.status,401);
 const headers={Authorization:'Bearer '+'a'.repeat(64)};
 const notProvisioned=await worker.fetch(new Request('https://unit.test/api/photo',{method:'POST',headers}),env);
 assert.equal(notProvisioned.status,503);
 const wrongMethod=await worker.fetch(new Request('https://unit.test/api/photo',{method:'GET',headers}),env);
 assert.equal(wrongMethod.status,404);
});
test('healthz reports the camera as encrypted rather than disabled',async()=>{
 const env={};
 const response=await worker.fetch(new Request('https://unit.test/healthz'),env);
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.camera,'encrypted-cmd10');
});
