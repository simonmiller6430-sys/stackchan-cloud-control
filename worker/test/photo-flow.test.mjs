import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv,createHash } from 'node:crypto';
import * as protocol from '../src/protocol.mjs';
import { execute } from '../src/mqtt.mjs';
import { mqttPacket,mqttString,concat,controlPacket,requestId } from '../src/protocol.mjs';

// 固件封装: [version=1][request_id:4][counter:4][nonce:12][AES-GCM][tag:16]
function seal(id,counter,plain){
  const header=Buffer.from('01'+id+counter.toString(16).padStart(8,'0'),'hex'),nonce=Buffer.alloc(12,7);
  const cipher=createCipheriv('aes-256-gcm',createHash('sha256').update('test-secret').digest(),nonce);
  cipher.setAAD(Buffer.concat([Buffer.from('stackchan-photo-v1'),header]));
  return Buffer.concat([header,nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
}
class FakeSocket extends EventTarget {
  constructor(){super();this.sent=[];this.closed=false;}
  accept(){}
  close(){this.closed=true;}
  emit(bytes){this.dispatchEvent(new MessageEvent('message',{data:new Uint8Array(bytes).buffer}));}
  send(bytes){
    this.sent.push(bytes);
    if(bytes[0]===0x10)queueMicrotask(()=>this.emit(mqttPacket(0x20,new Uint8Array([0,0]))));
    if(bytes[0]===0x82)queueMicrotask(()=>this.emit(mqttPacket(0x90,new Uint8Array([0,1,1,1]))));
  }
  publish(topic,payload){this.emit(mqttPacket(0x30,concat(mqttString(topic),new Uint8Array(payload))));}
}
const jpeg=Uint8Array.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]);

test('photo assembler follows the firmware chunk envelope and rejects gaps',()=>{
  assert.equal(typeof protocol.PhotoAssembler,'function');
  const image=new protocol.PhotoAssembler();
  image.push(Uint8Array.from([1,1,64,0,240]));
  image.push(Uint8Array.from([2,0,1,...jpeg.slice(6)]));
  assert.equal(image.result(),null,'missing chunks must not complete an image');
  image.push(Uint8Array.from([2,0,0,...jpeg.slice(0,6)]));
  assert.equal(image.result(),null,'an unfinished frame must not complete');
  image.push(Uint8Array.from([3,0,0,0,jpeg.length]));
  const result=image.result();
  assert.deepEqual([...result],[...jpeg]);
  assert.equal(image.width,320);assert.equal(image.height,240);
});

test('photo assembler tolerates QoS1 retransmission of the same chunk',()=>{
  const image=new protocol.PhotoAssembler();
  image.push(Uint8Array.from([2,0,0,...jpeg]));
  image.push(Uint8Array.from([2,0,0,...jpeg]));
  image.push(Uint8Array.from([3,0,0,0,jpeg.length]));
  assert.deepEqual([...image.result()],[...jpeg]);
});

test('duplicate photo chunks do not consume the frame size budget',()=>{
  const image=new protocol.PhotoAssembler();
  const chunk=Uint8Array.from([2,0,0,...jpeg]);
  for(let i=0;i<50001;i++)image.push(chunk);
  assert.equal(image.bytes,jpeg.length);
  image.push(Uint8Array.from([3,0,0,0,jpeg.length]));
  assert.deepEqual([...image.result()],[...jpeg]);
});

test('photo fails promptly on a matching device busy response without replay',async()=>{
  const packet=await controlPacket(10,new Uint8Array([0]),'test-secret');
  const ws=new FakeSocket();
  ws.send=function(bytes){
    this.sent.push(bytes);
    if(bytes[0]===0x10)queueMicrotask(()=>this.emit(mqttPacket(0x20,new Uint8Array([0,0]))));
    if(bytes[0]===0x82)queueMicrotask(()=>this.emit(mqttPacket(0x90,new Uint8Array(new TextDecoder().decode(bytes).includes('control_ack')?[0,1,1,1]:[0,1,1]))));
    if(bytes[0]===0x30)queueMicrotask(()=>this.publish('unit/device/control_ack',new TextEncoder().encode(JSON.stringify({request_id:requestId(packet),ok:false,status:'busy',cmd:'snap'}))));
  };
  await assert.rejects(execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,photo:true,photoSecret:'test-secret',timeoutMs:100}),/robot_busy/);
  assert.equal(ws.sent.filter(p=>p[0]===0x30).length,1);
});

