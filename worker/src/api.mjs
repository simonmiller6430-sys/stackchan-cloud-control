import { headPayload,integer,utf8 } from './protocol.mjs';
// Photo chunks are throttled by the firmware (~20ms each), so a full frame needs
// noticeably more than a control round-trip.
export const PHOTO_TIMEOUT_MS=25000;
export async function authorized(request,env){
  if(!env.APP_TOKEN || env.APP_TOKEN.length<32)return false;
  const actual=request.headers.get('Authorization')??'';
  const expected='Bearer '+env.APP_TOKEN;
  const digest=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',utf8(value)));
  const [a,b]=await Promise.all([digest(actual),digest(expected)]);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export function command(name,data){
  switch(name){
    case 'status':return {cmd:9,payload:new Uint8Array([0])};
    case 'head':return {cmd:2,payload:headPayload(data.yaw,data.pitch,data.time_ms??900)};
    case 'volume':return {cmd:1,payload:new Uint8Array([integer(data.value,0,100)])};
    case 'brightness':return {cmd:8,payload:new Uint8Array([integer(data.value,5,100)])};
    // 固件对 cmd 1/3/8/9/10 只接受 36 字节报文, 所以无数据命令也带 1 字节占位载荷。
    case 'photo':return {cmd:10,payload:new Uint8Array([0])};
    case 'gesture':{const gestures={nod:1,shake:2,tilt:3,center:4,release:5};if(typeof data.name!=='string'||!Object.hasOwn(gestures,data.name))throw new Error('invalid_gesture');return {cmd:3,payload:new Uint8Array([gestures[data.name]])};}
    default:throw new Error('unknown_command');
  }
}
export function json(value,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
