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
 const child=spawn(process.execPath,[
  '--import','./tests/fixtures/r9-speech-preload.mjs','scripts/server.mjs'
 ],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('R19_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(70);
 }
 child.kill('SIGTERM');throw Error('R19_SERVER_START_TIMEOUT');
}
async function stop(server){
 if(!server)return;
 if(server.child.exitCode!==null)return;
 const completed=once(server.child,'exit');
 server.child.kill('SIGTERM');await completed;
}
async function post(base,path,data,cookie){
 const response=await fetch(base+path,{method:'POST',headers:{
  'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})
 },body:JSON.stringify(data)});
 return {status:response.status,data:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const response=await fetch(base+path,{
  headers:cookie?{Cookie:cookie}:{},cache:'no-store'});
 return {status:response.status,data:await response.json()};
}
async function next(base,cookie,id,seq){
 const response=await fetch(base+'/api/audio/playback/next',{
  method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
  body:JSON.stringify({id,seq})
 });
 return {status:response.status,
  bytes:(await response.arrayBuffer()).byteLength};
}
test('R19 localhost authenticated PCM quota survives server restart and erasure',{timeout:85000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r19-http-'));
 const ledger=join(dir,'speech-ledger.json');
 const env={
  PORT:String(43000+Math.floor(Math.random()*10000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r19-long-parent-secret',
  ALEX_CHILD_PIN:'814295',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_SPEECH_STREAM_PROVIDER:'compatible',
  ALEX_SPEECH_STREAM_BASE_URL:'https://speech-fixture.example/v1',
  ALEX_SPEECH_STREAM_API_KEY:'test-r9-private-server-key',
  ALEX_SPEECH_STREAM_MODEL:'r9-test-model',ALEX_SPEECH_STREAM_VOICE:'alloy',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_DAILY_DELIVERY_SECONDS:'1',
  ALEX_SPEECH_DELIVERY_LEDGER_FILE:ledger,
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning-plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);
  const parent=(await post(server.base,'/api/auth/login',{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const profile=(await post(server.base,'/api/profiles',{
   nickname:'R19 learner',ageBand:'6-8',interests:[]},parent)).data.profile;
  const learner=(await post(server.base,'/api/learners/set-pin',{
   profileId:profile.id,pin:'318294'},parent)).data.learner;
  const child=(await post(server.base,'/api/auth/login',{
   role:'learner',code:learner.code,secret:'318294'})).cookie;
  for(const [key,value] of Object.entries({
   voiceOutputAllowed:true,cloudAudioOutputAllowed:true
  })){
   assert.equal((await post(server.base,'/api/learner/privacy',{
    profileId:profile.id,preferences:{[key]:value}},parent)).status,200);
  }
  const first=await post(server.base,'/api/audio/playback/start',{text:'Hello'},child);
  assert.equal(first.status,200);
  for(let seq=0;seq<5;seq++){
   const chunk=await next(server.base,child,first.data.session.id,seq);
   assert.equal(chunk.status,200);assert.equal(chunk.bytes,4800);
   assert.equal((await post(server.base,'/api/audio/playback/ack',{
    id:first.data.session.id,seq},child)).status,200);
  }
  assert.equal((await get(server.base,'/api/audio/playback/metrics',child))
   .data.deliveryBudget.deliveredSamples,12000);
  assert.equal((await post(server.base,'/api/audio/playback/cancel',{
   id:first.data.session.id},child)).status,200);
  await stop(server);server=null;
  env.PORT=String(Number(env.PORT)+1);
  server=await boot(env);
  const nextChild=(await post(server.base,'/api/auth/login',{
   role:'learner',code:learner.code,secret:'318294'})).cookie;
  assert.equal((await get(server.base,'/api/audio/playback/metrics',nextChild))
   .data.deliveryBudget.deliveredSamples,12000);
  const caps=await get(server.base,'/api/audio/playback/capabilities',nextChild);
  assert.equal(caps.data.deliveryBudgetPersistence,'single-process-file');
  const second=await post(server.base,'/api/audio/playback/start',{
   text:'Second time'},nextChild);
  assert.equal(second.status,200);
  for(let seq=0;seq<5;seq++){
   assert.equal((await next(server.base,nextChild,second.data.session.id,seq)).status,200);
   assert.equal((await post(server.base,'/api/audio/playback/ack',{
    id:second.data.session.id,seq},nextChild)).status,200);
  }
  const exhausted=await next(server.base,nextChild,second.data.session.id,5);
  assert.equal(exhausted.status,429);
  assert.equal((await get(server.base,'/api/audio/playback/metrics',nextChild))
   .data.deliveryBudget.deliveredSamples,24000);
  const nextParent=(await post(server.base,'/api/auth/login',{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  assert.equal((await post(server.base,'/api/privacy/erase',{scope:'child'},nextParent))
   .status,200);
  assert.equal((await get(server.base,'/api/audio/playback/metrics',nextChild))
   .data.deliveryBudget.deliveredSamples,0);
  await stop(server);server=null;env.PORT=String(Number(env.PORT)+1);
  server=await boot(env);
  const finalChild=(await post(server.base,'/api/auth/login',{
   role:'learner',code:learner.code,secret:'318294'})).cookie;
  assert.equal((await get(server.base,'/api/audio/playback/metrics',finalChild))
   .data.deliveryBudget.deliveredSamples,0);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
