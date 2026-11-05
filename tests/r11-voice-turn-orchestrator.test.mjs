import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';
const A='learner:a',B='learner:b';
const session='11111111-1111-4111-8111-111111111111';
const ids=['22222222-2222-4222-8222-222222222222',
 '33333333-3333-4333-8333-333333333333'];
const audio='44444444-4444-4444-8444-444444444444';
function fixture({reply='Hello, learner!',run,onSpeech,authorize=()=>{}}={}){
 let i=0;const calls=[],cancelled=[];
 const conversations={
  get(principal,id){if(principal===B)throw Error('UNKNOWN_CONVERSATION');
   if(id!==session)throw Error('UNKNOWN_CONVERSATION');
   return {id};},
  streamTurn:run??(async(principal,id,text,opts)=>{
   calls.push({principal,text,signal:opts.signal});
   opts.onDelta('preliminary');
   return {assistant:{role:'assistant',text:reply,source:'offline'},
    session:{id}};
  })
 };
 const speech={
  async start(principal,options){
   calls.push({principal,spoken:options.text});
   return onSpeech?onSpeech(principal,options):{id:audio,format:'pcm16-mono-24khz'};
  },
  cancel(principal,id){cancelled.push({principal,id});return {cancelled:true};}
 };
 const orchestrator=new VoiceTurnOrchestrator({
  conversations,speech,authorize,makeId:()=>ids[i++]});
 return {orchestrator,calls,cancelled};
}
test('R11 completes committed-text-first speech with separate playback ownership',async()=>{
 const {orchestrator,calls}=fixture();
 const result=await orchestrator.run(A,{conversationId:session,text:'Hello'});
 assert.equal(result.turn.phase,'ready');
 assert.equal(result.turn.speechSessionId,audio);
 assert.equal(result.turn.textCommitted,true);
 assert.equal(result.turn.audioAutoStarted,false);
 assert.equal(result.speechTextTruncated,false);
 assert.deepEqual(calls.map(c=>Object.hasOwn(c,'spoken')?'speech':'chat'),['chat','speech']);
 assert.equal(orchestrator.status(A,result.turn.id).phase,'ready');
 assert.throws(()=>orchestrator.status(B,result.turn.id),/UNKNOWN_VOICE_TURN/);
 assert.deepEqual(orchestrator.cancel(B,result.turn.id),{cancelled:false});
 assert.equal(orchestrator.cancel(A,result.turn.id).cancelled,true);
 assert.equal(orchestrator.activeCount(),0);
});
test('R11 cancel in-flight LLM prevents any speech generation',async()=>{
 let begun,finish;
 const {orchestrator,calls,cancelled}=fixture({
  run:async(_p,_id,_text,{signal})=>{
   begun?.();await new Promise(resolve=>finish=resolve);
   if(signal.aborted)throw Error('COMPANION_TURN_CANCELLED');
   return {assistant:{text:'never spoken'},session:{id:session}};
  }
 });
 const pending=orchestrator.run(A,{conversationId:session,text:'Hi'});
 await Promise.resolve();
 assert.equal(orchestrator.activeCount(),1);
 assert.equal(orchestrator.cancel(A).cancelled,true);
 finish();
 await assert.rejects(pending,/VOICE_TURN_CANCELLED/);
 assert.equal(calls.length,0);
 assert.equal(cancelled.length,0);
});
test('R11 revocation while speech opens cancels only owned generated speech',async()=>{
 let allowed=true,release;
 const {orchestrator,cancelled}=fixture({
  authorize:()=>{if(!allowed)throw Error('CHILD_CLOUD_AUDIO_DISABLED');},
  onSpeech:()=>new Promise(resolve=>release=resolve)
 });
 const task=orchestrator.run(A,{conversationId:session,text:'Hi'});
 for(let i=0;i<40&&!release;i++)
  await new Promise(resolve=>setImmediate(resolve));
 assert.ok(release,'TTS opening must be observed before consent revocation');
 allowed=false;
 release({id:audio});
 await assert.rejects(task,/CHILD_CLOUD_AUDIO_DISABLED/);
 assert.deepEqual(cancelled,[{principal:A,id:audio}]);
 assert.equal(orchestrator.activeCount(),0);
});
test('R11 error classification preserves true provider errors',async()=>{
 const {orchestrator}=fixture({onSpeech:async()=>{throw Error('SPEECH_PROVIDER_DOWN');}});
 await assert.rejects(orchestrator.run(A,{conversationId:session,text:'Hello'}),
  /SPEECH_PROVIDER_DOWN/);
 assert.equal(orchestrator.activeCount(),0);
});
test('R11 validates identity, input, single-flight and scope cancellation',async()=>{
 let complete;
 const {orchestrator}=fixture({run:async()=>new Promise(resolve=>complete=resolve)});
 await assert.rejects(orchestrator.run(A,{conversationId:session,text:'\u0001'}),
  /INVALID_VOICE_TURN_INPUT/);
 await assert.rejects(orchestrator.run(B,{conversationId:session,text:'hi'}),
  /UNKNOWN_CONVERSATION/);
 const first=orchestrator.run(A,{conversationId:session,text:'hello'});
 await Promise.resolve();
 await assert.rejects(orchestrator.run(A,{conversationId:session,text:'again'}),
  /VOICE_TURN_ALREADY_ACTIVE/);
 assert.equal(orchestrator.eraseScope('child'),1);
 complete({assistant:{text:'too late'},session:{id:session}});
 await assert.rejects(first,/VOICE_TURN_CANCELLED/);
 assert.equal(orchestrator.activeCount(),0);
 assert.throws(()=>orchestrator.eraseScope('stranger'),/INVALID_VOICE_ERASE_SCOPE/);
});
test('R11 never sends provisional output to TTS; only committed text',async()=>{
 const {orchestrator,calls}=fixture({reply:'x'.repeat(700)});
 const result=await orchestrator.run(A,{conversationId:session,text:'Hi'});
 assert.equal(result.speechTextTruncated,true);
 assert.equal(calls[1].spoken.length,500);
 assert.equal(result.assistant.text.length,700);
 orchestrator.cancel(A,result.turn.id);
});
