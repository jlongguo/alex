import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';
const conv='11111111-1111-4111-8111-111111111111';
const turn='22222222-2222-4222-8222-222222222222';
const audio='33333333-3333-4333-8333-333333333333';
function make(reply){
 const calls=[];
 const manager=new VoiceTurnOrchestrator({
  makeId:()=>turn,
  conversations:{get:()=>({id:conv}),
   streamTurn:async(_p,_id,_text,{onDelta})=>{
    onDelta('untrusted provisional content! ');
    return {assistant:{text:reply},session:{id:conv}};
   }},
  speech:{start:async(_p,input)=>{
   calls.push(input);return {id:audio,format:'pcm16-mono-24khz'};},
   cancel(){}}
 });
 return {manager,calls};
}
test('R15 voice turn passes committed multi-sentence text with first-sentence compatibility',async()=>{
 const {manager,calls}=make('Hello. How are you? 很高兴认识你。');
 const result=await manager.run('learner:one',{conversationId:conv,text:'Hi'});
 assert.equal(result.turn.phase,'ready');
 assert.deepEqual(calls[0].segments,['Hello.','How are you?','很高兴认识你。']);
 assert.equal(calls[0].text,'Hello.');
 assert.equal(result.speechSegmentsSelected,3);
 assert.equal(result.speechSegmentCount,3);
 assert.equal(result.speechTextTruncated,false);
 assert.ok(!JSON.stringify(calls[0]).includes('untrusted provisional'));
 manager.cancel('learner:one',turn);
});
test('R15 voice turn caps selected sentences, retains committed full chat reply',async()=>{
 const reply=Array.from({length:7},(_,i)=>'Sentence '+i+'.').join(' ');
 const {manager,calls}=make(reply);
 const result=await manager.run('learner:one',{conversationId:conv,text:'Hi'});
 assert.equal(calls[0].segments.length,4);
 assert.equal(result.assistant.text,reply);
 assert.equal(result.speechSegmentCount,7);
 assert.equal(result.speechSegmentsSelected,4);
 assert.equal(result.speechTextTruncated,true);
 manager.cancel('learner:one',turn);
});
