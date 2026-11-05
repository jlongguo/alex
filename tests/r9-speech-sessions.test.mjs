import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';

const A='learner:student-a',B='learner:student-b';
function fixture({now=()=>Date.now(),chunks=5,maxActive=4}={}){
 const opened=[];
 const provider={open:async({text,signal})=>{
  let index=0;
  const channel={
   text,signal,closed:false,
   async read(){
    if(index>=chunks)return {done:true};
    index++;
    return {done:false,pcm:Buffer.alloc(4800,index),
     samples:2400};
   },
   async close(){this.closed=true;}
  };
  opened.push(channel);
  return channel;
 }};
 return {opened,manager:new StreamingSpeechSessions({provider,now,maxActive})};
}
test('R9 per-learner audio delivery requires ordered pulls and played-onended acknowledgments',async()=>{
 let now=1000;
 const {manager,opened}=fixture({now:()=>now,chunks:4});
 const start=await manager.start(A,{text:'Read a story'});
 assert.equal(start.format,'pcm16-mono-24khz');
 assert.equal(start.maxUnacknowledged,3);
 assert.equal(start.requiresExplicitPlayback,true);
 assert.equal(manager.status(A,start.id).deliveredSamples,0);
 assert.throws(()=>manager.status(B,start.id),/SPEECH_SESSION_FORBIDDEN/);
 await assert.rejects(()=>manager.next(B,start.id,0),/SPEECH_SESSION_FORBIDDEN/);
 const a=await manager.next(A,start.id,0);
 assert.equal(a.done,false);
 assert.equal(a.seq,0);
 assert.equal(a.pcm.length,4800);
 assert.equal(a.samples,2400);
 await assert.rejects(()=>manager.next(A,start.id,0),/INVALID_SPEECH_SEQUENCE/);
 await manager.next(A,start.id,1);
 await manager.next(A,start.id,2);
 await assert.rejects(()=>manager.next(A,start.id,3),
  /SPEECH_PLAYBACK_BACKPRESSURE/);
 assert.equal(manager.status(A,start.id).outstanding,3);
 assert.throws(()=>manager.ack(B,start.id,0),/SPEECH_SESSION_FORBIDDEN/);
 assert.throws(()=>manager.ack(A,start.id,1),/INVALID_SPEECH_ACK_SEQUENCE/);
 const result=manager.ack(A,start.id,0);
 assert.equal(result.playedMsClaimed,100);
 assert.equal(result.completed,false);
 await manager.next(A,start.id,3);
 manager.ack(A,start.id,1);
 manager.ack(A,start.id,2);
 const done=await manager.next(A,start.id,4);
 assert.equal(done.done,true);
 assert.equal(manager.status(A,start.id).phase,'drained');
 const complete=manager.ack(A,start.id,3);
 assert.equal(complete.completed,true);
 assert.equal(complete.playedMsClaimed,400);
 assert.equal(manager.activeCount(),0);
 assert.equal(manager.metrics(A).completed,1);
 assert.equal(manager.metrics(A).acknowledgedSamples,9600);
 assert.equal(manager.metrics(B).started,0);
 assert.equal(opened[0].closed,true);
 assert.throws(()=>manager.status(A,start.id),/UNKNOWN_SPEECH_SESSION/);
});
test('R9 cancel returns ONLY client-claimed progress and denies another learner',async()=>{
 const {manager,opened}=fixture({chunks:12});
 const start=await manager.start(A,{text:'Once upon a time'});
 await manager.next(A,start.id,0);
 await manager.next(A,start.id,1);
 manager.ack(A,start.id,0);
 assert.deepEqual(manager.cancel(B,start.id),{cancelled:false});
 assert.equal(manager.activeCount(),1);
 const stopped=manager.cancel(A,start.id);
 assert.deepEqual(stopped,{cancelled:true,playedMsClaimed:100});
 assert.equal(manager.metrics(A).cancelled,1);
 assert.equal(manager.metrics(A).deliveredSamples,4800);
 assert.equal(manager.metrics(A).acknowledgedSamples,2400);
 assert.ok(!JSON.stringify(manager.metrics(A)).includes('Once upon a time'));
 assert.equal(opened[0].closed,true);
 assert.deepEqual(manager.cancel(A,start.id),{cancelled:false});
});
test('R9 global concurrency, rate limiting, idle expiry and explicit child erasure',async()=>{
 let now=1000;
 const {manager}=fixture({now:()=>now,maxActive:2});
 const a=await manager.start(A,{text:'Hi A'});
 const b=await manager.start(B,{text:'Hi B'});
 await assert.rejects(()=>manager.start('parent',{text:'parent'}),/AUDIO_SERVER_BUSY/);
 await assert.rejects(()=>manager.start(A,{text:'again'}),/AUDIO_ALREADY_ACTIVE/);
 assert.equal(manager.cancel(A,a.id).cancelled,true);
 assert.equal(manager.cancel(B,b.id).cancelled,true);
 for(let i=0;i<5;i++){
  const s=await manager.start(A,{text:'test'});
  manager.cancel(A,s.id);
 }
 await assert.rejects(()=>manager.start(A,{text:'test'}),/AUDIO_RATE_LIMIT/);
 assert.equal(manager.eraseScope('child'),2);
 assert.equal(manager.metrics(A).started,0);
 now+=61_000;
 const c=await manager.start(A,{text:'after rate window'});
 now+=12_100;
 assert.equal(manager.sweep(),0);
 assert.throws(()=>manager.status(A,c.id),/UNKNOWN_SPEECH_SESSION/);
 assert.equal(manager.metrics(A).expired,1);
 const p=await manager.start('parent',{text:'parent'});
 assert.equal(manager.eraseScope('child'),1);
 assert.equal(manager.activeCount(),1);
 assert.equal(manager.eraseScope('parent'),1);
 assert.equal(manager.activeCount(),0);
 assert.equal(manager.metrics('parent').started,0);
 assert.ok(p.id);
});
test('R9 cancellation during slow upstream opening cannot leave a zombie session',async()=>{
 let accept,closed=0;
 const provider={open:()=>new Promise(resolve=>accept=resolve)};
 const manager=new StreamingSpeechSessions({provider});
 const opening=manager.start(A,{text:'hello'});
 await Promise.resolve();
 assert.equal(manager.activeCount(),1);
 const stop=manager.cancel(A);
 assert.equal(stop.cancelled,true);
 accept({read:async()=>({done:true}),async close(){closed++;}});
 await assert.rejects(opening,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(manager.activeCount(),0);
 assert.ok(closed>=1);
});
test('R9 unfinished bytes are never exposed to separate sessions after privacy deletion',async()=>{
 const {manager}=fixture({chunks:20});
 const s=await manager.start(A,{text:'private utterance'});
 await manager.next(A,s.id,0);
 const erased=manager.erasePrincipal(A);
 assert.equal(erased,1);
 assert.equal(manager.metrics(A).deliveredSamples,0);
 assert.throws(()=>manager.status(A,s.id),/UNKNOWN_SPEECH_SESSION/);
 const b=await manager.start(B,{text:'another child'});
 assert.equal(manager.status(B,b.id).nextSeq,0);
});
