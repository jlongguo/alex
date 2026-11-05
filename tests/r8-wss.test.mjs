import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {SecureJsonSocket,connectSecureJsonSocket,validateRealtimeUrl} from '../scripts/realtime-wss.mjs';

const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class MockSocket extends EventEmitter {
  writableLength=0;written=[];destroyed=false;
  write(frame){this.written.push(Buffer.from(frame));return true;}
  end(){this.destroy();}
  destroy(){this.destroyed=true;this.emit('close');}
}
function serverFrame(opcode,data,{fin=true}={}){
 const payload=Buffer.isBuffer(data)?data:Buffer.from(data);
 if(payload.length>=65536)throw Error('Fixture payload too large');
 const len=payload.length<126?2:4,head=Buffer.alloc(len);
 head[0]=(fin?128:0)|opcode;
 if(len===2)head[1]=payload.length;
 else{head[1]=126;head.writeUInt16BE(payload.length,2);}
 return Buffer.concat([head,payload]);
}
function decodeMasked(frame){
 assert.equal(frame[1]&0x80,0x80,'clients MUST mask their WS frames');
 const size=frame[1]&127;
 const shift=size===126?4:2,actual=size===126?frame.readUInt16BE(2):size;
 const mask=frame.subarray(shift,shift+4);
 const data=Buffer.alloc(actual);
 for(let i=0;i<actual;i++)data[i]=frame[shift+4+i]^mask[i%4];
 return {opcode:frame[0]&15,data};
}
function connector({badAccept=false,status=101,extension=false}={}){
 const socket=new MockSocket();
 const calls=[];
 const requestFactory=(url,options)=>{
  calls.push({url:String(url),options});
  const req=new EventEmitter();
  req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   if(status!==101){
    const res=new EventEmitter();res.resume=()=>{};
    req.emit('response',res);return;
   }
   const key=options.headers['Sec-WebSocket-Key'];
   const digest=createHash('sha1').update(key+GUID).digest('base64');
   req.emit('upgrade',{
    statusCode:101,headers:{
      upgrade:'websocket','sec-websocket-accept':badAccept?'bad':digest,
      ...(extension?{'sec-websocket-extensions':'permessage-deflate'}:{})
    }
   },socket,Buffer.alloc(0));
  });
  return req;
 };
 return {socket,calls,requestFactory};
}
test('R8 outbound WSS only allows approved endpoint shapes and no credentials in URL',()=>{
 const good=validateRealtimeUrl('wss://api.openai.com/v1/realtime?intent=transcription');
 assert.equal(good.hostname,'api.openai.com');
 for(const invalid of [
  'http://api.openai.com','ws://api.openai.com',
  'wss://127.0.0.1:8443/v1','wss://localhost/v1',
  'wss://user:pass@api.openai.com/v1','wss://api.openai.com/v1#fragment',
  'https://api.openai.com/v1','garbage'
 ])
  assert.throws(()=>validateRealtimeUrl(invalid),/INVALID_REALTIME_URL/);
});
test('R8 WebSocket real RFC6455 handshake, authentication, masked outbound frame and inbound JSON',async()=>{
 const fixture=connector();
 const ws=await connectSecureJsonSocket({
  url:'wss://api.openai.com/v1/realtime?intent=transcription',
  apiKey:'server-only-secret',requestFactory:fixture.requestFactory
 });
 assert.equal(ws.closed,false);
 assert.equal(fixture.calls.length,1);
 assert.equal(fixture.calls[0].options.headers.Authorization,'Bearer server-only-secret');
 assert.equal(fixture.calls[0].options.headers.Upgrade,'websocket');
 assert.equal(fixture.calls[0].options.headers['Sec-WebSocket-Version'],'13');
 assert.equal(fixture.calls[0].options.method,'GET');
 assert.equal(fixture.calls[0].url,
  'https://api.openai.com/v1/realtime?intent=transcription',
  'Node HTTPS client must upgrade an https: request, never pass wss: to https.request');
 const events=[];
 ws.on('json',event=>events.push(event));
 ws.send({type:'session.update',value:'safe'});
 const sent=decodeMasked(fixture.socket.written[0]);
 assert.equal(sent.opcode,1);
 assert.deepEqual(JSON.parse(sent.data.toString('utf8')),
  {type:'session.update',value:'safe'});
 // Upstream JSON can arrive in partial TCP packets or fragmented WS messages.
 const first=serverFrame(1,'{"type":"session.',{fin:false});
 const last=serverFrame(0,'updated","session":{}}',{fin:true});
 const combined=Buffer.concat([first,last]);
 fixture.socket.emit('data',combined.subarray(0,8));
 fixture.socket.emit('data',combined.subarray(8));
 assert.equal(events.length,1);
 assert.equal(events[0].type,'session.updated');
 fixture.socket.emit('data',serverFrame(9,'ping'));
 const pong=decodeMasked(fixture.socket.written.at(-1));
 assert.equal(pong.opcode,10);
 assert.equal(pong.data.toString(),'ping');
 ws.close();
 assert.equal(ws.closed,true);
 assert.equal(fixture.socket.destroyed,true);
});
test('R8 invalid handshake (status, accept, extension) rejects without leaking the key',async()=>{
 for(const options of [{badAccept:true},{status:403},{extension:true}]){
  const c=connector(options);
  await assert.rejects(()=>connectSecureJsonSocket({
    url:'wss://api.openai.com/v1/realtime?intent=transcription',
    apiKey:'test-secret',requestFactory:c.requestFactory
  }),/AUDIO_WS_HANDSHAKE_FAILED/);
 }
});
test('R8 oversize, masked server frames and malformed JSON fail closed',()=>{
 for(const malformed of [
  serverFrame(1,'not-json'),
  serverFrame(1,Buffer.alloc(200),{fin:true}),
  Buffer.from([0x81,0x80,0,0,0,0])
 ]){
  const socket=new MockSocket();
  const ws=new SecureJsonSocket(socket,{maxInbound:128});
  const reasons=[];ws.on('closed',reason=>reasons.push(reason));
  socket.emit('data',malformed);
  assert.equal(ws.closed,true);
  assert.ok(socket.destroyed);
  assert.ok(reasons[0].startsWith('AUDIO_WS_'));
 }
});
test('R8 WSS detects unbounded outbound socket queue before sending audio',()=>{
 const socket=new MockSocket();
 socket.writableLength=193*1024;
 const ws=new SecureJsonSocket(socket);
 assert.throws(()=>ws.send({type:'input_audio_buffer.append',audio:'AQID'}),
   /AUDIO_WS_BACKPRESSURE/);
 ws.close();
});
