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
  '--import','./tests/fixtures/r9-speech-preload.mjs','scripts/server.mjs'
 ],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw Error('R9 server crashed');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await new Promise(resolve=>setTimeout(resolve,70));
 }
 child.kill('SIGTERM');throw Error('R9 HTTP startup timeout');
}
async function post(base,path,body,cookie){
 const response=await fetch(base+path,{method:'POST',headers:{
  'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})
 },body:JSON.stringify(body)});
 return {status:response.status,data:await response.json(),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const response=await fetch(base+path,{
  headers:cookie?{Cookie:cookie}:{},cache:'no-store'});
 return {status:response.status,data:await response.json()};
}
async function next(base,cookie,id,seq){
 const response=await fetch(base+'/api/audio/playback/next',{
  method:'POST',headers:{
   'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})
  },body:JSON.stringify({id,seq})
 });
 if(response.status===200)return {status:response.status,
  bytes:(await response.arrayBuffer()).byteLength,
  seq:Number(response.headers.get('x-alex-speech-seq')),
  samples:Number(response.headers.get('x-alex-speech-samples')),
  cache:response.headers.get('cache-control')};
 if(response.status===204)return {status:204};
 return {status:response.status,data:await response.json()};
}
test('R9 real localhost + fake streaming HTTPS TTS: children, grants, binary PCM, ACK and privacy',{timeout:50000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r9-http-'));
 const env={
  PORT:String(50000+Math.floor(Math.random()*6000)),
  AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r9-parent-strong-secret-phrase',
  ALEX_CHILD_PIN:'814295',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_SPEECH_STREAM_PROVIDER:'compatible',
  ALEX_SPEECH_STREAM_BASE_URL:'https://speech-fixture.example/v1',
  ALEX_SPEECH_STREAM_API_KEY:'test-r9-private-server-key',
  ALEX_SPEECH_STREAM_MODEL:'r9-test-model',
  ALEX_SPEECH_STREAM_VOICE:'alloy',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning-plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'creds.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);const base=server.base;
  const asset=await fetch(base+'/speech-playback-session.js');
  assert.equal(asset.status,200);
  assert.match(asset.headers.get('content-type'),/text\/javascript/);
  assert.match(await asset.text(),/AlexStreamingSpeechBridge/);
  const html=await (await fetch(base+'/')).text();
  assert.ok(html.indexOf('/speech-playback-session.js')<html.indexOf('/app.js'));
  assert.equal((await get(base,'/api/audio/playback/capabilities')).status,401);
  assert.equal((await post(base,'/api/audio/playback/start',{text:'hi'})).status,401);
  const parent=(await post(base,'/api/auth/login',{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const profileA=(await post(base,'/api/profiles',{
   nickname:'R9 A',ageBand:'6-8',interests:[]},parent)).data.profile;
  const profileB=(await post(base,'/api/profiles',{
   nickname:'R9 B',ageBand:'6-8',interests:[]},parent)).data.profile;
  const ca=(await post(base,'/api/learners/set-pin',{
   profileId:profileA.id,pin:'318294'},parent)).data.learner;
  const cb=(await post(base,'/api/learners/set-pin',{
   profileId:profileB.id,pin:'318295'},parent)).data.learner;
  const A=(await post(base,'/api/auth/login',{
   role:'learner',code:ca.code,secret:'318294'})).cookie;
  const B=(await post(base,'/api/auth/login',{
   role:'learner',code:cb.code,secret:'318295'})).cookie;
  assert.equal((await get(base,'/api/audio/playback/capabilities',A)).data.outputAllowed,false);
  assert.equal((await post(base,'/api/audio/playback/start',{text:'hello'},A)).status,403);
  await post(base,'/api/learner/privacy',{
   profileId:profileA.id,preferences:{voiceOutputAllowed:true}
  },parent);
  assert.equal((await post(base,'/api/audio/playback/start',{text:'hello'},A)).status,403,
   'browser read-aloud consent alone cannot enable vendor PCM TTS');
  assert.equal((await post(base,'/api/learner/privacy',{
   profileId:profileA.id,preferences:{cloudAudioOutputAllowed:true}
  },A)).status,403);
  await post(base,'/api/learner/privacy',{
   profileId:profileA.id,preferences:{cloudAudioOutputAllowed:true}
  },parent);
  const ready=await get(base,'/api/audio/playback/capabilities',A);
  assert.equal(ready.data.outputAllowed,true);
  assert.equal(ready.data.playbackProof,'client-claimed');
  assert.equal((await get(base,'/api/audio/playback/capabilities',B)).data.outputAllowed,false);
  const started=await post(base,'/api/audio/playback/start',{
   text:'Read this short story'},A);
  assert.equal(started.status,200);
  const id=started.data.session.id;
  assert.equal(started.data.session.sampleRate,24000);
  assert.equal(started.data.session.maxUnacknowledged,3);
  assert.equal((await post(base,'/api/audio/playback/status',{id},B)).status,403);
  assert.equal((await next(base,B,id,0)).status,403);
  assert.equal((await next(base,A,id,1)).status,400);
  const a=await next(base,A,id,0);
  const b=await next(base,A,id,1);
  const c=await next(base,A,id,2);
  assert.deepEqual([a.seq,b.seq,c.seq],[0,1,2]);
  assert.deepEqual([a.bytes,b.bytes,c.bytes],[4800,4800,4800]);
  assert.equal(a.samples,2400);
  assert.match(a.cache,/no-store/);
  assert.equal((await next(base,A,id,3)).status,409);
  const before=(await post(base,'/api/audio/playback/status',{id},A)).data.session;
  assert.equal(before.playedSamplesClaimed,0);
  assert.equal(before.deliveredSamples,7200);
  assert.equal(before.outstanding,3);
  assert.equal((await post(base,'/api/audio/playback/ack',{id,seq:1},A)).status,400);
  assert.equal((await post(base,'/api/audio/playback/ack',{id,seq:0},B)).status,403);
  const ack=(await post(base,'/api/audio/playback/ack',{id,seq:0},A)).data;
  assert.equal(ack.playedMsClaimed,100);
  assert.equal((await next(base,A,id,3)).status,200);
  const cancelled=await post(base,'/api/audio/playback/cancel',{id},A);
  assert.equal(cancelled.data.cancelled,true);
  assert.equal(cancelled.data.playedMsClaimed,100);
  assert.equal((await post(base,'/api/audio/playback/status',{id},A)).status,400);
  const metrics=(await get(base,'/api/audio/playback/metrics',A)).data.metrics;
  assert.equal(metrics.started,1);
  assert.equal(metrics.completed,0);
  assert.equal(metrics.cancelled,1);
  assert.equal(metrics.acknowledgedSamples,2400);
  assert.equal((await get(base,'/api/audio/playback/metrics',B)).data.metrics.started,0);
  assert.ok(!JSON.stringify(metrics).includes('Read this short story'));
  assert.equal((await post(base,'/api/audio/playback/start',{
   text:'hello'},B)).status,403);

  const second=await post(base,'/api/audio/playback/start',{
   text:'Another short story'},A);
  assert.equal(second.status,200);
  const id2=second.data.session.id;
  await next(base,A,id2,0);
  const revoked=await post(base,'/api/learner/privacy',{
   profileId:profileA.id,preferences:{cloudAudioOutputAllowed:false}
  },parent);
  assert.equal(revoked.status,200);
  assert.equal((await post(base,'/api/audio/playback/status',{id:id2},A)).status,403);
  assert.equal((await next(base,A,id2,1)).status,403);
  assert.equal((await get(base,'/api/audio/playback/capabilities',A)).data.outputAllowed,false);
  const erased=await post(base,'/api/privacy/erase',{scope:'child'},parent);
  assert.equal(erased.status,200);
  assert.equal(erased.data.erasedSpeechPlaybackPrincipals,1);
  assert.equal((await get(base,'/api/audio/playback/metrics',A)).data.metrics.started,0);
  const exported=(await get(base,'/api/privacy/export',parent)).data;
  assert.equal(JSON.stringify(exported).includes('Read this short story'),false);
  assert.equal(JSON.stringify(exported).includes('test-r9-private-server-key'),false);
 }finally{
  if(server){
   server.child.kill('SIGTERM');
   await once(server.child,'exit').catch(()=>{});
  }
  await rm(dir,{recursive:true,force:true});
 }
});
