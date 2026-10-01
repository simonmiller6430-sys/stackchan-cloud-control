import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 手机页面没有构建步骤, 所以用一个最小 DOM 桩来验证真实脚本的取图流程。
function createPage(fetchImpl,hash=''){
  const ids=['token','connect','connection','angles','message','volume','volume-value','brightness','brightness-value','refresh','center','snap','snap-live','snapshot','snapshot-hint','camera-state','chat-state','chat-input','chat-send','chat-cancel'];
  const nodes={};
  for(const id of ids)nodes[id]={id,textContent:'',value:'',disabled:false,hidden:false,src:'',classList:{toggle(){},add(){},remove(){}},click(){if(this.onclick)return this.onclick();},
    addEventListener(){}};
  const log={children:[],textContent:'',scrollTop:0,scrollHeight:0,
    append(node){this.children.push(node);},
    querySelector(selector){return selector==='.empty'?this.children.find(c=>c.className==='empty')||null:null;}};
  nodes['chat-log']=log;
  const buttons=Object.values(nodes).filter(n=>n.id&&n.id!=='chat-input'&&n.id!=='token'&&n.id!=='message'&&n.id!=='angles'&&n.id!=='connection'&&n.id!=='volume-value'&&n.id!=='brightness-value'&&n.id!=='snapshot'&&n.id!=='snapshot-hint'&&n.id!=='camera-state'&&n.id!=='chat-state'&&n.id!=='chat-log');
  const timers=[];
  const pending=[];
  let timerId=0;
  const context={
    document:{
      getElementById:id=>nodes[id],
      querySelectorAll:selector=>selector==='button'?buttons:[],
      createElement:tag=>({tag,className:'',textContent:'',children:[],append(...kids){this.children.push(...kids);}}),
      addEventListener(){},
    },
    location:{hash,pathname:'/'},history:{replaceState(){}},
    URL:{createObjectURL:()=> 'blob:snapshot',revokeObjectURL(){}},
    AbortSignal,Date,console,queueMicrotask,Object,Number,Math,JSON,String,Blob,URLSearchParams,
    // 聊天轮询用 setTimeout 递归; 捕获回调让测试可以决定性推进, 不依赖真实等待。
    setTimeout:(fn,ms)=>{pending.push({fn,ms});return ++timerId;},
    clearTimeout:id=>{const at=pending.findIndex(t=>t.id===id);if(at>=0)pending.splice(at,1);},
    setInterval:(fn,ms)=>{timers.push(fn);return timers.length;},
    clearInterval:()=>{timers.length=0;},
    fetch:fetchImpl,
  };
  context.window=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);
  return {
    nodes,log,timers,context,pending,
    settle:()=>new Promise(resolve=>setImmediate(resolve)),
    runNextTimer:async()=>{const next=pending.shift();if(!next)return false;await next.fn();return true;},
  };
}

test('pairing auto-connect never leaves the chat input disabled',async()=>{
  let finish;
  const page=createPage(()=>new Promise(resolve=>{finish=resolve;}),'#token='+'t'.repeat(40));
  assert.equal(page.nodes['chat-input'].disabled,false,'typing must be possible while connecting');
  finish({ok:true,json:async()=>({ok:true})});
  await page.settle();
  assert.equal(page.nodes['chat-input'].disabled,false,'typing must remain possible after connecting');
});

test('phone page requests the encrypted snapshot and shows the returned image',async()=>{
  const calls=[];
  const page=createPage(async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/photo')return {ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob([new Uint8Array([1,2,3])])};
    return {ok:true,json:async()=>({ok:true,volume:50,brightness:50})};
  });
  page.nodes.token.value='t'.repeat(40);
  page.nodes.connect.click();
  await page.settle();
  assert.equal(page.nodes.connection.textContent,'机器人已回应');
  page.nodes.snap.click();
  await page.settle();
  const photo=calls.find(c=>c.url==='/api/photo');
  assert.ok(photo,'camera button must call the snapshot endpoint');
  assert.equal(photo.options.method,'POST');
  assert.equal(photo.options.headers.Authorization,'Bearer '+'t'.repeat(40));
  assert.equal(page.nodes.snapshot.src,'blob:snapshot');
  assert.equal(page.nodes.snapshot.hidden,false);
  assert.match(page.nodes['camera-state'].textContent,/已更新/);
});

test('phone page reports an unprovisioned camera without claiming success',async()=>{
  const page=createPage(async(url)=>{
    if(url==='/api/photo')return {ok:false,status:503,json:async()=>({error:'not_provisioned'})};
    return {ok:true,json:async()=>({ok:true})};
  });
  page.nodes.token.value='t'.repeat(40);
  page.nodes.connect.click();await page.settle();
  page.nodes.snap.click();await page.settle();
  assert.equal(page.nodes['camera-state'].textContent,'拍照失败');
  assert.match(page.nodes.message.textContent,/未完成绑定/);
  assert.equal(page.nodes.snapshot.src,'','a failed snapshot must not replace the last image');
});

