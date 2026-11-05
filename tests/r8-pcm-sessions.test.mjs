import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {RealtimePcmSessions,readRealtimePcmFrame} from '../scripts/realtime-pcm-sessions.mjs';

const A='learner:profile-A',B='learner:profile-B';
const frame=Buffer.alloc(4800,0x23);
function harness({now=()=>Date.now()}={}){
 const channels=[];
 const provider={open:async({onPartial,signal})=>{
  const channel={frames:[],cancelled:false,closed:false,
   append:async data=>{
    channel.frames.push(Buffer.from(data));
    onPartial({text:'Hello',final:false});
    return {frames:channel.frames.length};
   },
   commit:async()=>({text:'Hello Alex',source:'realtime-cloud-asr',
    metrics:{firstPartialMs:120}}),
   cancel(){channel.cancelled=true;},
   close(){channel.closed=true;}
  };
  channels.push({channel,signal});return channel;
 }};
 return {provider,channels,manager:new RealtimePcmSessions({provider,now})};
}
test('R8 real-time PCM accepts packets before commit, isolates each child and returns transcript preview',async()=>{
 let t=1000;
 const {manager,channels}=harness({now:()=>t});
 const a=await manager.start(A,{language:'en'});
 assert.equal(a.format,'pcm16-mono-24khz');
 assert.equal(a.upstream,'wss-realtime-transcription');
 assert.equal(a.transcriptMode,'preview-only');
 await assert.rejects(()=>manager.start(A),/AUDIO_ALREADY_ACTIVE/);
 assert.throws(()=>manager.status(B,a.id),/REALTIME_SESSION_FORBIDDEN/);
 await assert.rejects(()=>manager.append(B,a.id,{seq:0,data:frame}),/REALTIME_SESSION_FORBIDDEN/);
 await assert.rejects(()=>manager.append(A,a.id,{seq:1,data:frame}),/INVALID_REALTIME_SEQUENCE/);
 const receipt=await manager.append(A,a.id,{seq:0,data:frame});
 assert.equal(receipt.nextSeq,1);
 assert.equal(receipt.pcmBytes,4800);
 assert.equal(manager.status(A,a.id).partialTranscript,'Hello');
 assert.equal(manager.status(A,a.id).pcmBytes,4800);
 t+=700;
 const final=await manager.commit(A,a.id,{authorized:()=>true});
 assert.equal(final.text,'Hello Alex');
 assert.equal(final.requiresManualSubmit,true);
 assert.equal(final.metrics.captureMs,700);
 assert.equal(final.metrics.firstPartialMs,120);
 assert.equal(manager.activeCount(),0);
 assert.equal(manager.metrics(A).completed,1);
 assert.equal(manager.metrics(A).pcmBytes,4800);
 assert.equal(manager.metrics(B).opened,0);
 assert.ok(!JSON.stringify(manager.metrics(A)).includes('Hello'));
 assert.equal(channels[0].channel.closed,true);
});
test('R8 consent revocation cancels pending live ASR and no transcript is committed',async()=>{
 let now=1000;
 let rejectCommit;
 const provider={open:async()=>({
  append:async()=>({frames:1}),
  commit:()=>new Promise((resolve,reject)=>{rejectCommit=reject;}),
  cancel:()=>rejectCommit?.(new Error('AUDIO_REQUEST_CANCELLED')),
  close(){}
 })};
 const manager=new RealtimePcmSessions({provider,now:()=>now});
 const session=await manager.start(A);
 await manager.append(A,session.id,{seq:0,data:frame});
 now+=600;
 const pending=manager.commit(A,session.id,{authorized:()=>true});
 assert.equal(manager.status(A,session.id).phase,'committing');
 assert.equal(manager.cancel(A,session.id),true);
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(manager.metrics(A).completed,0);
 assert.equal(manager.metrics(A).cancelled,1);
 assert.equal(manager.activeCount(),0);
});
test('R8 per-principal rate, simultaneous channel caps, abort, idle expiry and privacy erase',async()=>{
 let t=1000;
 const {manager}=harness({now:()=>t});
 const a=await manager.start(A);
 const b=await manager.start(B);
 assert.equal(manager.activeCount(),2);
 assert.equal(manager.cancel(A,b.id),false);
 assert.equal(manager.cancel(A,a.id),true);
 assert.equal(manager.cancel(B,b.id),true);
 for(let i=0;i<5;i++){
  const s=await manager.start(A);
  manager.cancel(A,s.id);
 }
 await assert.rejects(()=>manager.start(A),/AUDIO_RATE_LIMIT/);
 assert.equal(manager.metrics(A).opened,6);
 assert.equal(manager.eraseScope('child'),2);
 assert.equal(manager.metrics(A).opened,0);
 assert.equal(manager.metrics(B).opened,0);
 t+=61_000;
 const c=await manager.start(A);
 t+=10_010;manager.sweep();
 assert.throws(()=>manager.status(A,c.id),/UNKNOWN_REALTIME_SESSION/);
 assert.equal(manager.metrics(A).expired,1);
 const p=await manager.start('parent');
 assert.equal(manager.eraseScope('child'),1);
 assert.equal(manager.activeCount(),1);
 assert.equal(manager.eraseScope('parent'),1);
 assert.equal(manager.activeCount(),0);
 await assert.rejects(()=>manager.start(A,{language:'wrong'}),/INVALID_AUDIO_LANGUAGE/);
});
test('R8 invalid frame size, odd byte count and replay cannot trigger provider commits',async()=>{
 const {manager}=harness();
 const a=await manager.start(A);
 await assert.rejects(()=>manager.append(A,a.id,{
  seq:0,data:Buffer.alloc(9601)}),/INVALID_REALTIME_PCM_BYTES/);
 await assert.rejects(()=>manager.append(A,a.id,{
  seq:0,data:Buffer.alloc(3)}),/INVALID_REALTIME_PCM_BYTES/);
 await manager.append(A,a.id,{seq:0,data:frame});
 await assert.rejects(()=>manager.append(A,a.id,{seq:0,data:frame}),
  /INVALID_REALTIME_SEQUENCE/);
 await assert.rejects(()=>manager.commit(A,a.id),/INVALID_REALTIME_AUDIO_TOO_SHORT/);
 assert.equal(manager.cancel(A,a.id),true);
});
test('R8 actual HTTP raw PCM frame parser validates declared and read byte limits',async()=>{
 const readable=Readable.from([Buffer.alloc(1024),Buffer.alloc(2048)]);
 readable.headers={'content-type':'application/octet-stream','content-length':'3072'};
 const data=await readRealtimePcmFrame(readable);
 assert.equal(data.byteLength,3072);
 const bad=Readable.from([Buffer.alloc(10001)]);
 bad.headers={'content-type':'application/octet-stream'};
 await assert.rejects(()=>readRealtimePcmFrame(bad),/INVALID_REALTIME_PCM_BYTES/);
 const odd=Readable.from([Buffer.alloc(101)]);
 odd.headers={'content-type':'application/octet-stream'};
 await assert.rejects(()=>readRealtimePcmFrame(odd),/INVALID_REALTIME_PCM_BYTES/);
 const mime=Readable.from([Buffer.alloc(320)]);
 mime.headers={'content-type':'audio/webm'};
 await assert.rejects(()=>readRealtimePcmFrame(mime),/INVALID_REALTIME_CONTENT_TYPE/);
});
