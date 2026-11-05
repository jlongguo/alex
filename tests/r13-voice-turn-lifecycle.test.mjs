import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTurnTelemetry} from '../scripts/voice-turn-telemetry.mjs';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';
const id='11111111-1111-4111-8111-111111111111';
const conversation='22222222-2222-4222-8222-222222222222';
const speechId='33333333-3333-4333-8333-333333333333';
const A='learner:one',B='learner:two';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async predicate=>{
 for(let i=0;i<100;i++){if(predicate())return;await tick();}
 throw Error('TEST_CONDITION_TIMEOUT');
};
test('R13 deterministic turn stage metrics reveal only durations with bounded percentiles',async()=>{
 let now=1000;
 const telemetry=new VoiceTurnTelemetry({windowSize:3});
 const calls=[];
 const conversations={
  get:()=>({id:conversation}),
  async streamTurn(_p,_id,_text,{signal}){
   assert.equal(signal.aborted,false);
   now+=30;
   return {assistant:{text:'Speech after commit'},session:{id:conversation}};
  }
 };
 const speech={async start(){now+=70;return {id:speechId};},
  cancel(_p,id){calls.push(id);}};
 const orchestrator=new VoiceTurnOrchestrator({
  conversations,speech,telemetry,now:()=>now,makeId:()=>id
 });
 const result=await orchestrator.run(A,{conversationId:conversation,text:'hello'});
 assert.equal(result.turn.phase,'ready');
 const snapshot=orchestrator.metrics(A);
 assert.deepEqual(snapshot.stages.modelCommitMs,{count:1,p50Ms:30,p95Ms:30});
 assert.deepEqual(snapshot.stages.speechOpenMs,{count:1,p50Ms:70,p95Ms:70});
 assert.deepEqual(snapshot.stages.readyMs,{count:1,p50Ms:100,p95Ms:100});
 assert.equal(snapshot.metric,'server-stage-duration-not-acoustic-proof');
 assert.equal(JSON.stringify(snapshot).includes('Speech after commit'),false);
 assert.equal(orchestrator.metrics(B).stages.readyMs.count,0);
 orchestrator.cancel(A,id);
 assert.deepEqual(calls,[speechId]);
});
test('R13 cancelled non-cooperative model resolves the request before its own late reply',async()=>{
 let resolveModel,created;
 const telemetry=new VoiceTurnTelemetry();
 const orchestrator=new VoiceTurnOrchestrator({
  telemetry,makeId:()=>id,
  conversations:{get:()=>({id:conversation}),
   streamTurn:()=>new Promise(resolve=>resolveModel=resolve)},
  speech:{start:async()=>{throw Error('MUST_NOT_OPEN_TTS');},cancel(){}}
 });
 const pending=orchestrator.run(A,{conversationId:conversation,text:'hello',
  onCreated:value=>created=value});
 await until(()=>typeof resolveModel==='function');
 assert.equal(created,id);
 assert.equal(orchestrator.cancel(A,id).cancelled,true);
 await assert.rejects(pending,/VOICE_TURN_CANCELLED/);
 assert.equal(orchestrator.activeCount(),0);
 resolveModel({assistant:{text:'late output'},session:{id:conversation}});
 await tick();
 assert.equal(orchestrator.metrics(A).stages.cancelMs.count,1);
 assert.equal(orchestrator.metrics(A).stages.modelCommitMs.count,0);
});
test('R13 late TTS open is immediately canceled after owner terminates turn',async()=>{
 let openSpeech,opened=0,stopped=[];
 const orchestrator=new VoiceTurnOrchestrator({
  makeId:()=>id,
  conversations:{get:()=>({id:conversation}),
   streamTurn:async()=>({assistant:{text:'committed'},session:{id:conversation}})},
  speech:{start:()=>{opened++;return new Promise(resolve=>openSpeech=resolve);},
   cancel:(p,x)=>stopped.push({p,x})}
 });
 const pending=orchestrator.run(A,{conversationId:conversation,text:'hello'});
 await until(()=>typeof openSpeech==='function');
 assert.equal(opened,1);
 assert.equal(orchestrator.cancel(A,id).cancelled,true);
 await assert.rejects(pending,/VOICE_TURN_CANCELLED/);
 openSpeech({id:speechId});
 await until(()=>stopped.length===1);
 assert.deepEqual(stopped,[{p:A,x:speechId}]);
 assert.equal(orchestrator.activeCount(),0);
});
test('R13 callback can cancel exactly the newly allocated turn before cloud use',async()=>{
 let modelCalls=0;
 const orchestrator=new VoiceTurnOrchestrator({
  makeId:()=>id,
  conversations:{get:()=>({id:conversation}),
   streamTurn:async()=>{modelCalls++;return {assistant:{text:'never'}};}},
  speech:{start:async()=>({id:speechId}),cancel(){}}
 });
 await assert.rejects(orchestrator.run(A,{
  conversationId:conversation,text:'hello',
  onCreated:created=>orchestrator.cancel(A,created)
 }),/VOICE_TURN_CANCELLED/);
 assert.equal(modelCalls,0);
 assert.equal(orchestrator.activeCount(),0);
});
test('R13 telemetry validates bounds, window and scoped privacy erase',()=>{
 const t=new VoiceTurnTelemetry({windowSize:3});
 for(const value of [10,20,30,40])t.record(A,'readyMs',value);
 t.record(B,'readyMs',100);t.record('parent','readyMs',50);
 assert.deepEqual(t.snapshot(A).stages.readyMs,{count:3,p50Ms:30,p95Ms:40});
 for(const bad of [Infinity,NaN,-1,120001])
  assert.throws(()=>t.record(A,'readyMs',bad),/INVALID_VOICE_TELEMETRY_SAMPLE/);
 assert.throws(()=>t.record(A,'rawSpeech',10),/INVALID_VOICE_TELEMETRY_SAMPLE/);
 assert.equal(t.eraseScope('child'),2);
 assert.equal(t.snapshot(A).stages.readyMs.count,0);
 assert.equal(t.snapshot('parent').stages.readyMs.count,1);
 assert.equal(t.eraseScope('parent'),1);
});
