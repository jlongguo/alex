import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTurnOrchestrator} from '../scripts/voice-turn-orchestrator.mjs';

const A='learner:profile-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='learner:profile-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV='11111111-1111-4111-8111-111111111111';
const TURN_A='22222222-2222-4222-8222-222222222222';
const TURN_B='33333333-3333-4333-8333-333333333333';
const AUDIO='44444444-4444-4444-8444-444444444444';
const deferred=()=>{let resolve,reject;
 const promise=new Promise((a,b)=>{resolve=a;reject=b;});
 return {promise,resolve,reject};
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('R45 撤销会话时上游模型无视 AbortSignal 仍不能创建 TTS 会话',async()=>{
 const model=deferred(),spoken=[],cancelled=[];
 let created;
 const voice=new VoiceTurnOrchestrator({
  conversations:{
   get:()=>({id:CONV}),
   streamTurn:()=>model.promise
  },
  speech:{start:async(principal,options)=>{spoken.push(options);return {id:AUDIO};},
   cancel:(principal,id)=>cancelled.push({principal,id})},
  makeId:()=>TURN_A
 });
 const task=voice.run(A,{conversationId:CONV,text:'你好',
  onCreated:id=>{created=id;}});
 await tick();
 assert.equal(created,TURN_A);
 assert.equal(voice.cancel(B,TURN_A).cancelled,false);
 assert.equal(voice.cancel(A,TURN_A).cancelled,true);
 await assert.rejects(task,/VOICE_TURN_CANCELLED/);
 model.resolve({assistant:{text:'这是取消后才到达的模型输出'},session:{id:CONV}});
 await tick();
 assert.equal(spoken.length,0);
 assert.equal(voice.activeCount(),0);
 assert.equal(cancelled.length,0);
});
test('R45 若 TTS 在取消后才返回成功，必须释放迟到语音会话',async()=>{
 const pending=deferred(),started=deferred(),cancelled=[];
 const voice=new VoiceTurnOrchestrator({
  conversations:{get:()=>({id:CONV}),streamTurn:async()=>
   ({assistant:{text:'可播放的句子。'},session:{id:CONV}})},
  speech:{
   start:async()=>{started.resolve();return pending.promise;},
   cancel:(principal,id)=>{cancelled.push({principal,id});return {cancelled:true};}
  },makeId:()=>TURN_A
 });
 const run=voice.run(A,{conversationId:CONV,text:'你好'});
 await started.promise;
 assert.equal(voice.cancel(A,TURN_A).cancelled,true);
 await assert.rejects(run,/VOICE_TURN_CANCELLED/);
 pending.resolve({id:AUDIO});
 await tick();
 assert.deepEqual(cancelled,[{principal:A,id:AUDIO}]);
 assert.equal(voice.activeCount(),0);
});
test('R45 取消指定儿童不能影响其他孩子已准备就绪的播放',async()=>{
 let ids=[TURN_A,TURN_B],cancelled=[];
 const voice=new VoiceTurnOrchestrator({
  conversations:{get:()=>({id:CONV}),streamTurn:async()=>({
   assistant:{text:'单独的学习回应。'},session:{id:CONV}})},
  speech:{start:async(principal)=>({id:principal===A?AUDIO:CONV}),
   cancel:(principal,id)=>{cancelled.push({principal,id});return {cancelled:true};}},
  makeId:()=>ids.shift()
 });
 const first=await voice.run(A,{conversationId:CONV,text:'孩子 A'});
 const second=await voice.run(B,{conversationId:CONV,text:'孩子 B'});
 assert.equal(first.turn.phase,'ready');
 assert.equal(second.turn.phase,'ready');
 assert.equal(voice.cancel(A,first.turn.id).cancelled,true);
 assert.equal(voice.status(B,second.turn.id).phase,'ready');
 assert.deepEqual(cancelled,[{principal:A,id:AUDIO}]);
 assert.equal(voice.cancel(B,second.turn.id).cancelled,true);
 assert.equal(voice.activeCount(),0);
});
