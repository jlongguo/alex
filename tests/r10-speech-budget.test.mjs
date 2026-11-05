import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechDeliveryBudget} from '../scripts/speech-delivery-budget.mjs';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';
const A='learner:a',B='learner:b';
const provider=chunks=>({open:async()=>({index:0,async read(){
  if(this.index++>=chunks)return {done:true};
  return {done:false,pcm:Buffer.alloc(4800),samples:2400};
},async close(){}})});
test('R10 daily quota respects UTC rollover and child isolation',()=>{
  let now=Date.UTC(2026,10,6,23,59,59);
  const b=new SpeechDeliveryBudget({dailySeconds:1,now:()=>now});
  for(let i=0;i<10;i++)b.consume(A,2400);
  assert.equal(b.snapshot(A).remainingSamples,0);
  assert.throws(()=>b.consume(A,1),/SPEECH_DAILY_DELIVERY_LIMIT/);
  assert.equal(b.snapshot(B).remainingMs,1000);
  now+=2000;
  assert.equal(b.snapshot(A).remainingMs,1000);
});
test('R10 quota input validation and scope-specific privacy erase',()=>{
  assert.throws(()=>new SpeechDeliveryBudget({dailySeconds:0}),/INVALID_SPEECH_BUDGET_CONFIG/);
  const b=new SpeechDeliveryBudget();
  assert.throws(()=>b.consume(A,0),/INVALID_SPEECH_BUDGET_SAMPLES/);
  b.consume(A,2400);b.consume(B,2400);b.consume('parent',2400);
  assert.equal(b.eraseScope('child'),2);
  assert.equal(b.snapshot(A).deliveredSamples,0);
  assert.equal(b.snapshot('parent').deliveredSamples,2400);
  assert.equal(b.eraseScope('parent'),1);
});
test('R10 session next enforces quota across utterances and learners',async()=>{
  const b=new SpeechDeliveryBudget({dailySeconds:1});
  const mgr=new StreamingSpeechSessions({provider:provider(20),budget:b});
  const s=await mgr.start(A,{text:'hello'});
  for(let seq=0;seq<10;seq++){
    const frame=await mgr.next(A,s.id,seq);
    assert.equal(frame.samples,2400);mgr.ack(A,s.id,seq);
  }
  await assert.rejects(mgr.next(A,s.id,10),/SPEECH_DAILY_DELIVERY_LIMIT/);
  assert.equal(mgr.deliveryBudget(A).deliveredSamples,24000);
  mgr.cancel(A,s.id);
  await assert.rejects(mgr.start(A,{text:'again'}),/SPEECH_DAILY_DELIVERY_LIMIT/);
  const second=await mgr.start(B,{text:'other child'});
  assert.ok(second.id);
  mgr.erasePrincipal(A);
  assert.equal(mgr.deliveryBudget(A).deliveredSamples,0);
});
test('R10 failed provider read does not consume delivered samples',async()=>{
  const mgr=new StreamingSpeechSessions({provider:{open:async()=>({
    read:async()=>{throw Error('VENDOR_FAILED');},close:async()=>{}
  })}});
  const s=await mgr.start(A,{text:'hello'});
  await assert.rejects(mgr.next(A,s.id,0),/VENDOR_FAILED/);
  assert.equal(mgr.deliveryBudget(A).deliveredSamples,0);
});
