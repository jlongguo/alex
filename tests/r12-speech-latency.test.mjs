import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechLatencyObserver} from '../scripts/speech-latency-observer.mjs';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';

const A='learner:student-a',B='learner:student-b';
const validA='11111111-1111-4111-8111-111111111111';
const validB='22222222-2222-4222-8222-222222222222';

test('R12 rolling P50/P95 are nearest-rank, bounded and numerical only',()=>{
 const obs=new SpeechLatencyObserver({windowSize:5});
 for(const value of [10,20,30,40,50,60])
  obs.record(A,'firstChunkMs',value);
 const data=obs.snapshot(A);
 assert.equal(data.firstChunkMs.count,5);
 assert.equal(data.firstChunkMs.p50Ms,40);
 assert.equal(data.firstChunkMs.p95Ms,60);
 assert.equal(data.firstChunkMs.maxMs,60);
 assert.equal(data.firstPlaybackAckMs.p50Ms,null);
 assert.equal(data.acousticProof,false);
 assert.equal(data.windowSize,5);
 assert.ok(!JSON.stringify(data).includes('student-a'));
 assert.equal(obs.snapshot(B).firstChunkMs.count,0);
});

test('R12 rejects invalid samples and enforces erasure per learner',()=>{
 const obs=new SpeechLatencyObserver();
 assert.throws(()=>new SpeechLatencyObserver({windowSize:0}),/INVALID_SPEECH_LATENCY_WINDOW/);
 for(const n of [-1,Infinity,NaN,120001]){
  assert.throws(()=>obs.record(A,'firstChunkMs',n),
   /INVALID_SPEECH_LATENCY_SAMPLE/);
 }
 assert.throws(()=>obs.record(A,'rawAudio',10),/INVALID_SPEECH_LATENCY_SAMPLE/);
 obs.record(A,'firstChunkMs',20);
 obs.record(B,'firstChunkMs',30);
 obs.record('parent','firstChunkMs',40);
 assert.equal(obs.eraseScope('child'),2);
 assert.equal(obs.snapshot(A).firstChunkMs.count,0);
 assert.equal(obs.snapshot('parent').firstChunkMs.count,1);
 assert.equal(obs.eraseScope('parent'),1);
 assert.equal(obs.snapshot('parent').firstChunkMs.count,0);
});

test('R12 records first frame/ACK/completion only once for each completed session',async()=>{
 let now=1000,idIndex=0;
 const ids=[validA,validB];
 const provider={open:async()=>{
  let index=0;
  return {async read(){
   if(index++===0)return {done:false,pcm:Buffer.alloc(4800),samples:2400};
   return {done:true};
  },async close(){}};
 }};
 const manager=new StreamingSpeechSessions({provider,
  now:()=>now,makeId:()=>ids[idIndex++]});
 const first=await manager.start(A,{text:'Hello'});
 now+=20;
 const frame=await manager.next(A,first.id,0);
 assert.equal(frame.seq,0);
 now+=100;
 const ack=manager.ack(A,first.id,0);
 assert.equal(ack.playedMsClaimed,100);
 now+=10;
 const done=await manager.next(A,first.id,1);
 assert.equal(done.done,true);
 const metrics=manager.latencyMetrics(A);
 assert.deepEqual(metrics.firstChunkMs,{count:1,p50Ms:20,p95Ms:20,maxMs:20});
 assert.deepEqual(metrics.firstPlaybackAckMs,{count:1,p50Ms:120,p95Ms:120,maxMs:120});
 assert.deepEqual(metrics.completionMs,{count:1,p50Ms:130,p95Ms:130,maxMs:130});
 assert.equal(manager.activeCount(),0);
 assert.equal(manager.metrics(A).completed,1);
 assert.equal(manager.latencyMetrics(B).firstChunkMs.count,0);
});

test('R12 cancelled sessions do not report an artificial playback completion',async()=>{
 let now=400;
 const provider={open:async()=>({
  read:async()=>({done:false,pcm:Buffer.alloc(4800),samples:2400}),
  close:async()=>{}
 })};
 const manager=new StreamingSpeechSessions({provider,
  now:()=>now,makeId:()=>validA});
 const start=await manager.start(A,{text:'A story'});
 now+=60;
 await manager.next(A,start.id,0);
 now+=20;
 assert.equal(manager.cancel(A,start.id).cancelled,true);
 const metrics=manager.latencyMetrics(A);
 assert.equal(metrics.firstChunkMs.count,1);
 assert.equal(metrics.firstPlaybackAckMs.count,0);
 assert.equal(metrics.completionMs.count,0);
 assert.equal(manager.metrics(A).cancelled,1);
 manager.erasePrincipal(A);
 assert.equal(manager.latencyMetrics(A).firstChunkMs.count,0);
});

test('R12 scoped privacy erase removes both speech metrics and sampled durations',async()=>{
 const provider={open:async()=>({
  async read(){return {done:false,pcm:Buffer.alloc(4800),samples:2400};},
  async close(){}
 })};
 const manager=new StreamingSpeechSessions({provider,makeId:()=>validA});
 const s=await manager.start(A,{text:'privacy'});
 await manager.next(A,s.id,0);
 assert.equal(manager.latencyMetrics(A).firstChunkMs.count,1);
 manager.eraseScope('child');
 assert.equal(manager.latencyMetrics(A).firstChunkMs.count,0);
 assert.equal(manager.metrics(A).started,0);
 assert.equal(manager.activeCount(),0);
});
