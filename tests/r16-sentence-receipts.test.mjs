import test from 'node:test';
import assert from 'node:assert/strict';
import {SentencePlaybackReceipts} from '../scripts/sentence-playback-receipts.mjs';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';
import {SegmentedPcmSpeechProvider} from '../scripts/segmented-pcm-speech-provider.mjs';

const id='11111111-1111-4111-8111-111111111111';
const OWNER='learner:owner',OTHER='learner:other';

test('R16 receipts require ordered sentences and cannot claim unissued PCM',()=>{
 const ledger=new SentencePlaybackReceipts({sentenceCount:3});
 assert.throws(()=>ledger.acknowledge(0,2400,100),/SENTENCE_RECEIPT_ACK_OVERFLOW/);
 ledger.delivered(0,2400,10);
 ledger.delivered(0,2400,20);
 ledger.delivered(1,2400,30);
 ledger.acknowledge(0,2400,110);
 ledger.acknowledge(0,2400,120);
 ledger.acknowledge(1,2400,130);
 const data=ledger.snapshot();
 assert.equal(data.sentenceCount,3);
 assert.equal(data.sentences[0].framesDelivered,2);
 assert.equal(data.sentences[0].framesClaimed,2);
 assert.equal(data.sentences[1].claimedSamples,2400);
 assert.equal(data.sentences[2].deliveredSamples,0);
 assert.equal(data.playbackProof,'client-claimed-only');
 assert.throws(()=>ledger.delivered(0,2400,140),/INVALID_SENTENCE_RECEIPT_DELIVERY/);
 assert.throws(()=>ledger.acknowledge(0,2400,140),/INVALID_SENTENCE_RECEIPT_ACK/);
 assert.equal(JSON.stringify(data).includes('learner:'),false);
 ledger.cancel();
 assert.equal(ledger.snapshot().sentences.length,0);
 assert.throws(()=>ledger.delivered(2,2400,200),/SENTENCE_RECEIPTS_CANCELLED/);
});

test('R16 rejects invalid receipt dimensions and forged sample counts',()=>{
 assert.throws(()=>new SentencePlaybackReceipts({sentenceCount:0}),/INVALID_SENTENCE_RECEIPT_COUNT/);
 assert.throws(()=>new SentencePlaybackReceipts({sentenceCount:5}),/INVALID_SENTENCE_RECEIPT_COUNT/);
 const x=new SentencePlaybackReceipts({sentenceCount:1});
 for(const samples of [-1,0,2401,NaN,1.1])
  assert.throws(()=>x.delivered(0,samples,100),/INVALID_SENTENCE_RECEIPT_DELIVERY/);
 assert.throws(()=>x.delivered(0,2400,-1),/INVALID_SENTENCE_RECEIPT_DELIVERY/);
 x.delivered(0,2400,100);
 assert.throws(()=>x.acknowledge(0,2400,NaN),/INVALID_SENTENCE_RECEIPT_ACK/);
 assert.throws(()=>x.acknowledge(0,2400,-5),/INVALID_SENTENCE_RECEIPT_ACK/);
});

test('R16 old one-sentence PCM provider keeps valid receipt indexes',async()=>{
 const provider={open:async()=>({
  index:0,async read(){
   if(this.index++)return {done:true};
   return {done:false,pcm:Buffer.alloc(4800),samples:2400};
  },async close(){}
 })};
 const mgr=new StreamingSpeechSessions({provider,makeId:()=>id});
 const started=await mgr.start(OWNER,{text:'hello'});
 const chunk=await mgr.next(OWNER,started.id,0);
 assert.equal(chunk.sentenceIndex,0);
 assert.equal(chunk.sentenceCount,1);
 assert.equal(mgr.status(OWNER,started.id).sentenceReceipts.sentences[0].deliveredSamples,2400);
 assert.throws(()=>mgr.status(OTHER,started.id),/SPEECH_SESSION_FORBIDDEN/);
 assert.equal(mgr.ack(OWNER,started.id,0).sentenceIndex,0);
 assert.equal(mgr.status(OWNER,started.id).sentenceReceipts.sentences[0].claimedSamples,2400);
 assert.equal((await mgr.next(OWNER,started.id,1)).done,true);
 assert.equal(mgr.activeCount(),0);
});

test('R16 sentence index flows across one logical sequence and owner-only receipts',async()=>{
 const sentences=['One.','Two.','Three.'];
 const provider=new SegmentedPcmSpeechProvider({provider:{
  async open({text}){
   let n=0;
   return {async read(){
    if(n++)return {done:true};
    return {done:false,pcm:Buffer.alloc(4800),samples:2400};
   },async close(){}};
  }
 }});
 const mgr=new StreamingSpeechSessions({provider,makeId:()=>id});
 const session=await mgr.start(OWNER,{text:sentences[0],segments:sentences});
 for(let i=0;i<3;i++){
  const chunk=await mgr.next(OWNER,session.id,i);
  assert.equal(chunk.seq,i);
  assert.equal(chunk.sentenceIndex,i);
  assert.equal(chunk.sentenceCount,3);
  assert.equal(mgr.ack(OWNER,session.id,i).sentenceIndex,i);
 }
 const before=mgr.status(OWNER,session.id);
 assert.deepEqual(before.sentenceReceipts.sentences.map(x=>x.claimedSamples),
  [2400,2400,2400]);
 assert.equal(before.sentenceReceipts.playbackProof,'client-claimed-only');
 assert.equal((await mgr.next(OWNER,session.id,3)).done,true);
});

test('R16 cancel clears all session-held sentence receipts and pending audio',async()=>{
 const provider=new SegmentedPcmSpeechProvider({provider:{
  async open(){return {read:async()=>({done:false,pcm:Buffer.alloc(4800),samples:2400}),
   close:async()=>{}};}
 }});
 const mgr=new StreamingSpeechSessions({provider,makeId:()=>id});
 const s=await mgr.start(OWNER,{text:'One.',segments:['One.','Two.']});
 await mgr.next(OWNER,s.id,0);
 assert.equal(mgr.status(OWNER,s.id).sentenceReceipts.sentences[0].framesDelivered,1);
 assert.equal(mgr.cancel(OWNER,s.id).cancelled,true);
 assert.equal(mgr.activeCount(),0);
 assert.throws(()=>mgr.status(OWNER,s.id),/UNKNOWN_SPEECH_SESSION/);
 assert.equal(mgr.metrics(OWNER).acknowledgedSamples,0);
});

test('R16 rejects skipped first sentence and does not debit learner quota',async()=>{
 const receipt=new SentencePlaybackReceipts({sentenceCount:3});
 assert.throws(()=>receipt.delivered(1,2400,1),
  /INVALID_SENTENCE_RECEIPT_DELIVERY/);
 assert.throws(()=>receipt.acknowledge(1,2400,1),
  /INVALID_SENTENCE_RECEIPT_ACK/);
 const provider={open:async()=>({async read(){return {
  done:false,pcm:Buffer.alloc(4800),samples:2400,sentenceIndex:1
 };},async close(){}})};
 const manager=new StreamingSpeechSessions({provider,makeId:()=>id});
 const session=await manager.start(OWNER,{text:'a',segments:['a','b']});
 await assert.rejects(manager.next(OWNER,session.id,0),
  /SPEECH_INVALID_SENTENCE_INDEX/);
 assert.equal(manager.deliveryBudget(OWNER).deliveredSamples,0);
 assert.equal(manager.metrics(OWNER).deliveredSamples,0);
 assert.equal(manager.activeCount(),0);
});
