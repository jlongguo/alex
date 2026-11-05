// This preload is ONLY loaded in R8 localhost tests. It intercepts the
// server's outgoing Node https WebSocket upgrade; no vendor network traffic.
// No production request path or global insecure test override exists.
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const https=require('node:https');
const original=https.request;
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function serverFrame(value){
 const data=Buffer.from(JSON.stringify(value));
 const prefix=data.length<126?2:4;
 const header=Buffer.alloc(prefix);header[0]=0x81;
 if(prefix===2)header[1]=data.length;
 else{header[1]=126;header.writeUInt16BE(data.length,2);}
 return Buffer.concat([header,data]);
}
class Socket extends EventEmitter {
 writableLength=0;closed=false;buffer=Buffer.alloc(0);
 appendCount=0;receivedBytes=0;
 write(data){
  if(this.closed)return false;
  this.buffer=Buffer.concat([this.buffer,data]);
  while(this.buffer.length>=2){
   const opcode=this.buffer[0]&15;
   const code=this.buffer[1],masked=!!(code&128);
   let count=code&127,head=2;
   if(count===126){
    if(this.buffer.length<4)return true;
    count=this.buffer.readUInt16BE(2);head=4;
   }
   if(!masked||this.buffer.length<head+4+count)return true;
   const mask=this.buffer.subarray(head,head+4);
   const raw=this.buffer.subarray(head+4,head+4+count);
   const payload=Buffer.alloc(count);
   for(let i=0;i<count;i++)payload[i]=raw[i]^mask[i%4];
   this.buffer=this.buffer.subarray(head+4+count);
   if(opcode===8){this.destroy();return true;}
   if(opcode!==1)continue;
   let message;
   try{message=JSON.parse(payload.toString());}catch{continue;}
   if(message.type==='session.update'){
     queueMicrotask(()=>this.sendJson({type:'session.updated',session:{}}));
   }else if(message.type==='input_audio_buffer.append'){
     this.appendCount++;
     this.receivedBytes+=Buffer.from(message.audio,'base64').length;
     if(this.appendCount===1)queueMicrotask(()=>this.sendJson({
       type:'conversation.item.input_audio_transcription.delta',
       delta:'Hello '
     }));
   }else if(message.type==='input_audio_buffer.commit'){
     queueMicrotask(()=>this.sendJson({
       type:'conversation.item.input_audio_transcription.completed',
       item_id:'fixture-item',transcript:'Hello Alex'
     }));
   }
  }
  return true;
 }
 sendJson(value){
  if(!this.closed)this.emit('data',serverFrame(value));
 }
 end(){this.destroy();}
 destroy(){if(this.closed)return;this.closed=true;this.emit('close');}
}
https.request=(url,options,...rest)=>{
 if(String(url).startsWith('wss://api.openai.com/v1/realtime?intent=transcription')){
  if(options?.headers?.Authorization!=='Bearer private-realtime-fixture')
    throw Error('Missing realtime key in fixture');
  const socket=new Socket();
  const req=new EventEmitter();
  req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const nonce=options.headers['Sec-WebSocket-Key'];
   const accept=createHash('sha1').update(nonce+GUID).digest('base64');
   req.emit('upgrade',{
     statusCode:101,headers:{
       upgrade:'websocket','sec-websocket-accept':accept
     }
   },socket,Buffer.alloc(0));
  });
  return req;
 }
 return original.call(https,url,options,...rest);
};
syncBuiltinESMExports();