test('photo assembler rejects a non-JPEG payload and oversized frames',()=>{
  const bad=new protocol.PhotoAssembler();
  const notJpeg=Uint8Array.from([1,2,3,4,5,6,7,8,9,10]);
  bad.push(Uint8Array.from([2,0,0,...notJpeg]));
  bad.push(Uint8Array.from([3,0,0,0,notJpeg.length]));
  assert.throws(()=>bad.result(),/photo_invalid/);
  const short=new protocol.PhotoAssembler();
  short.push(Uint8Array.from([2,0,0,...notJpeg]));
  short.push(Uint8Array.from([3,0,0,0,99]));
  assert.equal(short.result(),null,'incomplete frames never complete');
  const big=new protocol.PhotoAssembler();
  // 固件单包上限: 3 字节块头 + 7000 字节数据; 更大的块一定是伪造或损坏的。
  assert.throws(()=>big.push(Uint8Array.from([2,0,0,...new Uint8Array(7001)])),/photo_too_large/);
});

test('conflicting retransmitted chunks fail instead of silently replacing bytes',()=>{
  const image=new protocol.PhotoAssembler();
  image.push(Uint8Array.from([2,0,0,...jpeg]));
  assert.throws(()=>image.push(Uint8Array.from([2,0,0,1,2,3])),/photo_packet_invalid/);
});

test('photo execute subscribes only to its own request topic and returns decrypted bytes',async()=>{
  const packet=await controlPacket(10,new Uint8Array(),'test-secret');
  const id=requestId(packet);
  const ws=new FakeSocket();
  const original=ws.emit.bind(ws);
  ws.send=function(bytes){
    this.sent.push(bytes);
    if(bytes[0]===0x10)queueMicrotask(()=>original(mqttPacket(0x20,new Uint8Array([0,0]))));
    if(bytes[0]===0x82){
      queueMicrotask(()=>{
        original(mqttPacket(0x90,new Uint8Array([0,1,1,1])));
        original(mqttPacket(0x30,concat(mqttString('unit/device/control_ack'),new TextEncoder().encode(JSON.stringify({request_id:id,ok:true,status:'queued',cmd:'snap'})))));
        // 只有本次请求编号的主题被订阅; 别的编号不能冒充这张照片。
        original(mqttPacket(0x30,concat(mqttString('unit/device/photo_secure/deadbeef'),new Uint8Array(seal('deadbeef',0,Uint8Array.from([1,1,64,0,240]))))));
        original(mqttPacket(0x30,concat(mqttString('unit/device/photo_secure/'+id),new Uint8Array(seal(id,0,Uint8Array.from([1,1,64,0,240]))))));
        original(mqttPacket(0x30,concat(mqttString('unit/device/photo_secure/'+id),new Uint8Array(seal(id,1,Uint8Array.from([2,0,0,...jpeg]))))));
        original(mqttPacket(0x30,concat(mqttString('unit/device/photo_secure/'+id),new Uint8Array(seal(id,2,Uint8Array.from([3,0,0,0,jpeg.length]))))));
      });
    }
  };
  const result=await execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,photo:true,photoSecret:'test-secret',timeoutMs:500});
  assert.deepEqual([...result.bytes],[...jpeg]);
  assert.equal(result.width,320);
  const subscribe=ws.sent.find(p=>p[0]===0x82);
  assert.ok(new TextDecoder().decode(subscribe).includes('unit/device/photo_secure/'+id));
  assert.ok(!new TextDecoder().decode(subscribe).includes('unit/device/photo_secure/+'),'wildcard would accept other requests');
  const control=ws.sent.find(p=>p[0]===0x30);
  assert.ok(new TextDecoder().decode(control).includes('unit/device/control'),'command goes to the signed control topic');
});

test('tampered photo packet settles the operation as an error',async()=>{
  const packet=await controlPacket(10,new Uint8Array(),'test-secret');
  const id=requestId(packet);
  const ws=new FakeSocket();
  const original=ws.emit.bind(ws);
  const tampered=seal(id,1,Uint8Array.from([2,0,0,...jpeg]));tampered[tampered.length-1]^=1;
  ws.send=function(bytes){
    this.sent.push(bytes);
    if(bytes[0]===0x10)queueMicrotask(()=>original(mqttPacket(0x20,new Uint8Array([0,0]))));
    if(bytes[0]===0x82)queueMicrotask(()=>{
      original(mqttPacket(0x90,new Uint8Array([0,1,1,1])));
      original(mqttPacket(0x30,concat(mqttString('unit/device/photo_secure/'+id),new Uint8Array(tampered))));
    });
  };
  await assert.rejects(execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,photo:true,photoSecret:'test-secret',timeoutMs:500}));
  assert.equal(ws.closed,true);
  await new Promise(resolve=>setTimeout(resolve,20));
});
