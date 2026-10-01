const encoder = new TextEncoder();
export const utf8 = value => encoder.encode(value);
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let offset=0; for (const p of parts) { out.set(p,offset); offset+=p.length; } return out;
}
export function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('invalid_range');
  return value;
}
export function headPayload(yaw,pitch,time) {
  integer(yaw,-128,128); integer(pitch,5,85); integer(time,100,5000);
  const out=new Uint8Array(6), view=new DataView(out.buffer);
  view.setInt16(0,yaw);view.setInt16(2,pitch);view.setUint16(4,time);return out;
}
export async function controlPacket(cmd,payload,secret,options={}) {
  if (!secret) throw new Error('not_provisioned');
  const id=options.id??crypto.getRandomValues(new Uint8Array(4));
  const nonce=options.nonce??crypto.getRandomValues(new Uint8Array(8));
  const header=new Uint8Array(11);header.set([5,cmd===2?2:1,cmd]);header.set(id,3);
  new DataView(header.buffer).setUint32(7,options.time??Math.floor(Date.now()/1000));
  const body=concat(header,payload,nonce);
  const key=await crypto.subtle.importKey('raw',utf8(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,body));
  return concat(body,signature.slice(0,16));
}
export const requestId = packet => [...packet.slice(3,7)].map(x=>x.toString(16).padStart(2,'0')).join('');
export function mqttPacket(header,body=new Uint8Array()) {
  let n=body.length;const length=[];
  do {let digit=n%128;n=Math.floor(n/128);if(n)digit|=128;length.push(digit);}while(n);
  return concat(new Uint8Array([header,...length]),body);
}
export function mqttString(value) {
  const b=utf8(value); if(b.length>65535)throw new Error('mqtt_string_too_large');
  return concat(new Uint8Array([b.length>>8,b.length&255]),b);
}
export class MqttDecoder {
  constructor(){this.buffer=new Uint8Array();}
  push(bytes){
    this.buffer=concat(this.buffer,bytes);const result=[];
    if(this.buffer.length>600000)throw new Error('mqtt_packet_too_large');
    while(this.buffer.length>=2){
      let size=0,multiplier=1,index=1,digit;
      do {if(index>=this.buffer.length)return result;digit=this.buffer[index++];size+=(digit&127)*multiplier;multiplier*=128;if(index>5)throw new Error('mqtt_length_invalid');}while(digit&128);
      if(size>550000)throw new Error('mqtt_packet_too_large');
      if(this.buffer.length<index+size)break;
      result.push({type:this.buffer[0]>>4,flags:this.buffer[0]&15,body:this.buffer.slice(index,index+size)});
      this.buffer=this.buffer.slice(index+size);
    }return result;
  }
}
export class PhotoAssembler {
  // Decrypted firmware packets keep the original envelope: [type][seq:2][data...]
  //   1 = header (w:2, h:2)   2 = chunk   3 = end (total:4)
  constructor(){this.chunks=new Map();this.total=0;this.done=false;this.width=0;this.height=0;this.bytes=0;}
  push(p){
    if(p.length<1)throw new Error('photo_packet_invalid');
    if(p.length>7003)throw new Error('photo_too_large');
    if(p[0]===1&&p.length>=5){this.width=p[1]*256+p[2];this.height=p[3]*256+p[4];}
    else if(p[0]===2&&p.length>=3){
      const seq=p[1]*256+p[2];if(seq>4096)throw new Error('photo_too_large');
      const previous=this.chunks.get(seq),chunk=p.slice(3);
      if(previous){
        if(previous.length!==chunk.length||previous.some((value,i)=>value!==chunk[i]))throw new Error('photo_packet_invalid');
      }else{this.chunks.set(seq,chunk);this.bytes+=chunk.length;}
    }
    else if(p[0]===3&&p.length>=5){this.done=true;this.total=new DataView(p.buffer,p.byteOffset,p.byteLength).getUint32(1);if(this.total>500000)throw new Error('photo_too_large');}
    else return;
    if(this.bytes>500000)throw new Error('photo_too_large');
  }
  result(){
    if(!this.done||!this.total)return null;
    const keys=[...this.chunks.keys()].sort((a,b)=>a-b);
    if(keys.length===0||keys.some((k,i)=>k!==i))return null;
    const out=concat(...keys.map(k=>this.chunks.get(k)));
    if(out.length!==this.total)return null;
    if(out[0]!==255||out[1]!==216||out[2]!==255||out.at(-2)!==255||out.at(-1)!==217)throw new Error('photo_invalid');
    return out;
  }
}
// Firmware packet: [version=1][request_id:4][counter:4][nonce:12][AES-GCM][tag:16].
// Bound to the request that asked for the photo, so no other subscriber can reuse it.
export async function openPhotoPacket(packet,expectedId,secret){
  if(!secret)throw new Error('photo_not_provisioned');
  if(packet.length<38||packet.length>7100||packet[0]!==1||requestId(concat(new Uint8Array(3),packet.slice(1,5)))!==expectedId)throw new Error('photo_wrong_request');
  const digest=await crypto.subtle.digest('SHA-256',utf8(secret));
  const key=await crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:packet.slice(9,21),additionalData:concat(utf8('stackchan-photo-v1'),packet.slice(0,9)),tagLength:128},key,packet.slice(21));
  return new Uint8Array(plain);
}
