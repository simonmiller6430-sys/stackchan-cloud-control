// Client for the always-on voice relay that owns the typed-chat protocol.
// The relay holds the device control secret; this worker only forwards text and
// polls the job, so the phone never talks to the relay and never sees its token.
const JOB_ID = /^[0-9a-f]{8}$/;

export function relayConfigured(env){
  try{
    const url=new URL(env.RELAY_URL);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&Boolean(env.RELAY_TOKEN&&env.RELAY_TOKEN.length>=32);
  }catch{return false;}
}

export function jobId(value){
  return typeof value==='string'&&JOB_ID.test(value)?value:null;
}

async function callRelay(env,path,{method='GET',body}={}){
  if(!relayConfigured(env))throw new Error('relay_not_configured');
  const base=String(env.RELAY_URL).replace(/\/+$/,'');
  const response=await fetch(base+path,{
    method,
    headers:{Authorization:'Bearer '+env.RELAY_TOKEN,'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(25000),
    redirect:'manual',
  });
  if(response.status>=300&&response.status<400)return {status:502,data:{error:'relay_redirect_blocked'}};
  const text=await response.text();
  let data=null;
  try{data=JSON.parse(text);}catch{data=null;}
  return {status:response.status,data};
}

export async function startChat(env,text,timeoutMs=25000){
  const {status,data}=await callRelay(env,'/chat',{method:'POST',body:{text}});
  if(status>=200&&status<300&&data&&jobId(data.id))return {ok:true,job:data};
  return {ok:false,status,error:(data&&data.error)||`relay_http_${status}`};
}

export async function pollChat(env,id){
  if(!jobId(id))return {ok:false,status:404,error:'unknown_job'};
  const {status,data}=await callRelay(env,`/chat/${id}`);
  if(status>=200&&status<300&&data&&data.id===id)return {ok:true,job:data};
  return {ok:false,status,error:(data&&data.error)||`relay_http_${status}`};
}

export async function cancelChat(env,id){
  if(!jobId(id))return {ok:false,status:404,error:'unknown_job'};
  const {status,data}=await callRelay(env,`/chat/${id}/cancel`,{method:'POST',body:{}});
  if(status>=200&&status<300&&data&&data.id===id)return {ok:true,job:data};
  return {ok:false,status,error:(data&&data.error)||`relay_http_${status}`};
}
