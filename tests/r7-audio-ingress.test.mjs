import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {
  AudioIngressSessions,readAudioChunk,AUDIO_CHUNK_BYTES
} from '../scripts/audio-ingress-sessions.mjs';

const A='learner:profile-a',B='learner:profile-b';
test('R7 incremental ingress is ordered, independent, metadata-only and calls ASR after finish',async()=>{
  let now=1_000;
  const manager=new AudioIngressSessions({now:()=>now});
  const s=manager.open(A,{mime:'audio/webm',language:'en'});
  assert.equal(s.transport,'incremental-http');
  assert.equal(s.upstream,'batch-asr-after-finish');
  assert.equal(manager.status(A,s.id).receivedBytes,0);
  assert.throws(()=>manager.status(B,s.id),/AUDIO_TURN_FORBIDDEN/);
  assert.throws(()=>manager.append(B,s.id,{seq:0,mime:'audio/webm',data:Buffer.alloc(256)}),
    /AUDIO_TURN_FORBIDDEN/);
  assert.throws(()=>manager.append(A,s.id,{seq:1,mime:'audio/webm',data:Buffer.alloc(256)}),
    /INVALID_AUDIO_CHUNK_SEQUENCE/);
  const first=manager.append(A,s.id,{
    seq:0,mime:'audio/webm',data:Buffer.alloc(256,0x41)});
  assert.deepEqual({nextSeq:first.nextSeq,totalBytes:first.totalBytes},{nextSeq:1,totalBytes:256});
  assert.throws(()=>manager.append(A,s.id,{seq:0,mime:'audio/webm',
    data:Buffer.alloc(200)}),/INVALID_AUDIO_CHUNK_SEQUENCE/);
  assert.throws(()=>manager.append(A,s.id,{seq:1,mime:'audio/wav',
    data:Buffer.alloc(200)}),/INVALID_AUDIO_MIME/);
  manager.append(A,s.id,{seq:1,mime:'audio/webm',
    data:Buffer.alloc(500,0x42)});
  now+=800;
  let seen;
  const completed=await manager.finish(A,s.id,{
    authorized:()=>true,
    transcribe:async({audio,mime,language,signal})=>{
      seen={size:audio.length,mime,language,aborted:signal.aborted,
        first:audio[0],last:audio.at(-1)};
      now+=240;
      return {text:'Hello',source:'cloud-asr',validated:false};
    }
  });
  assert.deepEqual(seen,{size:756,mime:'audio/webm',language:'en',
    aborted:false,first:0x41,last:0x42});
  assert.equal(completed.requiresManualSubmit,true);
  assert.deepEqual(completed.metrics,{
    captureMs:800,providerMs:240,totalBytes:756,chunks:2});
  assert.equal(manager.activeCount(),0);
  assert.deepEqual(manager.metrics(A),{
    opened:1,completed:1,cancelled:0,expired:0,rejected:0,
    totalBytes:756,totalChunks:2,lastCaptureMs:800,lastProviderMs:240
  });
  assert.ok(!JSON.stringify(manager.metrics(A)).includes('Hello'));
  assert.throws(()=>manager.status(A,s.id),/UNKNOWN_AUDIO_TURN/);
});
test('R7 inbound chunks have strict size, sequence, byte budget and active principal cap',()=>{
  let now=1_000;
  const manager=new AudioIngressSessions({now:()=>now,maxActive:2});
  const a=manager.open(A,{mime:'audio/webm',language:'zh'});
  const b=manager.open(B,{mime:'audio/webm',language:'zh'});
  assert.throws(()=>manager.open('parent',{mime:'audio/webm'}),/AUDIO_SERVER_BUSY/);
  assert.throws(()=>manager.open(A,{mime:'audio/webm'}),/AUDIO_ALREADY_ACTIVE/);
  assert.throws(()=>manager.append(A,a.id,{seq:0,mime:'audio/webm',
    data:Buffer.alloc(AUDIO_CHUNK_BYTES+1)}),/INVALID_AUDIO_CHUNK_BYTES/);
  assert.throws(()=>manager.append(A,a.id,{seq:0,mime:'audio/webm',
    data:Buffer.alloc(0)}),/INVALID_AUDIO_CHUNK_BYTES/);
  assert.throws(()=>manager.append(A,a.id,{seq:0,mime:'audio/webm',
    data:'not binary'}),/INVALID_AUDIO_CHUNK_BYTES/);
  assert.equal(manager.cancel(B,a.id),false);
  assert.equal(manager.cancel(A,a.id),true);
  assert.equal(manager.cancel(A,a.id),false);
  assert.equal(manager.metrics(A).cancelled,1);
  assert.equal(manager.activeCount(),1);
  manager.cancel(B,b.id);
  for(let i=0;i<5;i++){
    const s=manager.open(A,{mime:'audio/webm'});
    manager.cancel(A,s.id);
  }
  assert.throws(()=>manager.open(A,{mime:'audio/webm'}),/AUDIO_RATE_LIMIT/);
  now+=61_000;
  assert.ok(manager.open(A,{mime:'audio/webm'}).id);
});
test('R7 expired / idle ingress is zeroed, revoked and rejects delayed client retries',()=>{
  let now=1_000;
  const manager=new AudioIngressSessions({now:()=>now});
  const a=manager.open(A,{mime:'audio/webm'});
  manager.append(A,a.id,{seq:0,mime:'audio/webm',data:Buffer.alloc(400)});
  now+=10_100;
  assert.equal(manager.sweep(),0);
  assert.equal(manager.metrics(A).expired,1);
  assert.throws(()=>manager.status(A,a.id),/UNKNOWN_AUDIO_TURN/);
  assert.equal(manager.cancel(A,a.id),false);
  const b=manager.open(A,{mime:'audio/webm'});
  manager.append(A,b.id,{seq:0,mime:'audio/webm',data:Buffer.alloc(400)});
  now+=15_600;
  assert.throws(()=>manager.append(A,b.id,{seq:1,mime:'audio/webm',
    data:Buffer.alloc(300)}),/UNKNOWN_AUDIO_TURN|INVALID_AUDIO_DURATION/);
  assert.equal(manager.activeCount(),0);
});
test('R7 revoked owner aborts provider output and does not commit completion metrics',async()=>{
  let now=1_000;
  const manager=new AudioIngressSessions({now:()=>now});
  const session=manager.open(A,{mime:'audio/webm'});
  manager.append(A,session.id,{seq:0,mime:'audio/webm',data:Buffer.alloc(300)});
  now+=550;
  let signalReady;
  const begun=new Promise(resolve=>signalReady=resolve);
  const pending=manager.finish(A,session.id,{
    authorized:()=>true,
    transcribe:({signal})=>new Promise((resolve,reject)=>{
      signalReady();
      signal.addEventListener('abort',
        ()=>reject(new Error('AUDIO_REQUEST_CANCELLED')),{once:true});
    })
  });
  await begun;
  assert.equal(manager.status(A,session.id).phase,'finalizing');
  assert.equal(manager.cancel(A,session.id),true);
  await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
  assert.equal(manager.activeCount(),0);
  assert.equal(manager.metrics(A).completed,0);
  assert.equal(manager.metrics(A).cancelled,1);
  assert.throws(()=>manager.status(A,session.id),/UNKNOWN_AUDIO_TURN/);
});
test('R7 invalid/falsified start inputs never create active audio sessions',()=>{
  const manager=new AudioIngressSessions();
  assert.throws(()=>manager.open('',{mime:'audio/webm'}),/INVALID_AUDIO_PRINCIPAL/);
  assert.throws(()=>manager.open(A,{mime:'application/json'}),/INVALID_AUDIO_MIME/);
  assert.throws(()=>manager.open(A,{mime:'audio/webm',language:'xx'}),/INVALID_AUDIO_LANGUAGE/);
  assert.equal(manager.activeCount(),0);
});
test('R7 raw chunk body parser bounds by actual received bytes and supports declared codec MIME',async()=>{
  const req=Readable.from([Buffer.alloc(70),Buffer.alloc(160)]);
  req.headers={'content-type':'audio/webm;codecs=opus','content-length':'230'};
  const chunk=await readAudioChunk(req);
  assert.equal(chunk.mime,'audio/webm');
  assert.equal(chunk.bytes.length,230);
  const oversize=Readable.from([Buffer.alloc(90),Buffer.alloc(100)]);
  oversize.headers={'content-type':'audio/webm'};
  await assert.rejects(()=>readAudioChunk(oversize,128),/INVALID_AUDIO_CHUNK_BYTES/);
  const wrong=Readable.from([Buffer.alloc(200)]);
  wrong.headers={'content-type':'text/html'};
  await assert.rejects(()=>readAudioChunk(wrong),/INVALID_AUDIO_MIME/);
});
