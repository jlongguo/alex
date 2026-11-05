import test from 'node:test';
import assert from 'node:assert/strict';
import {SegmentedPcmSpeechProvider} from '../scripts/segmented-pcm-speech-provider.mjs';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';
import {SpeechDeliveryBudget} from '../scripts/speech-delivery-budget.mjs';

const sentences=['Hello one.','Hello two.','Hello three.','Hello four.'];
const uuid='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(testFn){
 for(let n=0;n<100;n++){if(testFn())return;await tick();}
 throw Error('R15_CONDITION_TIMEOUT');
}
function harness(){
 const opened=[],closed=[],frames=[],active=new Set();
 let peak=0;
 const provider={async open({text,signal}){
  assert.equal(signal?.aborted,false);
  const index=sentences.indexOf(text);
  opened.push(index);
  active.add(index);peak=Math.max(peak,active.size);
  let count=0;
  return {async read(){
   if(signal?.aborted)throw Error('AUDIO_REQUEST_CANCELLED');
   if(count++)return {done:true};
   const pcm=Buffer.alloc(4800,index+1);
   frames.push(index);
   return {done:false,pcm,samples:2400};
  },async close(){closed.push(index);active.delete(index);}};
 }};
 const adapter=new SegmentedPcmSpeechProvider({provider});
 return {adapter,opened,closed,frames,active,peak:()=>peak};
}
test('R15 one logical PCM stream preserves sentence order, one prefetch ahead',async()=>{
 const h=harness();
 const source=await h.adapter.open({text:sentences[0],segments:sentences});
 await until(()=>h.opened.length===2);
 assert.deepEqual(h.opened,[0,1]);
 const received=[];
 while(true){
  const block=await source.read();
  if(block.done)break;
  received.push(block.pcm[0]);
 }
 assert.deepEqual(received,[1,2,3,4]);
 assert.deepEqual(h.opened,[0,1,2,3]);
 assert.ok(h.peak()<=2,'no more than two provider streams at once');
 assert.equal(h.active.size,0);
 await source.close();
 assert.equal(source.stats().closed,true);
});
test('R15 manual single-sentence mode is backward compatible with old PCM provider',async()=>{
 const h=harness();
 const source=await h.adapter.open({text:sentences[0]});
 assert.deepEqual(h.opened,[0]);
 assert.equal((await source.read()).pcm[0],1);
 await source.close();
});
test('R15 rejected segment lists never touch external provider',async()=>{
 const h=harness();
 for(const segments of [
  [],[...sentences,'extra'],['wrong',sentences[1]],
  ['x'.repeat(501),sentences[1]],['a'.repeat(500),'b'.repeat(500),'c'.repeat(500)]
 ]){
  await assert.rejects(h.adapter.open({text:sentences[0],segments}),
   /INVALID_COMMITTED_SPEECH_SEGMENTS/);
 }
 assert.equal(h.opened.length,0);
});
test('R15 cancellation closes both current and prefetched resources',async()=>{
 const h=harness(),controller=new AbortController();
 const source=await h.adapter.open({text:sentences[0],
  segments:sentences.slice(0,3),signal:controller.signal});
 await until(()=>h.opened.length===2);
 controller.abort();
 await assert.rejects(source.read(),/AUDIO_REQUEST_CANCELLED/);
 await source.close();
 assert.equal(h.active.size,0);
 assert.ok(h.closed.includes(0));
 assert.ok(h.closed.includes(1));
});
test('R15 a vendor that resolves a prefetched session after cancel is closed',async()=>{
 let finish,lateClosed=0;
 const provider={open:async({text})=>{
  if(text===sentences[1])return new Promise(resolve=>finish=resolve);
  return {async read(){return {done:true};},async close(){}};
 }};
 const a=new SegmentedPcmSpeechProvider({provider});
 const controller=new AbortController();
 const source=await a.open({text:sentences[0],
  segments:sentences.slice(0,2),signal:controller.signal});
 await until(()=>typeof finish==='function');
 controller.abort();await source.close();
 finish({read:async()=>({done:true}),close:async()=>{lateClosed++;}});
 await until(()=>lateClosed===1);
 assert.equal(lateClosed,1);
});
test('R15 existing playback session ACKs all segments and counts daily quota',async()=>{
 const h=harness();
 const manager=new StreamingSpeechSessions({provider:h.adapter,
  makeId:()=>uuid,budget:new SpeechDeliveryBudget({dailySeconds:1})});
 const started=await manager.start('learner:test',{text:sentences[0],
  segments:sentences.slice(0,3)});
 assert.equal(started.format,'pcm16-mono-24khz');
 for(let seq=0;seq<3;seq++){
  const block=await manager.next('learner:test',started.id,seq);
  assert.equal(block.pcm[0],seq+1);
  assert.equal(block.samples,2400);
  assert.equal(manager.ack('learner:test',started.id,seq).acknowledgedSeq,seq);
 }
 const done=await manager.next('learner:test',started.id,3);
 assert.equal(done.done,true);
 assert.equal(manager.metrics('learner:test').completed,1);
 assert.equal(manager.metrics('learner:test').acknowledgedSamples,7200);
 assert.equal(manager.deliveryBudget('learner:test').deliveredSamples,7200);
 assert.equal(manager.activeCount(),0);
});
test('R15 closing a session before playback never reports fabricated ACK',async()=>{
 const h=harness(),manager=new StreamingSpeechSessions({
  provider:h.adapter,makeId:()=>uuid
 });
 const s=await manager.start('learner:one',{text:sentences[0],
  segments:sentences.slice(0,2)});
 await manager.next('learner:one',s.id,0);
 assert.equal(manager.cancel('learner:one',s.id).cancelled,true);
 assert.equal(manager.metrics('learner:one').acknowledgedSamples,0);
 assert.equal(manager.metrics('learner:one').completed,0);
 assert.equal(manager.activeCount(),0);
});
