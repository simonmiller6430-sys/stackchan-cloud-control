import test from 'node:test';
import assert from 'node:assert/strict';
import * as relay from '../src/chat-relay.mjs';
import worker,{RobotGateway} from '../src/worker.mjs';

const TOKEN='r'.repeat(40);
const ENV={RELAY_URL:'https://relay.example/',RELAY_TOKEN:TOKEN};

function stubFetch(handler){
  const original=globalThis.fetch;
  globalThis.fetch=handler;
  return ()=>{globalThis.fetch=original;};
}

test('relay is only considered configured with both url and a long token',()=>{
  assert.equal(relay.relayConfigured(ENV),true);
  assert.equal(relay.relayConfigured({RELAY_URL:'https://x'}),false);
  assert.equal(relay.relayConfigured({RELAY_TOKEN:TOKEN}),false);
  assert.equal(relay.relayConfigured({RELAY_URL:'https://x',RELAY_TOKEN:'short'}),false);
});

test('job ids must be eight lowercase hex characters',()=>{
  assert.equal(relay.jobId('0123abcd'),'0123abcd');
  for(const bad of ['0123ABCd','0123abc','0123abcde','',null,42,'../etc'])assert.equal(relay.jobId(bad),null);
  // a traversal attempt must never reach the relay
  assert.equal(relay.jobId('../../admin'),null);
});

test('relay rejects insecure URLs before transmitting its token',async()=>{
  let calls=0;
  const restore=stubFetch(async()=>{calls++;return new Response('{}');});
  try{
    for(const url of ['http://relay.example','https://user:password@relay.example','invalid']){
      const env={...ENV,RELAY_URL:url};
      assert.equal(relay.relayConfigured(env),false);
      await assert.rejects(relay.startChat(env,'你好'),/relay_not_configured/);
    }
    assert.equal(calls,0);
  }finally{restore();}
});

test('starting a chat posts the text and accepts a relay job',async()=>{
  const seen=[];
  const restore=stubFetch(async(url,options)=>{
    seen.push({url,options});
    return new Response(JSON.stringify({id:'a1b2c3d4',status:'preparing',settled:false}),{status:200});
  });
  try{
    const result=await relay.startChat(ENV,'你好');
    assert.equal(result.ok,true);assert.equal(result.job.id,'a1b2c3d4');
    assert.equal(seen[0].url,'https://relay.example/chat');
    assert.equal(seen[0].options.method,'POST');
    assert.equal(seen[0].options.redirect,'manual');
    assert.equal(seen[0].options.headers.Authorization,'Bearer '+TOKEN);
    assert.deepEqual(JSON.parse(seen[0].options.body),{text:'你好'});
  }finally{restore();}
});

test('relay redirects are rejected without following the new location',async()=>{
  let calls=0;
  const restore=stubFetch(async()=>{calls++;return new Response('',{status:302,headers:{Location:'https://other.example'}});});
  try{
    const result=await relay.startChat(ENV,'你好');
    assert.equal(result.ok,false);
    assert.equal(result.error,'relay_redirect_blocked');
    assert.equal(calls,1);
  }finally{restore();}
});

test('a busy relay is surfaced as a conflict rather than a generic failure',async()=>{
  const restore=stubFetch(async()=>new Response(JSON.stringify({error:'上一条聊天尚未结束，请等待或取消'}),{status:409}));
  try{
    const result=await relay.startChat(ENV,'第二条');
    assert.equal(result.ok,false);assert.equal(result.status,409);
    assert.match(result.error,/尚未结束/);
  }finally{restore();}
});

test('polling rejects a mismatched job id even if the relay answers 200',async()=>{
  const restore=stubFetch(async()=>new Response(JSON.stringify({id:'ffffffff',status:'done'}),{status:200}));
  try{
    assert.equal((await relay.pollChat(ENV,'a1b2c3d4')).ok,false);
    assert.equal((await relay.pollChat(ENV,'../../etc')).ok,false);
  }finally{restore();}
});

test('healthz reports whether chat is configured',async()=>{
  const without=await worker.fetch(new Request('https://unit.test/healthz'),{});
  assert.equal((await without.json()).chat,'not-configured');
  const withRelay=await worker.fetch(new Request('https://unit.test/healthz'),ENV);
  assert.equal((await withRelay.json()).chat,'relay');
});

test('chat routes require auth, a configured relay and a sane job id',async()=>{
  const headers={Authorization:'Bearer '+'a'.repeat(64)};
  const unauthorized=await worker.fetch(new Request('https://unit.test/api/chat',{method:'POST'}),ENV);
  assert.equal(unauthorized.status,401);

  // authenticated but no relay configured
  const envNoRelay={APP_TOKEN:'a'.repeat(64),ASSETS:{fetch:async()=>new Response('page')}};
  const notConfigured=await worker.fetch(new Request('https://unit.test/api/chat',{method:'POST',headers}),envNoRelay);
  assert.equal(notConfigured.status,503);

  // malformed job id must not reach the relay at all
  let relayCalls=0;
  const restore=stubFetch(async()=>{relayCalls++;return new Response('{}',{status:200});});
  try{
    const env={...ENV,APP_TOKEN:'a'.repeat(64),ROBOT:{get:()=>({fetch:async()=>new Response(JSON.stringify({id:'ffffffff'}),{status:200})})}};
    // A percent-encoded dot segment survives URL normalisation as a literal path part.
    for(const path of ['/api/chat/%2e%2e%2fetc','/api/chat/0123ABCD','/api/chat/0123abcde']){
      const response=await worker.fetch(new Request('https://unit.test'+path,{method:'GET',headers}),env);
      assert.equal(response.status,404,path);
    }
    assert.equal(relayCalls,0,'a malformed id must never be forwarded');
  }finally{restore();}
});

test('relay transport failures return a JSON gateway error',async()=>{
  const restore=stubFetch(async()=>{throw new Error('connection lost');});
  try{
    const gateway=new RobotGateway({},ENV);
    const response=await gateway.fetch(new Request('https://unit.test/api/chat',{method:'POST',body:JSON.stringify({text:'你好'})}));
    assert.equal(response.status,502);
    assert.equal((await response.json()).error,'relay_unavailable');
  }finally{restore();}
});
