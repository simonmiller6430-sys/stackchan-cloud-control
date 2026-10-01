import { authorized,command,json,PHOTO_TIMEOUT_MS } from './api.mjs';
import { controlPacket } from './protocol.mjs';
import { execute,cloudSocket } from './mqtt.mjs';
import { cancelChat,jobId,pollChat,relayConfigured,startChat } from './chat-relay.mjs';
import {handleSpeech,speechRoute,speechBody} from './speech-relay.mjs';

const CHAT_PATH=/^\/api\/chat(\/[0-9a-f]{8}(\/cancel)?)?$/;

export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(!path.startsWith('/api/')&&path!=='/healthz'&&env.ASSETS)return env.ASSETS.fetch(request);
    if(path==='/healthz'&&request.method==='GET')return json({service:'stackchan-cloud',version:1,configured:!!(env.APP_TOKEN&&env.DEVICE_CONTROL_SECRET&&env.ROBOT_MAC),camera:'encrypted-cmd10',chat:relayConfigured(env)?'relay':'not-configured',speech:relayConfigured(env)?'relay':'not-configured'});
    if(!await authorized(request,env))return json({error:'unauthorized'},401);
    if(path.startsWith('/api/speak')){
      if(!speechRoute(path,request.method))return json({error:'not_found'},404);
      if(!relayConfigured(env))return json({error:'speech_not_configured'},503);
      let data;try{data=await speechBody(request,path);}catch(error){return json({error:error.message},error.status||400);}
      const stub=env.ROBOT.get(env.ROBOT.idFromName('primary'));
      return stub.fetch(new Request(request.url,{method:request.method,body:data===undefined?undefined:JSON.stringify(data)}));
    }
    // 文字聊天由常开中转执行, 需要它的登录密钥才算配置完成。
    if(path.startsWith('/api/chat')){
      // 形状不对的聊天路径直接 404, 不落到设备控制分支, 也不会转发给中转。
      if(!CHAT_PATH.test(path))return json({error:'not_found'},404);
      if(!relayConfigured(env))return json({error:'chat_not_configured'},503);
      if(!['GET','POST'].includes(request.method))return json({error:'not_found'},404);
      const stub=env.ROBOT.get(env.ROBOT.idFromName('primary'));
      const body=request.method==='POST'?await request.text():'';
      if(body.length>2048)return json({error:'request_too_large'},413);
      return stub.fetch(new Request(request.url,{method:request.method,body:body||undefined}));
    }
    // 拍照应答是 JPEG 字节流, 不走 JSON 命令校验路径; 方法错误先于配置检查拒绝。
    if(path==='/api/photo'&&request.method!=='POST')return json({error:'not_found'},404);
    if(!env.DEVICE_CONTROL_SECRET||!env.ROBOT_MAC)return json({error:'not_provisioned'},503);
    const stub=env.ROBOT.get(env.ROBOT.idFromName('primary'));
    if(path==='/api/photo')return stub.fetch(new Request(request.url,{method:'POST',body:'{}'}));
    if(request.method!=='POST'||!/^\/api\/(status|head|gesture|volume|brightness)$/.test(path))return json({error:'not_found'},404);
    const contentLength=Number(request.headers.get('Content-Length')??0);
    if(contentLength>2048)return json({error:'request_too_large'},413);
    const body=await request.text();if(body.length>2048)return json({error:'request_too_large'},413);
    let data;
    try{data=JSON.parse(body||'{}');if(!data||Array.isArray(data)||typeof data!=='object')throw new Error();command(path.split('/').at(-1),data);}catch{return json({error:'invalid_command'},400);}
    return stub.fetch(new Request(request.url,{method:'POST',body:JSON.stringify(data)}));
  }
};

function photoResponse(photo){
  return new Response(photo.bytes,{headers:{
    'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'X-Photo-Width':String(photo.width),'X-Photo-Height':String(photo.height),
    'Content-Length':String(photo.bytes.length)}});
}

