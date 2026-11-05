import test from 'node:test';
import assert from 'node:assert/strict';
import {ProvisionalTurnText} from '../scripts/provisional-turn-text.mjs';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';
const conversation='11111111-1111-4111-8111-111111111111';
const turnId='22222222-2222-4222-8222-222222222222';
const speechId='33333333-3333-4333-8333-333333333333';
test('R16 provisional text is never speech-authorized before authoritative commit',()=>{
 const s=new ProvisionalTurnText();
 assert.equal(s.push('Hello. ').speechPermitted,false);
 assert.equal(s.push('你好！').phase,'provisional');
 const result=s.commit('Hello. 你好！');
 assert.deepEqual(result.segments,['Hello.','你好！']);
 assert.equal(result.matched,true);
 assert.equal(result.source,'authoritative-commit-only');
 assert.equal(s.snapshot().stagedChars,0);
 assert.equal(s.snapshot().phase,'discarded');
 assert.throws(()=>s.push('late'),/TURN_TEXT_STAGING_CLOSED/);
});
test('R16 provisional mismatch never replaces authoritative committed content',()=>{
 const s=new ProvisionalTurnText();
 s.push('Wrong provisional sentence. ');
 const res=s.commit('Correct authoritative sentence.');
 assert.equal(res.matched,false);
 assert.deepEqual(res.segments,['Correct authoritative sentence.']);
 assert.equal(JSON.stringify(res).includes('Wrong provisional'),false);
});
test('R16 non-content staging counters enforce bounded in-memory usage',()=>{
 const s=new ProvisionalTurnText();
 s.push('A'.repeat(600));
 assert.equal(s.snapshot().stagedChars,600);
 assert.throws(()=>s.push('B'.repeat(601)),/INVALID_TURN_TEXT_DELTA/);
 assert.throws(()=>s.push('\u0000'),/INVALID_TURN_TEXT_DELTA/);
 s.discard();
 assert.equal(s.snapshot().chunks,0);
 assert.throws(()=>s.commit('hello'),/TURN_TEXT_STAGING_CLOSED/);
});
test('R16 voice orchestration speaks only committed model text on provisional mismatch',async()=>{
 const opened=[];
 const orchestrator=new VoiceTurnOrchestrator({
  makeId:()=>turnId,
  conversations:{
   get:()=>({id:conversation}),
   async streamTurn(_p,_id,_text,{onDelta}){
    onDelta('Unsafe provisional text. ');
    onDelta('More uncommitted content.');
    return {assistant:{text:'Safe official answer. Another sentence.'},
     session:{id:conversation}};
   }
  },
  speech:{
   async start(_p,options){opened.push(options);return {id:speechId};},
   cancel(){}
  }
 });
 const result=await orchestrator.run('learner:one',{
  conversationId:conversation,text:'hi'});
 assert.equal(result.provisionalMatchedCommit,false);
 assert.deepEqual(opened[0].segments,
  ['Safe official answer.','Another sentence.']);
 assert.equal(opened[0].text,'Safe official answer.');
 assert.ok(!JSON.stringify(opened[0]).includes('Unsafe provisional'));
 orchestrator.cancel('learner:one',turnId);
});
test('R16 cancelled provisional model reply leaves no TTS output',async()=>{
 let resolveModel;
 const opened=[];
 const orchestrator=new VoiceTurnOrchestrator({
  makeId:()=>turnId,
  conversations:{get:()=>({id:conversation}),
   async streamTurn(_p,_id,_text,{onDelta}){
    onDelta('An unfinished preview.');
    return await new Promise(resolve=>resolveModel=resolve);
   }},
  speech:{start:async x=>{opened.push(x);return {id:speechId};},cancel(){}}
 });
 const pending=orchestrator.run('learner:one',{conversationId:conversation,text:'hi'});
 for(let i=0;i<40&&!resolveModel;i++)
  await new Promise(resolve=>setImmediate(resolve));
 assert.ok(resolveModel);
 orchestrator.cancel('learner:one',turnId);
 await assert.rejects(pending,/VOICE_TURN_CANCELLED/);
 resolveModel({assistant:{text:'late official reply'},session:{id:conversation}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(opened.length,0);
});
