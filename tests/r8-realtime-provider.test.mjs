import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {RealtimeTranscriptionProvider} from '../scripts/realtime-transcription-provider.mjs';
const bytes=new Uint8Array(9600).fill(12);
class FixtureSocket extends EventEmitter {
  sent=[];closed=false;respond=true;stall=false;
  send(message){
    this.sent.push(message);
    if(message.type==='session.update'&&this.respond)
      queueMicrotask(()=>this.emit('json',{type:'session.updated',session:{}}));
    if(message.type==='input_audio_buffer.commit'&&!this.stall)
      queueMicrotask(()=>{
        this.emit('json',{type:'conversation.item.input_audio_transcription.completed',
          item_id:'item1',transcript:'Hello Alex'});
      });
  }
  close(){this.closed=true;}
}
function setup(options={}){
 const socket=new FixtureSocket();
 const connect=async args=>{
  assert.match(args.url,/intent=transcription/);
  assert.equal(args.apiKey,'private-model-credential');
  return socket;
 };
 const provider=new RealtimeTranscriptionProvider({
  apiKey:'private-model-credential',connect,...options
 });
 return {socket,provider};
}
test('R8 provider config uses transcription-only 24kHz mono PCM, not voice generation tools',async()=>{
 const {socket,provider}=setup();
 const partials=[];
 const channel=await provider.open({onPartial:event=>partials.push(event)});
 const cfg=socket.sent[0];
 assert.equal(cfg.type,'session.update');
 assert.equal(cfg.session.type,'transcription');
 assert.deepEqual(cfg.session.audio.input.format,{type:'audio/pcm',rate:24000});
 assert.equal(cfg.session.audio.input.transcription.model,'gpt-live-transcribe');
 assert.equal(cfg.session.audio.input.turn_detection,null);
 assert.equal(channel.state,'ready');
 await channel.append(bytes);
 socket.emit('json',{type:'conversation.item.input_audio_transcription.delta',
  delta:'Hello '});
 socket.emit('json',{type:'conversation.item.input_audio_transcription.delta',
  delta:'Alex'});
 assert.equal(partials.length,2);
 assert.equal(partials[1].text,'Hello Alex');
 const final=await channel.commit();
 assert.equal(final.text,'Hello Alex');
 assert.equal(final.source,'realtime-cloud-asr');
 assert.equal(final.requiresManualSubmit,true);
 assert.equal(final.metrics.pcmBytes,9600);
 assert.equal(final.metrics.frames,1);
 assert.equal(socket.closed,true);
 assert.deepEqual(socket.sent.map(x=>x.type),[
  'session.update','input_audio_buffer.append','input_audio_buffer.commit']);
 const data=socket.sent[1].audio;
 assert.equal(Buffer.from(data,'base64').byteLength,bytes.length);
 assert.equal(JSON.stringify(socket.sent).includes('private-model-credential'),false);
});
test('R8 provider validates byte alignment, audio budget and commit min duration',async()=>{
 const {socket,provider}=setup();
 const channel=await provider.open();
 await assert.rejects(()=>channel.append(new Uint8Array(9)),
  /INVALID_REALTIME_PCM_BYTES/);
 await assert.rejects(()=>channel.append(new Uint8Array(9601)),
  /INVALID_REALTIME_PCM_BYTES/);
 await assert.rejects(()=>channel.commit(),/INVALID_REALTIME_AUDIO_TOO_SHORT/);
 assert.equal(socket.sent.length,1);
 for(let i=0;i<75;i++)await channel.append(bytes);
 await assert.rejects(()=>channel.append(bytes),/INVALID_REALTIME_PCM_BYTES/);
 assert.equal(channel.snapshot().pcmBytes,720000);
 channel.cancel();channel.close();
 assert.equal(socket.closed,true);
});
test('R8 streamed transcript over 500 chars is rejected and socket closed',async()=>{
 const {socket,provider}=setup();
 const channel=await provider.open();
 socket.emit('json',{type:'conversation.item.input_audio_transcription.delta',
  delta:'A'.repeat(501)});
 assert.equal(socket.closed,true);
 await assert.rejects(()=>channel.append(bytes),/AUDIO_REALTIME_NOT_READY/);
});
test('R8 parent abort during finalization rejects commit and closes connection',async()=>{
 const {socket,provider}=setup();
 const controller=new AbortController();
 const channel=await provider.open({signal:controller.signal});
 await channel.append(bytes);
 socket.stall=true;
 const pending=channel.commit();
 controller.abort();
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(socket.closed,true);
});
test('R8 provider upstream error is sanitized and cannot expose vendor response or key',async()=>{
 const {socket,provider}=setup();
 const channel=await provider.open();
 await channel.append(bytes);
 socket.emit('json',{type:'error',error:{message:'API KEY secret'}});
 assert.equal(socket.closed,true);
 await assert.rejects(()=>channel.append(bytes),/AUDIO_REALTIME_NOT_READY/);
});
test('R8 provider fails closed when WSS transport exceeds its buffered threshold',async()=>{
 const {socket,provider}=setup();
 const channel=await provider.open();
 const original=socket.send.bind(socket);
 socket.send=value=>{
  if(value.type==='input_audio_buffer.append')throw Error('AUDIO_WS_BACKPRESSURE');
  return original(value);
 };
 await assert.rejects(()=>channel.append(bytes),/AUDIO_REALTIME_BACKPRESSURE/);
 assert.equal(socket.closed,true);
});
