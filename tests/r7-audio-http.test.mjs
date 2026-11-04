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
    '--import','./tests/fixtures/audio-provider-preload.mjs','scripts/server.mjs'
  ],{cwd,env:{...process.env,...env},stdio:'ignore'});
  const base='http://127.0.0.1:'+env.PORT;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error('R7 server quit early');
    try{if((await fetch(base+'/api/health')).ok)return {base,child};}catch{}
    await new Promise(resolve=>setTimeout(resolve,70));
  }
  child.kill('SIGTERM');throw new Error('R7 server boot timeout');
}
async function post(base,path,body,cookie){
  const r=await fetch(base+path,{method:'POST',headers:{
    'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})
  },body:JSON.stringify(body)});
  return {status:r.status,data:await r.json(),
    cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
  const r=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
  return {status:r.status,data:await r.json()};
}
async function chunk(base,cookie,id,seq,data=Buffer.alloc(600,0x32),
  mime='audio/webm'){
  const r=await fetch(base+'/api/audio/turn/chunk',{method:'POST',headers:{
    'Content-Type':mime,'X-Alex-Turn-Id':id,'X-Alex-Chunk-Seq':String(seq),
    ...(cookie?{Cookie:cookie}:{})
  },body:data});
  return {status:r.status,data:await r.json()};
}
test('R7 real HTTP incremental turn: per-child consent, seq/size, batch ASR, metadata and revocation',{timeout:50000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r7-http-'));
 const env={
  PORT:String(50000+Math.floor(Math.random()*7000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'alex-parent-r7-test-password',ALEX_CHILD_PIN:'814293',
  ALEX_AUDIO_PROVIDER:'compatible',ALEX_AUDIO_BASE_URL:'https://speech-fixture.example/v1',
  ALEX_AUDIO_API_KEY:'private-r7-upstream-key',ALEX_AUDIO_ASR_MODEL:'fixture-asr',
  ALEX_AUDIO_TTS_MODEL:'fixture-tts',ALEX_AUDIO_VOICE:'alloy',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plan.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);const base=server.base;
  assert.equal((await get(base,'/api/audio/turn/metrics')).status,401);
  const html=await (await fetch(base+'/')).text();
  assert.ok(html.indexOf('/audio-stream-session.js')<html.indexOf('/app.js'));
  for(const asset of ['/audio-stream-session.js','/audio-vad.js']){
    const resp=await fetch(base+asset);
    assert.equal(resp.status,200);
    assert.match(resp.headers.get('content-security-policy'),/script-src 'self'/);
  }
  const parent=(await post(base,'/api/auth/login',
    {role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const a=(await post(base,'/api/profiles',
    {nickname:'Student A',ageBand:'6-8',interests:[]},parent)).data.profile;
  const b=(await post(base,'/api/profiles',
    {nickname:'Student B',ageBand:'6-8',interests:[]},parent)).data.profile;
  const ca=(await post(base,'/api/learners/set-pin',
    {profileId:a.id,pin:'318292'},parent)).data.learner;
  const cb=(await post(base,'/api/learners/set-pin',
    {profileId:b.id,pin:'318293'},parent)).data.learner;
  const learnerA=(await post(base,'/api/auth/login',
    {role:'learner',code:ca.code,secret:'318292'})).cookie;
  const learnerB=(await post(base,'/api/auth/login',
    {role:'learner',code:cb.code,secret:'318293'})).cookie;
  assert.equal((await post(base,'/api/audio/turn/start',
    {mime:'audio/webm',language:'en'},learnerA)).status,403);
  await post(base,'/api/learner/privacy',{profileId:a.id,
    preferences:{voiceInputAllowed:true,cloudAudioInputAllowed:true}},parent);
  assert.equal((await post(base,'/api/audio/turn/start',
    {mime:'audio/webm',language:'en'},learnerB)).status,403);
  const opened=await post(base,'/api/audio/turn/start',
    {mime:'audio/webm',language:'en'},learnerA);
  assert.equal(opened.status,200);
  assert.equal(opened.data.turn.transport,'incremental-http');
  assert.equal(opened.data.turn.upstream,'batch-asr-after-finish');
  const id=opened.data.turn.id;
  assert.equal((await get(base,'/api/audio/turn/status?id='+id,learnerB)).status,403);
  assert.equal((await get(base,'/api/audio/turn/status?id='+id,parent)).status,403);
  assert.equal((await chunk(base,learnerB,id,0)).status,403);
  assert.equal((await chunk(base,learnerA,id,1)).status,400);
  assert.equal((await chunk(base,learnerA,id,0,Buffer.alloc(100),'audio/wav')).status,400);
  assert.equal((await chunk(base,learnerA,id,0,Buffer.alloc(65_537))).status,400);
  const ack0=await chunk(base,learnerA,id,0,Buffer.alloc(800,0x41));
  assert.equal(ack0.status,200);
  assert.equal(ack0.data.nextSeq,1);
  assert.equal(ack0.data.totalBytes,800);
  assert.equal((await chunk(base,learnerA,id,0)).status,400);
  const ack1=await chunk(base,learnerA,id,1,Buffer.alloc(300,0x42));
  assert.equal(ack1.status,200);
  assert.equal(ack1.data.nextSeq,2);
  assert.equal((await get(base,'/api/audio/turn/status?id='+id,learnerA)).data.turn.receivedBytes,1100);
  assert.equal((await post(base,'/api/audio/turn/finish',{id},learnerB)).status,403);
  await new Promise(resolve=>setTimeout(resolve,340));
  const finished=await post(base,'/api/audio/turn/finish',{id},learnerA);
  assert.equal(finished.status,200);
  assert.equal(finished.data.text,'Hello, Alex.');
  assert.equal(finished.data.source,'cloud-asr');
  assert.equal(finished.data.requiresManualSubmit,true);
  assert.equal(finished.data.metrics.chunks,2);
  assert.equal(finished.data.metrics.totalBytes,1100);
  assert.equal(finished.data.upstream,'batch-asr-after-finish');
  assert.equal((await get(base,'/api/audio/turn/status?id='+id,learnerA)).status,400);
  const metricsA=await get(base,'/api/audio/turn/metrics',learnerA);
  const metricsB=await get(base,'/api/audio/turn/metrics',learnerB);
  assert.equal(metricsA.data.metrics.completed,1);
  assert.equal(metricsB.data.metrics.completed,0);
  assert.equal(JSON.stringify(metricsA.data).includes('Hello, Alex.'),false);
  const aud=(await get(base,'/api/audit',parent)).data.events;
  assert.ok(aud.some(row=>row.action==='audio.turn.finish'));
  assert.equal(JSON.stringify(aud).includes('Hello, Alex.'),false);
  assert.equal(JSON.stringify(aud).includes('private-r7-upstream-key'),false);

  const second=await post(base,'/api/audio/turn/start',
    {mime:'audio/webm',language:'en'},learnerA);
  assert.equal(second.status,200);
  await chunk(base,learnerA,second.data.turn.id,0);
  const revocation=await post(base,'/api/learner/privacy',{
    profileId:a.id,preferences:{cloudAudioInputAllowed:false}
  },parent);
  assert.equal(revocation.status,200);
  assert.equal((await get(base,'/api/audio/turn/status?id='+second.data.turn.id,learnerA)).status,400);
  assert.equal((await post(base,'/api/audio/turn/start',
    {mime:'audio/webm',language:'en'},learnerA)).status,403);
  const exported=(await get(base,'/api/privacy/export',parent)).data;
  assert.equal(JSON.stringify(exported).includes('Hello, Alex.'),false,
    'incremental audio transcripts must not enter parent privacy export');
  const erased=await post(base,'/api/privacy/erase',{scope:'child'},parent);
  assert.equal(erased.status,200);
  assert.equal(erased.data.erasedAudioMetricsPrincipals,1);
  assert.equal((await get(base,'/api/audio/turn/metrics',learnerA)).data.metrics.opened,0);
  assert.equal((await get(base,'/api/audio/turn/metrics',learnerB)).data.metrics.opened,0);
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
