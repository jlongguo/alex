import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';
const A='learner:a',B='learner:b';
const conversation='11111111-1111-4111-8111-111111111111';
const ids=['22222222-2222-4222-8222-222222222222',
 '33333333-3333-4333-8333-333333333333'];
const speechId='44444444-4444-4444-8444-444444444444';
const later=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){
 for(let i=0;i<100;i++){if(fn())return;await later();}
 throw Error('R13_RACE_TEST_TIMEOUT');
}
test('R13 canceling a stale turn ID cannot terminate the following owner turn',async()=>{
 let index=0,resolveSecond;
 const cancelled=[];
 const manager=new VoiceTurnOrchestrator({
  makeId:()=>ids[index++],
  conversations:{
   get:()=>({id:conversation}),
   streamTurn:async(principal)=>{
    if(principal===A&&index===2)
     return await new Promise(resolve=>resolveSecond=resolve);
    return {assistant:{text:'Hi'},session:{id:conversation}};
   }
  },
  speech:{start:async()=>({id:speechId}),
   cancel:(principal,id)=>cancelled.push({principal,id})}
 });
 const first=await manager.run(A,{conversationId:conversation,text:'first'});
 assert.equal(manager.cancel(A,first.turn.id).cancelled,true);
 const second=manager.run(A,{conversationId:conversation,text:'second'});
 await until(()=>typeof resolveSecond==='function');
 assert.deepEqual(manager.cancel(A,first.turn.id),{cancelled:false});
 assert.equal(manager.activeCount(),1);
 assert.equal(manager.status(A,ids[1]).phase,'thinking');
 resolveSecond({assistant:{text:'New reply'},session:{id:conversation}});
 const done=await second;
 assert.equal(done.turn.phase,'ready');
 assert.equal(done.turn.id,ids[1]);
 assert.equal(manager.cancel(B,ids[1]).cancelled,false);
 assert.deepEqual(cancelled,[{principal:A,id:speechId}]);
 manager.cancel(A,ids[1]);
});
test('R13 user revocation after committed text suppresses downstream speech',async()=>{
 let authorized=true;
 let finishModel,created;
 const manager=new VoiceTurnOrchestrator({
  makeId:()=>ids[0],
  authorize:()=>{if(!authorized)throw Error('CHILD_CLOUD_AUDIO_DISABLED');},
  conversations:{get:()=>({id:conversation}),streamTurn:()=>
   new Promise(resolve=>finishModel=resolve)},
  speech:{start:async()=>{throw Error('TTS_SHOULD_NOT_START');},cancel(){}}
 });
 const pending=manager.run(A,{conversationId:conversation,text:'Hi',
  onCreated:id=>created=id});
 await until(()=>typeof finishModel==='function');
 assert.equal(created,ids[0]);
 authorized=false;
 finishModel({assistant:{text:'committed'},session:{id:conversation}});
 await assert.rejects(pending,/CHILD_CLOUD_AUDIO_DISABLED/);
 assert.equal(manager.activeCount(),0);
 assert.equal(manager.metrics(A).stages.readyMs.count,0);
 assert.equal(manager.metrics(A).stages.failureMs.count,1);
});
test('R13 scope erasure clears metrics after a cancelled child turn',async()=>{
 const manager=new VoiceTurnOrchestrator({
  makeId:()=>ids[0],
  conversations:{get:()=>({id:conversation}),streamTurn:()=>
   new Promise(()=>{})},
  speech:{start:async()=>({id:speechId}),cancel(){}}
 });
 const pending=manager.run(A,{conversationId:conversation,text:'never finishes'});
 await later();
 manager.cancelChildren();
 await assert.rejects(pending,/VOICE_TURN_CANCELLED/);
 assert.equal(manager.metrics(A).stages.cancelMs.count,1);
 manager.eraseScope('child');
 assert.equal(manager.metrics(A).stages.cancelMs.count,0);
 assert.equal(manager.activeCount(),0);
});
