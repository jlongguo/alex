import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';
const A='learner:r18',B='learner:other';
const ids=['11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222'];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(testFn){
 for(let i=0;i<60;i++){if(testFn())return;await tick();}
 throw Error('R18_STALE_READ_TIMEOUT');
}
test('R18 noncooperative read is zeroed after session cancellation without charging usage',async()=>{
 let complete,created=0,closed=0;
 const mgr=new StreamingSpeechSessions({
  makeId:()=>ids[created++],
  provider:{open:async()=>({
   read:()=>new Promise(resolve=>complete=resolve),
   async close(){closed++;}
  })}
 });
 const s=await mgr.start(A,{text:'hello'});
 const pending=mgr.next(A,s.id,0);
 await until(()=>typeof complete==='function');
 assert.equal(mgr.cancel(A,s.id).cancelled,true);
 const stalePcm=Buffer.alloc(4800,0x67);
 complete({done:false,pcm:stalePcm,samples:2400});
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(stalePcm.every(b=>b===0),true);
 assert.equal(mgr.deliveryBudget(A).deliveredSamples,0);
 assert.equal(mgr.metrics(A).acknowledgedSamples,0);
 assert.equal(mgr.metrics(A).deliveredSamples,0);
 assert.equal(mgr.metrics(A).completed,0);
 assert.equal(mgr.activeCount(),0);
 assert.equal(closed,1);
});
test('R18 delayed stale read cannot affect a new owner session',async()=>{
 let completeOld,opens=0;
 const mgr=new StreamingSpeechSessions({
  makeId:()=>ids[opens],
  provider:{open:async()=>{
   const n=opens++;
   if(n===0)return {
    read:()=>new Promise(resolve=>completeOld=resolve),
    async close(){}
   };
   return {async read(){return {
    done:false,pcm:Buffer.alloc(4800),samples:2400
   };},async close(){}};
  }}
 });
 const previous=await mgr.start(A,{text:'old'});
 const previousRead=mgr.next(A,previous.id,0);
 await until(()=>typeof completeOld==='function');
 mgr.cancel(A,previous.id);
 const replacement=await mgr.start(A,{text:'new'});
 const oldPcm=Buffer.alloc(4800,0x44);
 completeOld({done:false,pcm:oldPcm,samples:2400});
 await assert.rejects(previousRead,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(oldPcm.every(b=>b===0),true);
 assert.equal(mgr.status(A,replacement.id).phase,'ready');
 const next=await mgr.next(A,replacement.id,0);
 assert.equal(next.seq,0);
 assert.equal(mgr.ack(A,replacement.id,0).acknowledgedSeq,0);
 assert.equal(mgr.metrics(A).acknowledgedSamples,2400);
 assert.equal(mgr.deliveryBudget(A).deliveredSamples,2400);
 mgr.cancel(A,replacement.id);
 assert.equal(mgr.activeCount(),0);
 assert.equal(mgr.metrics(B).started,0);
});