test('continuous view polls until it is stopped',async()=>{
  let photos=0;
  const page=createPage(async(url)=>{
    if(url==='/api/photo'){photos++;return {ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob([new Uint8Array([1])])};}
    return {ok:true,json:async()=>({ok:true})};
  });
  page.nodes.token.value='t'.repeat(40);
  page.nodes.connect.click();await page.settle();
  page.nodes['snap-live'].click();await page.settle();
  assert.equal(page.nodes['snap-live'].textContent,'停止');
  assert.equal(page.timers.length,1,'live mode must schedule exactly one poller');
  page.timers[0]();await page.settle();
  assert.equal(photos,2);
  page.nodes['snap-live'].click();
  assert.equal(page.nodes['snap-live'].textContent,'连续看');
  assert.equal(page.timers.length,0,'stopping live mode must clear the poller');
});

test('typing a short key never contacts the robot',async()=>{
  let calls=0;
  const page=createPage(async()=>{calls++;return {ok:true,json:async()=>({ok:true})};});
  page.nodes.token.value='short';
  page.nodes.connect.click();
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls,0);
  assert.match(page.nodes.message.textContent,/完整的连接密钥/);
});

test('phone chat sends text, then polls until the reply arrives',async()=>{
  const calls=[];
  let polls=0;
  const page=createPage(async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/chat')return {ok:true,json:async()=>({id:'a1b2c3d4',status:'preparing',settled:false})};
    if(url==='/api/chat/a1b2c3d4'){
      polls++;
      if(polls<2)return {ok:true,json:async()=>({id:'a1b2c3d4',status:'speaking',reply:'正在说',recognized:'你好',settled:false})};
      return {ok:true,json:async()=>({id:'a1b2c3d4',status:'done',reply:'你好呀，我是小艾。',recognized:'你好',settled:true})};
    }
    return {ok:true,json:async()=>({ok:true})};
  });
  page.nodes.token.value='t'.repeat(40);
  page.nodes.connect.click();await page.settle();
  page.nodes['chat-input'].value='你好';
  page.nodes['chat-send'].click();await page.settle();
  const start=calls.find(c=>c.url==='/api/chat'&&c.options.method==='POST');
  assert.ok(start,'chat send must POST to /api/chat');
  assert.deepEqual(JSON.parse(start.options.body),{text:'你好'});
  assert.equal(start.options.headers.Authorization,'Bearer '+'t'.repeat(40));
  assert.equal(page.nodes['chat-input'].value,'','input clears after sending');
  assert.match(page.nodes['chat-state'].textContent,/准备|回复|播报/);
  // poll once (still speaking), then again to pick up the finished reply
  assert.equal(await page.runNextTimer(),true);
  await page.settle();
  assert.equal(await page.runNextTimer(),true);
  await page.settle();
  assert.equal(polls,2);
  assert.equal(page.nodes['chat-state'].textContent,'回复已收到');
  assert.equal(page.nodes['chat-send'].disabled,false,'a settled chat must re-enable sending');
});

test('chat refuses an empty message and an over-long one without calling the cloud',async()=>{
  let calls=0;
  const page=createPage(async()=>{calls++;return {ok:true,json:async()=>({})};});
  page.nodes['chat-input'].value='   ';
  page.nodes['chat-send'].click();
  await page.settle();
  assert.equal(calls,0);
  assert.match(page.nodes['chat-state'].textContent,/1–300/);
  page.nodes['chat-input'].value='字'.repeat(301);
  page.nodes['chat-send'].click();
  await page.settle();
  assert.equal(calls,0);
});

test('a busy robot is reported instead of silently dropping the message',async()=>{
  const page=createPage(async(url)=>{
    if(url==='/api/chat')return {ok:false,status:409,json:async()=>({error:'robot_busy'})};
    return {ok:true,json:async()=>({ok:true})};
  });
  page.nodes.token.value='t'.repeat(40);
  page.nodes.connect.click();await page.settle();
  page.nodes['chat-input'].value='你好';
  page.nodes['chat-send'].click();await page.settle();
  assert.match(page.nodes['chat-state'].textContent,/另一条指令/);
  assert.equal(page.nodes['chat-send'].disabled,false,'a failed send must be retryable');
});

test('cancelling a running chat posts to the cancel route exactly once',async()=>{
  const calls=[];
  const page=createPage(async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/chat')return {ok:true,json:async()=>({id:'a1b2c3d4',status:'waiting',settled:false})};
    if(url.endsWith('/cancel'))return {ok:true,json:async()=>({id:'a1b2c3d4',status:'cancelled',settled:true})};
    return {ok:true,json:async()=>({id:'a1b2c3d4',status:'waiting',settled:false})};
  });
  page.nodes.token.value='t'.repeat(40);
  page.nodes.connect.click();await page.settle();
  page.nodes['chat-input'].value='你好';
  page.nodes['chat-send'].click();await page.settle();
  page.nodes['chat-cancel'].click();await page.settle();
  const cancels=calls.filter(c=>c.url==='/api/chat/a1b2c3d4/cancel');
  assert.equal(cancels.length,1);
  assert.equal(cancels[0].options.method,'POST');
  assert.equal(page.nodes['chat-state'].textContent,'已取消');
  assert.equal(page.nodes['chat-send'].disabled,false);
});
