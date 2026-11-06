import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const cwd=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=p=>access(p).then(()=>true,()=>false);
async function boot(env){
 const child=spawn(process.execPath,[
  '--import','./tests/fixtures/r18-stalled-speech-preload.mjs',
  'scripts/server.mjs'
 ],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<150;i++){
  if(child.exitCode!==null)throw Error('R18_SERVER_CRASH');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(60);
 }
 child.kill('SIGTERM');throw Error('R18_SERVER_TIMEOUT');
}
async function post(base,path,payload,cookie){
 const res=await fetch(base+path,{method:'POST',headers:{
  'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})
 },body:JSON.stringify(payload)});
 return {status:res.status,data:await res.json().catch(()=>({})),
  cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const res=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
 return {status:res.status,data:await res.json()};
}
test('R18 localhost pending PCM read: parent revocation blocks bytes and quota debit',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r18-'));
 const marker=join(dir,'vendor-read-pending'),release=join(dir,'vendor-release');
 const env={
  PORT:String(47000+Math.floor(Math.random()*15000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r18-long-parent-secret',
  ALEX_CHILD_PIN:'814295',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_SPEECH_STREAM_PROVIDER:'compatible',
  ALEX_SPEECH_STREAM_BASE_URL:'https://speech-fixture.example/v1',
  ALEX_SPEECH_STREAM_API_KEY:'test-r9-private-server-key',
  ALEX_SPEECH_STREAM_MODEL:'r9-test-model',ALEX_SPEECH_STREAM_VOICE:'alloy',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  R18_VENDOR_READ_MARKER:marker,R18_VENDOR_RELEASE_FILE:release,
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
  server=await boot(env);
  const {base}=server;
  assert.equal((await get(base,'/api/audio/playback/metrics')).status,401);
  const parent=(await post(base,'/api/auth/login',{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const profile=(await post(base,'/api/profiles',{
   nickname:'R18 learner',ageBand:'6-8',interests:[]},parent)).data.profile;
  const learner=(await post(base,'/api/learners/set-pin',{
   profileId:profile.id,pin:'318294'},parent)).data.learner;
  const child=(await post(base,'/api/auth/login',{
   role:'learner',code:learner.code,secret:'318294'})).cookie;
  for(const [name,value] of Object.entries({
   voiceOutputAllowed:true,cloudAudioOutputAllowed:true
  })){
   const grant=await post(base,'/api/learner/privacy',{
    profileId:profile.id,preferences:{[name]:value}
   },parent);
   assert.equal(grant.status,200);
  }
  const started=await post(base,'/api/audio/playback/start',{text:'Test.'},child);
  assert.equal(started.status,200,JSON.stringify(started.data));
  const id=started.data.session.id;
  let requested=false;
  const pending=fetch(base+'/api/audio/playback/next',{
   method:'POST',
   headers:{Cookie:child,'Content-Type':'application/json'},
   body:JSON.stringify({id,seq:0})
  }).then(async response=>{
   const content=await response.arrayBuffer();
   return {status:response.status,bytes:content.byteLength,
    type:response.headers.get('content-type')};
  });
  requested=true;
  for(let i=0;i<200&&!await exists(marker);i++)await sleep(15);
  assert.equal(requested,true);
  assert.equal(await exists(marker),true,'supplier read must be pending');
  const revoked=await post(base,'/api/learner/privacy',{
   profileId:profile.id,preferences:{cloudAudioOutputAllowed:false}
  },parent);
  assert.equal(revoked.status,200);
  await writeFile(release,'release','utf8');
  const answer=await Promise.race([
   pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('R18_PENDING_HTTP_TIMEOUT')),5000))
  ]);
  assert.notEqual(answer.status,200,'no PCM after parent revoked consent');
  assert.notEqual(answer.type,'application/octet-stream');
  const usage=await get(base,'/api/audio/playback/metrics',child);
  assert.equal(usage.status,200);
  assert.equal(usage.data.deliveryBudget.deliveredSamples,0);
  assert.equal(usage.data.metrics.deliveredSamples,0);
  assert.equal(usage.data.metrics.acknowledgedSamples,0);
  assert.equal((await get(base,'/api/audio/playback/capabilities',child))
   .data.outputAllowed,false);
  assert.notEqual((await post(base,'/api/audio/playback/status',{id},child))
   .status,200);
 }finally{
  if(server){
   server.child.kill('SIGTERM');
   await once(server.child,'exit').catch(()=>{});
  }
  await rm(dir,{recursive:true,force:true});
 }
});
