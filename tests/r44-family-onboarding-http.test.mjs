import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const cwd=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd,env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
 let stderr='';
 child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk.slice(0,2000);});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('R44_SERVER_EXITED:'+stderr);
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(60);
 }
 child.kill('SIGTERM');throw Error('R44_SERVER_TIMEOUT:'+stderr);
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const done=once(server.child,'exit');server.child.kill('SIGTERM');await done;
}
async function req(base,path,{cookie,data}={}){
 const response=await fetch(base+path,{method:data?'POST':'GET',
  headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
  ...(data?{body:JSON.stringify(data)}:{})});
 return {status:response.status,body:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
test('R44 真实 HTTP 家庭首次使用：家长建立独立身份+默认拒绝隐私，儿童不能改授权',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r44-http-'));
 const env={
  PORT:String(48000+Math.floor(Math.random()*4000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r44-parent-password-long',
  ALEX_CHILD_PIN:'884422',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
  MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'governance.json'),
  ALEX_SKILL_TRUST_FILE:join(dir,'trust.json'),
  ALEX_SKILL_PACKAGES_FILE:join(dir,'packages.json'),
  ALEX_SKILL_TRANSACTIONS_FILE:join(dir,'transactions.json'),
  ALEX_SKILL_BATCH_WAL_FILE:join(dir,'batch-wal.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  GATEWAY_FILE:join(dir,'gateway.json'),
  PROPOSAL_FILE:join(dir,'proposals.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json')
 };
 let server;
 try{
  server=await boot(env);
  const parent=(await req(server.base,'/api/auth/login',{data:{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  const child=(await req(server.base,'/api/auth/login',{data:{
   role:'child',secret:env.ALEX_CHILD_PIN}})).cookie;
  assert.equal((await req(server.base,'/api/family/onboarding')).status,401);
  assert.equal((await req(server.base,'/api/family/onboarding',{cookie:child})).status,403);
  const first=await req(server.base,'/api/family/onboarding',{cookie:parent});
  assert.equal(first.status,200);
  assert.equal(first.body.report.nextStep,'create-profile');

  const created=await req(server.base,'/api/profiles',{cookie:parent,data:{
   nickname:'学习小朋友',ageBand:'6-8',interests:[]}});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const profileId=created.body.profile.id;
  const next=await req(server.base,'/api/family/onboarding',{cookie:parent});
  assert.equal(next.body.report.nextStep,'learner-credential');
  const credential=await req(server.base,'/api/learners/set-pin',{cookie:parent,data:{
   profileId,pin:'647219'}});
  assert.equal(credential.status,200,JSON.stringify(credential.body));
  assert.equal((await req(server.base,'/api/family/onboarding',{cookie:parent}))
   .body.report.nextStep,'privacy-review');
  const prefs={
   voiceInputAllowed:false,voiceOutputAllowed:false,
   cloudTextAllowed:false,cloudAudioInputAllowed:false,cloudAudioOutputAllowed:false,
   preferredLanguage:'bilingual',learningPace:'slow',topics:[]
  };
  const saved=await req(server.base,'/api/learner/privacy',{cookie:parent,data:{
   profileId,preferences:prefs}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const done=await req(server.base,'/api/family/onboarding',{cookie:parent});
  assert.equal(done.body.report.complete,true);
  assert.equal(done.body.report.learners[0].anyCloudGrant,false);
  assert.equal(JSON.stringify(done.body).includes('学习小朋友'),false);
  assert.equal(JSON.stringify(done.body).includes('647219'),false);
  assert.equal((await req(server.base,'/api/learner/privacy?profileId='+profileId,{
   cookie:parent})).body.preferences.cloudTextAllowed,false);
  assert.equal((await req(server.base,'/api/learner/privacy',{cookie:child,data:{
   profileId,preferences:{cloudTextAllowed:true}}})).status,403);
  const learner=(await req(server.base,'/api/auth/login',{data:{
   role:'learner',code:credential.body.learner.code,secret:'647219'}}));
  assert.equal(learner.status,200,JSON.stringify(learner.body));
  assert.equal((await req(server.base,'/api/family/onboarding',{cookie:learner.cookie})).status,403);
  assert.equal((await req(server.base,'/api/learner/privacy?profileId='+profileId,{
   cookie:learner.cookie})).status,403);
  // R45 回归：撤销孩子凭据必须同步失效已经登录的独立会话。
  const revoked=await req(server.base,'/api/learners/revoke',{cookie:parent,data:{profileId}});
  assert.equal(revoked.status,200,JSON.stringify(revoked.body));
  assert.equal(revoked.body.runtimeStopped,true);
  assert.ok(revoked.body.revokedSessions>=1);
  assert.equal((await req(server.base,'/api/family/onboarding',{
   cookie:learner.cookie})).status,401);
  assert.equal((await req(server.base,'/api/voice/turn/capabilities',{
   cookie:learner.cookie})).status,401);
  const refused=await req(server.base,'/api/auth/login',{data:{
   role:'learner',code:credential.body.learner.code,secret:'647219'}});
  assert.notEqual(refused.status,200);
  // 家长自身会话仍可读取设置状态，其他学习者不应受误伤。
  assert.equal((await req(server.base,'/api/family/onboarding',{cookie:parent})).status,200);
  // R45：重设 PIN 与撤销同等级处理，旧浏览器身份被立即取消。
  const reseeded=await req(server.base,'/api/learners/set-pin',{cookie:parent,data:{
   profileId,pin:'831649'}});
  assert.equal(reseeded.status,200);
  const fresh=await req(server.base,'/api/auth/login',{data:{
   role:'learner',code:reseeded.body.learner.code,secret:'831649'}});
  assert.equal(fresh.status,200);
  const reset=await req(server.base,'/api/learners/set-pin',{cookie:parent,data:{
   profileId,pin:'204683'}});
  assert.equal(reset.status,200);
  assert.equal(reset.body.runtimeStopped,true);
  assert.ok(reset.body.revokedSessions>=1);
  assert.equal((await req(server.base,'/api/voice/turn/capabilities',{
   cookie:fresh.cookie})).status,401);
  const newLogin=await req(server.base,'/api/auth/login',{data:{
   role:'learner',code:reset.body.learner.code,secret:'204683'}});
  assert.equal(newLogin.status,200);
  assert.equal((await req(server.base,'/api/voice/turn/capabilities',{
   cookie:newLogin.cookie})).status,200);
  assert.equal((await req(server.base,'/api/voice/turn/capabilities',{
   cookie:parent})).status,200);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
test('R44 重启后初次配置进度仍从真实档案与隐私存储计算',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r44-reboot-'));
 const env={
  PORT:String(53000+Math.floor(Math.random()*3000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r44-reboot-password-long',
  ALEX_CHILD_PIN:'885533',AGENT_PROVIDER:'rules',
  STATE_FILE:join(dir,'state.json'),PROFILES_FILE:join(dir,'profiles.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  MEMORY_FILE:join(dir,'memory.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
  ALEX_SKILL_PACKAGES_FILE:join(dir,'packages.json'),
  ALEX_SKILL_TRUST_FILE:join(dir,'trust.json'),
  ALEX_SKILL_TRANSACTIONS_FILE:join(dir,'transactions.json'),
  ALEX_SKILL_BATCH_WAL_FILE:join(dir,'batch-wal.json'),
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'governance.json')
 };
 let server;
 try{
  server=await boot(env);
  let cookie=(await req(server.base,'/api/auth/login',{
   data:{role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  const p=await req(server.base,'/api/profiles',{cookie,data:{
   nickname:'复现孩子',ageBand:'9-12',interests:[]}});
  assert.equal(p.status,200);
  const profileId=p.body.profile.id;
  await stop(server);server=null;
  server=await boot(env);
  cookie=(await req(server.base,'/api/auth/login',{
   data:{role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  const status=await req(server.base,'/api/family/onboarding',{cookie});
  assert.equal(status.status,200);
  assert.equal(status.body.report.nextStep,'learner-credential');
  assert.equal(status.body.report.learners[0].profileId,profileId);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
