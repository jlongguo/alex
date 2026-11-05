import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const cwd=resolve(import.meta.dirname,'..');
async function boot(env){
 const child=spawn(process.execPath,[
  '--import','./tests/fixtures/realtime-wss-preload.mjs','scripts/server.mjs'
 ],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw Error('R8 server crashed');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await new Promise(resolve=>setTimeout(resolve,70));
 }
 child.kill('SIGTERM');throw Error('R8 HTTP startup timeout');
}
async function post(base,path,data,cookie){
 const r=await fetch(base+path,{method:'POST',headers:{
  'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})
 },body:JSON.stringify(data)});
 return {status:r.status,data:await r.json(),
  cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const r=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{},cache:'no-store'});
 return {status:r.status,data:await r.json()};
}
async function frame(base,id,seq,cookie,buffer=Buffer.alloc(4800,0x21)){
 const r=await fetch(base+'/api/audio/realtime/frame',{method:'POST',headers:{
  'Content-Type':'application/octet-stream',
  'X-Alex-Realtime-Id':id,'X-Alex-Frame-Seq':String(seq),
  ...(cookie?{Cookie:cookie}:{})
 },body:buffer});
 return {status:r.status,data:await r.json()};
}
test('R8 real HTTP: 2 children, per-child consent, streaming WSS partial, final manual transcript, revocation', {timeout:50000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r8-http-'));
 const env={
  PORT:String(50000+Math.floor(Math.random()*7000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r8-very-long-parent-password',
  ALEX_CHILD_PIN:'918237',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_REALTIME_PROVIDER:'openai-transcription',
  ALEX_REALTIME_URL:'wss://api.openai.com/v1/realtime?intent=transcription',
  ALEX_REALTIME_API_KEY:'private-realtime-fixture',
  ALEX_REALTIME_ASR_MODEL:'gpt-live-transcribe',
  ALEX_AUDIO_PROVIDER:'disabled',
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plan.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);const base=server.base;
  for(const asset of ['/realtime-pcm-session.js','/pcm-capture-processor.js']){
   const response=await fetch(base+asset);
   assert.equal(response.status,200,'browser must load actual PCM runtime: '+asset);
   assert.match(response.headers.get('content-type'),/text\/javascript/);
  }
  assert.equal((await get(base,'/api/audio/realtime/capabilities')).status,401);
  const parent=(await post(base,'/api/auth/login',{
    role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const legacy=(await post(base,'/api/auth/login',{
    role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
  const childAProfile=(await post(base,'/api/profiles',{
    nickname:'R8 A',ageBand:'6-8',interests:[]},parent)).data.profile;
  const childBProfile=(await post(base,'/api/profiles',{
    nickname:'R8 B',ageBand:'6-8',interests:[]},parent)).data.profile;
  const ca=(await post(base,'/api/learners/set-pin',{
    profileId:childAProfile.id,pin:'453782'},parent)).data.learner;
  const cb=(await post(base,'/api/learners/set-pin',{
    profileId:childBProfile.id,pin:'453783'},parent)).data.learner;
  const childA=(await post(base,'/api/auth/login',{
    role:'learner',code:ca.code,secret:'453782'})).cookie;
  const childB=(await post(base,'/api/auth/login',{
    role:'learner',code:cb.code,secret:'453783'})).cookie;
  assert.equal((await get(base,'/api/audio/realtime/capabilities',childA)).data.inputAllowed,false);
  assert.equal((await get(base,'/api/audio/realtime/capabilities',parent)).data.inputAllowed,true);
  assert.equal((await get(base,'/api/audio/realtime/capabilities',legacy)).data.inputAllowed,false);
  assert.equal((await post(base,'/api/audio/realtime/start',{language:'en'},childA)).status,403);
  await post(base,'/api/learner/privacy',{profileId:childAProfile.id,
    preferences:{voiceInputAllowed:true,cloudAudioInputAllowed:true}},parent);
  assert.equal((await get(base,'/api/audio/realtime/capabilities',childA)).data.upstreamStreaming,true);
  assert.equal((await post(base,'/api/audio/realtime/start',{language:'en'},childB)).status,403);
  const start=await post(base,'/api/audio/realtime/start',{language:'en'},childA);
  assert.equal(start.status,200);
  const id=start.data.session.id;
  assert.equal(start.data.session.format,'pcm16-mono-24khz');
  assert.equal(start.data.session.upstream,'wss-realtime-transcription');
  assert.equal((await get(base,'/api/audio/realtime/status?id='+id,childB)).status,403);
  assert.equal((await get(base,'/api/audio/realtime/status?id='+id,parent)).status,403);
  assert.equal((await frame(base,id,0,childB)).status,403);
  assert.equal((await frame(base,id,1,childA)).status,400);
  assert.equal((await frame(base,id,0,childA,Buffer.alloc(13))).status,400);
  const accepted=await frame(base,id,0,childA);
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.nextSeq,1);
  const partial=(await get(base,'/api/audio/realtime/status?id='+id,childA));
  assert.equal(partial.status,200);
  assert.equal(partial.data.session.partialTranscript,'Hello ');
  assert.equal((await frame(base,id,0,childA)).status,400);
  await new Promise(resolve=>setTimeout(resolve,380));
  assert.equal((await post(base,'/api/audio/realtime/commit',{id},childB)).status,403);
  const completed=await post(base,'/api/audio/realtime/commit',{id},childA);
  assert.equal(completed.status,200);
  assert.equal(completed.data.text,'Hello Alex');
  assert.equal(completed.data.requiresManualSubmit,true);
  assert.equal(completed.data.source,'realtime-cloud-asr');
  assert.equal(completed.data.metrics.pcmBytes,4800);
  assert.equal((await get(base,'/api/audio/realtime/status?id='+id,childA)).status,400);
  const metrics=(await get(base,'/api/audio/realtime/metrics',childA)).data.metrics;
  assert.equal(metrics.completed,1);
  assert.equal(metrics.pcmBytes,4800);
  assert.equal((await get(base,'/api/audio/realtime/metrics',childB)).data.metrics.completed,0);
  const audit=(await get(base,'/api/audit',parent)).data.events;
  assert.ok(audit.some(e=>e.action==='audio.realtime.commit'));
  assert.ok(!JSON.stringify(audit).includes('Hello Alex'));
  assert.ok(!JSON.stringify(audit).includes('private-realtime-fixture'));
  const again=await post(base,'/api/audio/realtime/start',{language:'en'},childA);
  assert.equal(again.status,200);
  const revoked=await post(base,'/api/learner/privacy',{
    profileId:childAProfile.id,preferences:{cloudAudioInputAllowed:false}},parent);
  assert.equal(revoked.status,200);
  assert.equal((await get(base,'/api/audio/realtime/status?id='+again.data.session.id,childA)).status,403);
  assert.equal((await post(base,'/api/audio/realtime/start',{language:'en'},childA)).status,403);
  const erased=await post(base,'/api/privacy/erase',{scope:'child'},parent);
  assert.equal(erased.status,200);
  assert.equal(erased.data.erasedRealtimeAudioPrincipals,1);
  assert.equal((await get(base,'/api/audio/realtime/metrics',childA)).data.metrics.opened,0);
  const exported=(await get(base,'/api/privacy/export',parent)).data;
  assert.ok(!JSON.stringify(exported).includes('Hello Alex'));
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
