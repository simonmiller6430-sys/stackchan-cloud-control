import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/mqtt.mjs';
import { concat,mqttPacket,mqttString,controlPacket,requestId } from '../src/protocol.mjs';
class FakeSocket extends EventTarget {
 constructor(suback=new Uint8Array([0,1,1])){super();this.suback=suback;this.sent=[];this.closed=false;}
 accept(){}
 close(){this.closed=true;}
 emit(data){this.dispatchEvent(new MessageEvent('message',{data:data.buffer}));}
 send(bytes){
  this.sent.push(bytes);
  if(bytes[0]===0x10)queueMicrotask(()=>this.emit(mqttPacket(0x20,new Uint8Array([0,0]))));
  if(bytes[0]===0x82)queueMicrotask(()=>this.emit(mqttPacket(0x90,this.suback)));
  if(bytes[0]===0x30 && this.answer)queueMicrotask(()=>this.emit(this.answer));
 }
}
test('MQTT waits for subscribe acknowledgement before one publish and closes on matching ACK',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');
 const ws=new FakeSocket();
 const ack=new TextEncoder().encode(JSON.stringify({request_id:requestId(packet),ok:true}));
 ws.answer=mqttPacket(0x30,concat(mqttString('unit/device/control_ack'),ack));
 const result=await execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,timeoutMs:100});
 assert.equal(result.ok,true);assert.equal(ws.closed,true);
 assert.deepEqual(ws.sent.map(p=>p[0]),[0x10,0x82,0x30,0xe0]);
});
test('malformed SUBACK fails before any command is sent',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');const ws=new FakeSocket(new Uint8Array([0,1]));
 await assert.rejects(execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,timeoutMs:20}),/subscription_rejected/);
 assert.equal(ws.sent.filter(p=>p[0]===0x30).length,0);
});
test('missing device ACK times out without resending command',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');const ws=new FakeSocket();
 await assert.rejects(execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,timeoutMs:20}),/robot_timeout/);
 assert.equal(ws.sent.filter(p=>p[0]===0x30).length,1);assert.equal(ws.closed,true);
});
test('socket is closed even when sending DISCONNECT throws',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');const ws=new FakeSocket();
 const send=ws.send.bind(ws);ws.send=bytes=>{if(bytes[0]===0xe0)throw new Error('transport failed');send(bytes);};
 ws.answer=mqttPacket(0x30,concat(mqttString('unit/device/control_ack'),new TextEncoder().encode(JSON.stringify({request_id:requestId(packet),ok:true}))));
 await execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,timeoutMs:20});
 assert.equal(ws.closed,true);
});
test('CONNECT send error settles the same operation and closes the socket',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');const ws=new FakeSocket();
 ws.send=()=>{throw new Error('transport failed');};
 await assert.rejects(execute({socketFactory:async()=>ws,url:'unused',base:'unit/device',packet,timeoutMs:20}),/broker_connection_failed/);
 assert.equal(ws.closed,true);
 await new Promise(resolve=>setTimeout(resolve,30));
});

test('a dropped broker connection before publish reconnects once',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');
 const broken=new FakeSocket(),healthy=new FakeSocket();let attempts=0;
 broken.send=bytes=>{broken.sent.push(bytes);if(bytes[0]===0x10)queueMicrotask(()=>broken.dispatchEvent(new Event('close')));};
 healthy.answer=mqttPacket(0x30,concat(mqttString('unit/device/control_ack'),new TextEncoder().encode(JSON.stringify({request_id:requestId(packet),ok:true}))));
 const result=await execute({socketFactory:async()=>++attempts===1?broken:healthy,url:'unused',base:'unit/device',packet,timeoutMs:2000});
 assert.equal(result.ok,true);assert.equal(attempts,2);assert.equal(broken.closed,true);
 assert.equal(broken.sent.filter(p=>p[0]===0x30).length,0);
 assert.equal(healthy.sent.filter(p=>p[0]===0x30).length,1);
});

test('disconnect after publish never repeats a changing command',async()=>{
 const packet=await controlPacket(3,new Uint8Array([1]),'test');const ws=new FakeSocket();let attempts=0;
 const send=ws.send.bind(ws);ws.send=bytes=>{send(bytes);if(bytes[0]===0x30)queueMicrotask(()=>ws.dispatchEvent(new Event('close')));};
 await assert.rejects(execute({socketFactory:async()=>{attempts++;return ws;},url:'unused',base:'unit/device',packet,timeoutMs:2000}),/broker_disconnected/);
 assert.equal(attempts,1);assert.equal(ws.sent.filter(p=>p[0]===0x30).length,1);
});

test('read-only status may retry a disconnect after publish',async()=>{
 const packet=await controlPacket(9,new Uint8Array([0]),'test');const broken=new FakeSocket(),healthy=new FakeSocket();let attempts=0;
 const send=broken.send.bind(broken);broken.send=bytes=>{send(bytes);if(bytes[0]===0x30)queueMicrotask(()=>broken.dispatchEvent(new Event('close')));};
 healthy.answer=mqttPacket(0x30,concat(mqttString('unit/device/control_ack'),new TextEncoder().encode(JSON.stringify({request_id:requestId(packet),ok:true}))));
 const result=await execute({socketFactory:async()=>++attempts===1?broken:healthy,url:'unused',base:'unit/device',packet,readOnly:true,timeoutMs:2000});
 assert.equal(result.ok,true);assert.equal(attempts,2);
});

test('persistent broker failure stops after two attempts',async()=>{
 let attempts=0;
 await assert.rejects(execute({socketFactory:async()=>{attempts++;throw new Error('broker_connection_failed');},url:'unused',base:'unit/device',timeoutMs:2000}),/broker_connection_failed/);
 assert.equal(attempts,2);
});