export class RobotGateway {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.busy=false;this.lastStarted=0;}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/api/speak'))return handleSpeech(request,this.env,path);
    if(path.startsWith('/api/chat')){
      try{return await this.chat(request,path);}
      catch(error){console.error('relay request failed',error.name,error.message);return json({error:'relay_unavailable'},502);}
    }
    if(this.busy)return json({error:'robot_busy'},409);
    if(Date.now()-this.lastStarted<500)return json({error:'too_fast'},429);
    this.busy=true;this.lastStarted=Date.now();
    try{
      const name=path.split('/').at(-1);
      const data=await request.json();
      const {cmd,payload}=command(name,data);
      const secret=this.env.DEVICE_CONTROL_SECRET;
      const packet=await controlPacket(cmd,payload,secret);
      const url=this.env.MQTT_WSS_URL;
      if(!url||!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/mqtt$/.test(url))return json({error:'broker_not_configured'},503);
      const base=(this.env.TOPIC_PREFIX||'stackchan')+'/'+this.env.ROBOT_MAC;
      const result=await execute({socketFactory:cloudSocket,url,base,packet,readOnly:name==='status',photo:name==='photo',photoSecret:secret,timeoutMs:name==='photo'?PHOTO_TIMEOUT_MS:12000});
      if(name==='photo')return photoResponse(result);
      return json({...result,verification:'legacy-unsigned-device-ack'},result.ok?200:502);
    }catch(error){console.error('device_request_failed',JSON.stringify({error:error.message,phase:error.phase,published:error.published,photoBytes:error.photoBytes}));if(error.message==='robot_busy')return json({error:'robot_busy'},409);return json({error:['robot_timeout','broker_connection_failed','broker_disconnected','broker_upgrade_failed','broker_rejected','subscription_rejected','photo_wrong_request','photo_invalid','photo_too_large','photo_packet_invalid','photo_not_provisioned'].includes(error.message)?error.message:'gateway_error'},504);}
    finally{this.busy=false;}
  }

  // 文字聊天的状态由中转保存; DO 只记住 job id, 因此手机每次轮询都在问中转。
  async chat(request,path){
    if(path==='/api/chat'){
      if(request.method!=='POST')return json({error:'not_found'},404);
      let text=null;
      try{const data=JSON.parse((await request.text())||'{}');if(typeof data?.text==='string')text=data.text;}catch{}
      if(text===null)return json({error:'请输入1–300个字符'},400);
      const result=await startChat(this.env,text);
      if(!result.ok)return json({error:result.error},result.status===409?409:502);
      await this.ctx.storage.put('chat:'+result.job.id,Date.now());
      await this.ctx.storage.setAlarm(Date.now()+15*60*1000);
      return json(result.job);
    }
    const parts=path.split('/').filter(Boolean);          // api chat <id> [cancel]
    const id=jobId(parts[2]);
    if(!id)return json({error:'not_found'},404);
    if(parts.length===3){
      if(request.method!=='GET')return json({error:'not_found'},404);
      const result=await pollChat(this.env,id);
      if(!result.ok)return json({error:result.error},result.status===404?404:502);
      return json(result.job);
    }
    if(parts.length===4&&parts[3]==='cancel'){
      if(request.method!=='POST')return json({error:'not_found'},404);
      const result=await cancelChat(this.env,id);
      if(!result.ok)return json({error:result.error},result.status===404?404:502);
      return json(result.job);
    }
    return json({error:'not_found'},404);
  }

  async alarm(){
    const now=Date.now();
    const jobs=await this.ctx.storage.list({prefix:'chat:'});
    const stale=[...jobs.entries()].filter(([,at])=>now-at>15*60*1000).map(([key])=>key);
    for(const key of stale)await this.ctx.storage.delete(key);
    if(jobs.size>stale.length)await this.ctx.storage.setAlarm(now+15*60*1000);
  }
}
