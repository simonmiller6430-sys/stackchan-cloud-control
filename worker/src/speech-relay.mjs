import {relayConfigured,jobId} from './chat-relay.mjs';
import {json} from './api.mjs';
const MAX_BODY=16384;
export function speechRoute(path,method){
  return (path==='/api/speak'&&method==='POST')||(/^\/api\/speak\/[0-9a-f]{8}$/.test(path)&&method==='GET')||(/^\/api\/speak\/[0-9a-f]{8}\/cancel$/.test(path)&&method==='POST');
}
export async function speechBody(request,path){
  if(request.method==='GET')return undefined;
  if(Number(request.headers.get('Content-Length')||0)>MAX_BODY)throw Object.assign(new Error('request_too_large'),{status:413});
  const reader=request.body?.getReader();let size=0,chunks=[];
  if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw Object.assign(new Error('request_too_large'),{status:413});}chunks.push(value);}}finally{reader.releaseLock();}}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)||'{}');}catch{throw Object.assign(new Error('invalid_speech'),{status:400});}
  if(!data||Array.isArray(data)||typeof data!=='object')throw Object.assign(new Error('invalid_speech'),{status:400});
  if(path.endsWith('/cancel'))return {};
  if(typeof data.text!=='string'||[...data.text].length<1||[...data.text].length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(data.text)||(data.idempotency_key!=null&&(typeof data.idempotency_key!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(data.idempotency_key))))throw Object.assign(new Error('invalid_speech'),{status:400});
  return {text:data.text,...(data.idempotency_key==null?{}:{idempotency_key:data.idempotency_key})};
}
export async function handleSpeech(request,env,path){
  if(!speechRoute(path,request.method))return json({error:'not_found'},404);
  if(!relayConfigured(env))return json({error:'speech_not_configured'},503);
  let body;try{body=await speechBody(request,path);}catch(error){return json({error:error.message},error.status||400);}
  try{
    const response=await fetch(String(env.RELAY_URL).replace(/\/+$/,'')+path.replace('/api/speak','/speak'),{method:request.method,headers:{Authorization:'Bearer '+env.RELAY_TOKEN,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(25000)});
    if(response.status>=300&&response.status<400)return json({error:'relay_redirect_blocked'},502);
    let data;try{data=await response.json();}catch{return json({error:'relay_invalid_response'},502);}
    if(response.ok){const expected=path.split('/')[3];if(!jobId(data?.id)||(expected&&data.id!==expected)||!['queued','synthesizing','playing','done','failed','cancelled'].includes(data.status)||typeof data.settled!=='boolean')return json({error:'relay_invalid_response'},502);return json(data,path==='/api/speak'?202:200);}
    return json({error:typeof data?.error==='string'?data.error:'relay_error'},[400,404,409,503].includes(response.status)?response.status:502);
  }catch{return json({error:'relay_unavailable'},502);}
}
