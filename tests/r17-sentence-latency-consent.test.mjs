import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';
import {SegmentedPcmSpeechProvider} from '../scripts/segmented-pcm-speech-provider.mjs';
const A='learner:a',B='learner:b';
const ids=['11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222'];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){
 for(let i=0;i<100;i++){if(fn())return;await tick();}
 throw Error('R17_TIMEOUT');
}
test('R17 records bounded sentence delivery and client ACK transitions deterministically',async()=>{
 let clock=1000,i=0;
 const provider=new SegmentedPcmSpeechProvider({provider:{
  async open(){let n=0;return {
   async read(){
    if(n++)return {done:true};
    clock+=10;
    return {done:false,pcm:Buffer.alloc(4800),samples:2400};
   },async close(){}
  };}
 }});
 const mgr=new StreamingSpeechSessions({provider,now:()=>clock,makeId:()=>ids[i++]});
 const s=await mgr.start(A,{text:'One.',segments:['One.','Two.','Three.']});
 for(let n=0;n<3;n++){
  const frame=await mgr.next(A,s.id,n);
  assert.equal(frame.sentenceIndex,n);
  clock+=15;
  assert.equal(mgr.ack(A,s.id,n).sentenceIndex,n);
 }
 const m=mgr.latencyMetrics(A);
 assert.equal(m.sentenceFirstDeliveryMs.count,3);
 assert.equal(m.sentenceHandoffMs.count,2);
 assert.equal(m.sentenceFirstAckMs.count,3);
 assert.equal(m.sentenceAckTransitionMs.count,2);
 assert.equal(m.sentenceHandoffMs.p50Ms,25);
 assert.equal(m.sentenceHandoffMs.p95Ms,25);
 assert.equal(m.sentenceAckTransitionMs.p50Ms,25);
 assert.equal(m.acousticProof,false);
 assert.equal(JSON.stringify(m).includes('One.'),false);
 await mgr.next(A,s.id,3);
 assert.equal(mgr.metrics(A).completed,1);
 assert.equal(mgr.latencyMetrics(B).sentenceHandoffMs.count,0);
});
test('R17 authorization revoked during a pending provider read fails closed with no charged samples',async()=>{
 let allow=true,resolveRead,closed=0;
 const mgr=new StreamingSpeechSessions({
  provider:{open:async()=>({
   read:()=>new Promise(resolve=>resolveRead=resolve),
   close:async()=>{closed++;}
  })},
  authorizeDelivery:()=>{if(!allow)throw Error('CHILD_CLOUD_AUDIO_DISABLED');},
  makeId:()=>ids[0]
 });
 const s=await mgr.start(A,{text:'Test'});
 const next=mgr.next(A,s.id,0);
 await until(()=>typeof resolveRead==='function');
 allow=false;
 const rejectedPcm=Buffer.alloc(4800,0x55);
 resolveRead({done:false,pcm:rejectedPcm,samples:2400});
 await assert.rejects(next,/CHILD_CLOUD_AUDIO_DISABLED/);
 assert.equal(mgr.deliveryBudget(A).deliveredSamples,0);
 assert.equal(mgr.metrics(A).deliveredSamples,0);
 assert.equal(mgr.latencyMetrics(A).sentenceFirstDeliveryMs.count,0);
 assert.equal(mgr.activeCount(),0);
 assert.equal(rejectedPcm.every(byte=>byte===0),true);
 assert.equal(closed,1);
});
test('R17 revocation between two sentences prevents next provider read and preserves first ACK',async()=>{
 let allowed=true,reads=0;
 const provider=new SegmentedPcmSpeechProvider({provider:{
  async open(){let n=0;return {async read(){
   reads++;
   if(n++)return {done:true};
   return {done:false,pcm:Buffer.alloc(4800),samples:2400};
  },async close(){}};}
 }});
 const mgr=new StreamingSpeechSessions({provider,
  authorizeDelivery:()=>{if(!allowed)throw Error('CHILD_CLOUD_AUDIO_DISABLED');},
  makeId:()=>ids[0]});
 const s=await mgr.start(A,{text:'First.',segments:['First.','Second.']});
 await mgr.next(A,s.id,0);
 mgr.ack(A,s.id,0);
 allowed=false;
 const prior=reads;
 await assert.rejects(mgr.next(A,s.id,1),/CHILD_CLOUD_AUDIO_DISABLED/);
 assert.equal(reads,prior);
 assert.equal(mgr.deliveryBudget(A).deliveredSamples,2400);
 assert.equal(mgr.metrics(A).acknowledgedSamples,2400);
 assert.equal(mgr.latencyMetrics(A).sentenceHandoffMs.count,0);
 assert.equal(mgr.activeCount(),0);
 assert.equal(mgr.cancel(A,s.id).cancelled,false);
});
test('R17 cancelled streams never fabricate a sentence transition or completion',async()=>{
 const provider={open:async()=>({read:async()=>({
  done:false,pcm:Buffer.alloc(4800),samples:2400
 }),close:async()=>{}})};
 const mgr=new StreamingSpeechSessions({provider,makeId:()=>ids[0]});
 const s=await mgr.start(A,{text:'A.'});
 await mgr.next(A,s.id,0);
 assert.equal(mgr.cancel(A,s.id).cancelled,true);
 const m=mgr.latencyMetrics(A);
 assert.equal(m.sentenceHandoffMs.count,0);
 assert.equal(m.sentenceAckTransitionMs.count,0);
 assert.equal(m.completionMs.count,0);
 mgr.erasePrincipal(A);
 assert.equal(mgr.latencyMetrics(A).sentenceFirstDeliveryMs.count,0);
});
test('R17 invalid authorizer configuration fails before starting any provider',()=>{
 assert.throws(()=>new StreamingSpeechSessions({
  provider:{open:async()=>{}},authorizeDelivery:true
 }),/INVALID_SPEECH_DELIVERY_AUTHORIZER/);
});
