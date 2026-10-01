const $=id=>document.getElementById(id);
let token='',yaw=0,pitch=45,busy=false,snapping=false,connected=false,live=false,liveTimer=null,snapshotUrl='';
const pairing=new URLSearchParams(location.hash.slice(1)).get('token');
if(pairing){token=pairing;$('token').value=pairing;history.replaceState(null,'',location.pathname);}
const errors={unauthorized:'密钥不正确，请重新输入。',robot_timeout:'机器人没有回应，请检查它的电源与网络。',broker_upgrade_failed:'机器人通信服务暂时不可用。',broker_connection_failed:'机器人通信服务暂时不可用。',broker_disconnected:'通信连接已断开，请重试。',robot_busy:'机器人正在处理另一条指令，请稍后再试。',too_fast:'操作太快，请稍等。',not_provisioned:'设备还未完成绑定。',invalid_command:'这个操作超出了允许范围。',photo_invalid:'收到的照片不完整，请重试。',photo_wrong_request:'照片与本次请求不匹配，已丢弃。',photo_not_provisioned:'设备还未完成绑定。'};
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function controls(){for(const button of document.querySelectorAll('button'))button.disabled=(busy||snapping)||(button.id!=='connect'&&!connected);for(const input of document.querySelectorAll('input[type=range]'))input.disabled=busy||snapping||!connected;}
async function call(name,data={}){
 if(busy)return null;busy=true;controls();message('正在等待机器人，网络波动时会尝试重连…');
 try{
  const res=await fetch('/api/'+name,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(25000)});
  const result=await res.json();if(!res.ok||!result.ok)throw new Error(result.error||result.status||'failed');
  connected=true;$('connection').textContent='机器人已回应';
  if(Number.isFinite(result.yaw))yaw=result.yaw;if(Number.isFinite(result.pitch))pitch=result.pitch;
  $('angles').textContent=`水平 ${yaw}° · 俯仰 ${pitch}°`;
  for(const setting of ['volume','brightness'])if(Number.isFinite(result[setting])){$(setting).value=result[setting];$(setting+'-value').textContent=result[setting]+'%';}
  message('机器人已完成操作。');return result;
 }catch(error){
  if(name==='status'||error.message==='unauthorized'){connected=false;$('connection').textContent='连接未确认';}
  message(errors[error.message]||'连接失败，请检查网络后重试。',true);return null;
 }finally{busy=false;controls();}
}
$('connect').onclick=()=>{token=$('token').value.trim();if(token.length<32){message('请填写完整的连接密钥。',true);return;}call('status');};
$('refresh').onclick=()=>call('status');
$('center').onclick=async()=>{if(await call('head',{yaw:0,pitch:45,time_ms:900})){yaw=0;pitch=45;$('angles').textContent='水平 0° · 俯仰 45°';}};
for(const button of document.querySelectorAll('[data-move]'))button.onclick=async()=>{
 const direction=button.dataset.move;
 const nextYaw=Math.max(-128,Math.min(128,yaw+(direction==='left'?-10:direction==='right'?10:0)));
 const nextPitch=Math.max(5,Math.min(85,pitch+(direction==='up'?10:direction==='down'?-10:0)));
 if(await call('head',{yaw:nextYaw,pitch:nextPitch,time_ms:900})){yaw=nextYaw;pitch=nextPitch;$('angles').textContent=`水平 ${yaw}° · 俯仰 ${pitch}°`;}
};
for(const button of document.querySelectorAll('[data-gesture]'))button.onclick=()=>call('gesture',{name:button.dataset.gesture});
for(const name of ['volume','brightness']){$(name).oninput=()=>$(`${name}-value`).textContent=$(name).value+'%';$(name).onchange=()=>call(name,{value:Number($(name).value)});}

function cameraState(text){$('camera-state').textContent=text;}
async function snap(){
 if(busy||snapping||!connected)return false;
 snapping=true;controls();cameraState('正在拍照…');message('机器人正在拍照并加密回传…');
 try{
  const res=await fetch('/api/photo',{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(45000)});
  if(!res.ok){let detail='';try{detail=(await res.json()).error||'';}catch{}throw new Error(detail||'snapshot_failed');}
  const blob=await res.blob();
  if(!blob.size)throw new Error('snapshot_failed');
  if(snapshotUrl)URL.revokeObjectURL(snapshotUrl);
  snapshotUrl=URL.createObjectURL(blob);
  $('snapshot').src=snapshotUrl;$('snapshot').hidden=false;$('snapshot-hint').hidden=true;
  connected=true;$('connection').textContent='机器人已回应';
  cameraState(`${new Date().toLocaleTimeString('zh-CN',{hour12:false})} 已更新`);
  message('照片已更新。');return true;
 }catch(error){
  if(error.message==='unauthorized'){connected=false;$('connection').textContent='连接未确认';}
  cameraState('拍照失败');message(errors[error.message]||'拍照失败，请检查机器人是否在线后重试。',true);return false;
 }finally{snapping=false;controls();}
}
function stopLive(){if(liveTimer){clearInterval(liveTimer);liveTimer=null;}live=false;$('snap-live').textContent='连续看';$('snap-live').classList.remove('live');}
$('snap').onclick=()=>snap();
$('snap-live').onclick=async()=>{
 if(live){stopLive();message('已停止连续画面。');return;}
 live=true;$('snap-live').textContent='停止';$('snap-live').classList.add('live');
 if(await snap())liveTimer=setInterval(()=>{if(!snapping)snap();},5000);
 else stopLive();
};
controls();
if(pairing)call('status');

