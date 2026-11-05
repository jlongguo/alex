import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';
const conversation='11111111-1111-4111-8111-111111111111';
const turn='22222222-2222-4222-8222-222222222222';
const audio='33333333-3333-4333-8333-333333333333';
test('R14 only opens TTS with first complete sentence from committed reply',async()=>{
 let spoken;
 const manager=new VoiceTurnOrchestrator({
  makeId:()=>turn,
  conversations:{get:()=>({id:conversation}),
   streamTurn:async(_p,_id,_text,{onDelta})=>{
    onDelta('provisional must not be spoken');
    return {assistant:{text:'First sentence. Second sentence is longer.'},
     session:{id:conversation}};
   }},
  speech:{start:async(_p,{text})=>{spoken=text;return {id:audio};},
   cancel(){}}
 });
 const result=await manager.run('learner:one',{conversationId:conversation,text:'hello'});
 assert.equal(spoken,'First sentence.');
 assert.equal(result.speechSegmentCount,2);
 assert.equal(result.speechTextTruncated,false);
 assert.equal(result.speechSegmentsSelected,2);
 assert.equal(result.assistant.text,'First sentence. Second sentence is longer.');
 manager.cancel('learner:one',turn);
});
