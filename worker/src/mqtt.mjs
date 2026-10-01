import { concat,mqttPacket,mqttString,MqttDecoder,PhotoAssembler,requestId,openPhotoPacket } from './protocol.mjs';
const decoder=new TextDecoder();

// Bounded reconnect within the original deadline. Never replay a changing
// command once publish was attempted; only explicit read-only queries may repeat.
export async function execute(options){
  const deadline=Date.now()+(options.timeoutMs??12000);
  for(let attempt=0;attempt<2;attempt++){
    try{return await executeOnce({...options,deadline});}
    catch(error){
      const transient=['broker_disconnected','broker_connection_failed','broker_upgrade_failed'].includes(error.message);
      if(attempt||!transient||(error.published&&!options.readOnly)||deadline-Date.now()<1000)throw error;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
}

async function executeOnce({socketFactory,url,base,packet,photo=false,photoSecret='',deadline}){
  const socket=await socketFactory(url);socket.binaryType='arraybuffer';
  if(Date.now()>=deadline){try{socket.close(1000,'timeout');}catch{}throw new Error('robot_timeout');}
  const mqtt=new MqttDecoder(),image=new PhotoAssembler();
  let timer,finished=false,subscribed=false,published=false,settle;
  const id=packet?requestId(packet):null;
  const photoTopic=photo?`${base}/photo_secure/${id}`:null;
  // Only the topic that belongs to this request is acknowledged and read.
  const topics=photo?[photoTopic,base+'/control_ack']:[base+'/control_ack'];
  const completion=new Promise((resolve,reject)=>{
    const finish=(error,result)=>{
      if(finished)return;finished=true;clearTimeout(timer);
      try{socket.send(mqttPacket(0xe0));}catch{}
      try{socket.close(1000,'done');}catch{}
      if(error){error.published=published;error.phase=!subscribed?'subscribe':!published?'publish':photo?'photo':'ack';error.photoBytes=image.bytes;reject(error);}else resolve(result);
    };
    settle=finish;
    timer=setTimeout(()=>finish(new Error('robot_timeout')),Math.max(0,deadline-Date.now()));
    socket.addEventListener('error',()=>finish(new Error('broker_connection_failed')));
    socket.addEventListener('close',()=>{if(!finished)finish(new Error('broker_disconnected'));});
    socket.addEventListener('message',async event=>{
      if(finished)return;
      try{
        const bytes=new Uint8Array(event.data);
        for(const p of mqtt.push(bytes)){
          if(p.type===2){
            if(p.body.length!==2||p.body[1]!==0)throw new Error('broker_rejected');
            socket.send(mqttPacket(0x82,concat(new Uint8Array([0,1]),...topics.flatMap(t=>[mqttString(t),new Uint8Array([1])]))));
          }else if(p.type===9){
            if(p.body.length!==2+topics.length||p.body[0]!==0||p.body[1]!==1||p.body.slice(2).some(x=>x>1))throw new Error('subscription_rejected');
            if(subscribed)continue;subscribed=true;
            const topic=base+'/control';
            // Publish once, without retain. No automatic retries after timeout.
            published=true;
            socket.send(mqttPacket(0x30,concat(mqttString(topic),packet)));
          }else if(p.type===3){
            if(p.body.length<2)throw new Error('mqtt_publish_invalid');
            const length=p.body[0]*256+p.body[1];
            const topic=decoder.decode(p.body.slice(2,2+length));
            let offset=2+length;const qos=(p.flags>>1)&3;
            if(qos>1)throw new Error('mqtt_qos_unsupported');
            if(qos===1){socket.send(mqttPacket(0x40,p.body.slice(offset,offset+2)));offset+=2;}
            const data=p.body.slice(offset);
            if(photo&&topic===photoTopic){
              // Decrypt inside the message handler so failures settle this operation
              // instead of turning into an unhandled rejection.
              try{
                const plain=await openPhotoPacket(data,id,photoSecret);
                image.push(plain);const result=image.result();
                if(result)finish(null,{bytes:result,width:image.width,height:image.height});
              }catch(error){finish(error);}
            }else if(topic===base+'/control_ack'){
              try{
                const ack=JSON.parse(decoder.decode(data));
                if(ack.request_id===id){
                  if(!photo)finish(null,ack);
                  // Legacy ACK can report busy, but never substitutes for an
                  // authenticated, completely reassembled JPEG.
                  else if(ack.ok===false&&ack.status==='busy')finish(new Error('robot_busy'));
                }
              }catch(e){if(e instanceof SyntaxError)continue;throw e;}
            }
          }
        }
      }catch(error){finish(error);}
    });
  });
  // Listeners are installed before accept/CONNECT to avoid missed CONNACKs.
  const client='sc-cloud-'+crypto.randomUUID().replaceAll('-','').slice(0,20);
  const connect=concat(mqttString('MQTT'),new Uint8Array([4,2,0,20]),mqttString(client));
  try{socket.accept?.();socket.send(mqttPacket(0x10,connect));}catch{settle(new Error('broker_connection_failed'));}
  return completion;
}

export async function cloudSocket(url){
  let response;
  try{response=await fetch(url,{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'mqtt'},signal:AbortSignal.timeout(8000)});}
  catch{throw new Error('broker_connection_failed');}
  if(!response.webSocket)throw new Error('broker_upgrade_failed');return response.webSocket;
}
