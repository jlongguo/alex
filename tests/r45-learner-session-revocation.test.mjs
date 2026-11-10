import test from 'node:test';
import assert from 'node:assert/strict';
import {revokeLearnerRuntime} from '../scripts/learner-session-revocation.mjs';

const A='profile-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='profile-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){
 const calls=[],record=(name)=>principal=>{calls.push({name,principal});return true;};
 const auth={revokeLearner:profileId=>{
  calls.push({name:'auth',principal:profileId});return 2;
 }};
 return {calls,options:{profileId:A,auth,abortCompanion:record('chat'),
  audioGate:{cancel:record('audio-gate')},
  audioIngress:{erasePrincipal:record('audio-ingress')},
  realtimeSessions:{erasePrincipal:record('realtime')},
  speechPlayback:{erasePrincipal:record('playback')},
  voiceTurns:{erasePrincipal:record('voice-turn')}}};
}
test('R45 撤销登录凭据必须终止该孩子全部活跃会话，且不触及其他孩子',()=>{
 const {calls,options}=fixture();
 const result=revokeLearnerRuntime(options);
 assert.deepEqual(result,{revokedSessions:2,principalStopped:true});
 assert.deepEqual(calls.map(x=>x.name),[
  'auth','chat','audio-gate','audio-ingress','realtime','playback','voice-turn']);
 assert.equal(calls[0].principal,A);
 assert.ok(calls.slice(1).every(x=>x.principal==='learner:'+A));
 assert.ok(calls.every(x=>!x.principal.includes(B)));
});
test('R45 无可选云端会话时仍注销 Cookie 和本地录音',()=>{
 const {calls,options}=fixture();
 delete options.realtimeSessions;
 delete options.speechPlayback;
 delete options.voiceTurns;
 const result=revokeLearnerRuntime(options);
 assert.equal(result.revokedSessions,2);
 assert.deepEqual(calls.map(x=>x.name),['auth','chat','audio-gate','audio-ingress']);
});
test('R45 拒绝非法 profile id 防止跨主体作用域注入',()=>{
 const {calls,options}=fixture();
 for(const value of ['parent','child','../other',B+'/audio',null,undefined]){
  assert.throws(()=>revokeLearnerRuntime({...options,profileId:value}),
   /INVALID_LEARNER_PROFILE/);
 }
 assert.deepEqual(calls,[]);
});
test('R45 缺少核心取消能力时失败关闭，不能只做部分注销',()=>{
 const {calls,options}=fixture();
 delete options.audioIngress;
 assert.throws(()=>revokeLearnerRuntime(options),
  /INVALID_LEARNER_REVOCATION_CONFIG/);
 assert.deepEqual(calls,[]);
});