// ---------------------------------------------------------------- 文字聊天
const chatPhases={preparing:'正在准备语音…',uploading:'正在说给机器人听…',waiting:'小智正在回复…',speaking:'机器人正在播报…',done:'回复已收到',cancelled:'已取消',error:'聊天未完成'};
let chatJob=null,chatPolling=false,chatSending=false,chatRows=null,chatTimer=null;
const chatErrors={chat_not_configured:'中转服务还没配置好。',robot_busy:'机器人正在处理另一条指令，请稍后再试。',unauthorized:'密钥不正确，请重新输入。',not_provisioned:'设备还未完成绑定。'};
function chatState(text){$('chat-state').textContent=text;}
function chatAdd(role,text){
 const row=document.createElement('div');row.className='msg '+(role==='me'?'me':'them');
 const body=document.createElement('div');body.textContent=text;
 const note=document.createElement('small');
 row.append(body,note);$('chat-log').append(row);$('chat-log').scrollTop=$('chat-log').scrollHeight;
 return {row,body,note};
}
function chatControls(){const locked=chatSending||busy||snapping;$('chat-send').disabled=locked||!!chatJob;$('chat-input').disabled=chatSending;$('chat-cancel').disabled=!chatJob;}
function renderChat(job){
 chatState((chatPhases[job.status]||job.status)+(job.error?` · ${job.error}`:''));
 if(chatRows){
  if(job.reply)chatRows.body.textContent=job.reply;
  else if(job.status==='cancelled')chatRows.body.textContent='本轮已取消';
  else if(job.status==='error')chatRows.body.textContent=job.error||'未收到回复';
  if(job.recognized)chatRows.note.textContent='云端识别：'+job.recognized;
 }
 $('chat-log').scrollTop=$('chat-log').scrollHeight;
 if(['done','error','cancelled'].includes(job.status)&&job.settled){
  chatJob=null;chatSending=false;chatControls();
 }
}
async function chatRequest(path,options={}){
 const res=await fetch(path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(30000)});
 let data=null;try{data=await res.json();}catch{}
 if(!res.ok)throw new Error((data&&data.error)||'chat_failed');
 return data;
}
async function chatPoll(){
 if(!chatJob||chatPolling)return;chatPolling=true;
 try{renderChat(await chatRequest('/api/chat/'+chatJob));}
 catch(error){
  if(error.message==='unauthorized'){connected=false;$('connection').textContent='连接未确认';}
  chatState('查询失败，正在重试…');
 }
 finally{chatPolling=false;if(chatJob)chatTimer=setTimeout(chatPoll,900);}
}
async function chatSubmit(){
 const text=$('chat-input').value.trim();
 if(chatJob||chatSending)return;
 if(!text||text.length>300){chatState('请输入 1–300 个字符');return;}
 chatSending=true;chatControls();chatState('正在发送…');
 try{
  const job=await chatRequest('/api/chat',{method:'POST',body:JSON.stringify({text})});
  if($('chat-log').querySelector('.empty'))$('chat-log').textContent='';
  chatAdd('me',text);chatRows=chatAdd('them','等待小智回复…');
  $('chat-input').value='';chatJob=job.id;renderChat(job);
  clearTimeout(chatTimer);chatTimer=setTimeout(chatPoll,400);
 }catch(error){
  chatState(chatErrors[error.message]||'发送失败，请稍后再试。');
  chatJob=null;
 }finally{chatSending=false;chatControls();}
}
$('chat-send').onclick=chatSubmit;
$('chat-input').onkeydown=event=>{
 // 中文输入法选字时 Enter 不能当发送, 否则会发出半截句子
 if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();chatSubmit();}
};
$('chat-cancel').onclick=async()=>{
 if(!chatJob)return;
 const id=chatJob;$('chat-cancel').disabled=true;
 try{renderChat(await chatRequest('/api/chat/'+id+'/cancel',{method:'POST',body:'{}'}));}
 catch(error){chatState(chatErrors[error.message]||'取消失败。');$('chat-cancel').disabled=false;}
};
if(!$('chat-log').children.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='打字发送，机器人会用原来的角色和声音回答。';$('chat-log').append(empty);}
chatControls();
