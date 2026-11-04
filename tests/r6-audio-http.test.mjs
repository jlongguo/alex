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
    if(child.exitCode!==null)throw new Error('R6 server crashed: '+child.exitCode);
    try{const r=await fetch(base+'/api/health');if(r.ok)return {child,base};}catch{}
    await new Promise(done=>setTimeout(done,70));
  }
  child.kill('SIGTERM');throw new Error('R6 server boot timeout');
}
async function post(base,path,payload,cookie){
 const r=await fetch(base+path,{method:'POST',
   headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
   body:JSON.stringify(payload)});
 const response=await r.json();
 return {status:r.status,data:response,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const r=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
 return {status:r.status,data:await r.json()};
}
async function upload(base,cookie,{mime='audio/webm',duration=1200,buffer=Buffer.alloc(1024,0x42),language='en'}={}){
 const r=await fetch(base+'/api/audio/transcribe',{method:'POST',headers:{
  'Content-Type':mime,'X-Alex-Audio-Duration-Ms':String(duration),
  'X-Alex-Language':language,...(cookie?{Cookie:cookie}:{})
 },body:buffer});
 return {status:r.status,data:await r.json()};
}
async function synth(base,cookie,text='Hello Alex'){
 const r=await fetch(base+'/api/audio/speak',{
  method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
  body:JSON.stringify({text,language:'en'})
 });
 if(r.ok)return {status:r.status,bytes:(await r.arrayBuffer()).byteLength,
   type:r.headers.get('content-type'),cache:r.headers.get('cache-control')};
 return {status:r.status,data:await r.json()};
}
test('R6 actual HTTP routes enforce separate child ASR/TTS approval, allowlists and per-user isolation',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r6-http-'));
 const env={
  PORT:String(49000+Math.floor(Math.random()*9000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'safe-r6-parent-password-example',ALEX_CHILD_PIN:'193827',
  ALEX_AUDIO_PROVIDER:'compatible',ALEX_AUDIO_BASE_URL:'https://speech-fixture.example/v1',
  ALEX_AUDIO_API_KEY:'private-fixture-key',ALEX_AUDIO_ASR_MODEL:'fixture-asr',
  ALEX_AUDIO_TTS_MODEL:'fixture-tts',ALEX_AUDIO_VOICE:'alloy',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans-v1.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);
  const base=server.base;
  const voiceAsset=await fetch(base+'/audio-session.js');
  assert.equal(voiceAsset.status,200);
  assert.match(voiceAsset.headers.get('content-type'),/text\/javascript/);
  assert.match(await voiceAsset.text(),/class AlexCloudAudioBridge/);
  const html=await (await fetch(base+'/')).text();
  assert.ok(html.indexOf('/audio-session.js')<html.indexOf('/app.js'));
  assert.equal((await get(base,'/api/audio/capabilities')).status,401);
  assert.equal((await upload(base,null)).status,401);
  const parent=(await post(base,'/api/auth/login',{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const oldChild=(await post(base,'/api/auth/login',{
   role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
  const p=(await post(base,'/api/profiles',{nickname:'P',ageBand:'6-8',interests:[]},parent)).data.profile;
  const q=(await post(base,'/api/profiles',{nickname:'Q',ageBand:'6-8',interests:[]},parent)).data.profile;
  const pinP=(await post(base,'/api/learners/set-pin',{profileId:p.id,pin:'529198'},parent)).data.learner;
  const pinQ=(await post(base,'/api/learners/set-pin',{profileId:q.id,pin:'529199'},parent)).data.learner;
  const childP=(await post(base,'/api/auth/login',{
   role:'learner',code:pinP.code,secret:'529198'})).cookie;
  const childQ=(await post(base,'/api/auth/login',{
   role:'learner',code:pinQ.code,secret:'529199'})).cookie;
  assert.equal((await get(base,'/api/audio/capabilities',childP)).data.inputAllowed,false);
  assert.equal((await get(base,'/api/audio/capabilities',childP)).data.outputAllowed,false);
  assert.equal((await get(base,'/api/audio/capabilities',oldChild)).data.inputAllowed,false);
  assert.equal((await upload(base,childP)).status,403);
  assert.equal((await synth(base,childP)).status,403);
  // R5 browser-only consent must NOT authorize uploading audio to a vendor.
  const browserOnly=await post(base,'/api/learner/privacy',{
   profileId:p.id,preferences:{voiceInputAllowed:true,voiceOutputAllowed:true}
  },parent);
  assert.equal(browserOnly.status,200);
  assert.equal((await upload(base,childP)).status,403);
  assert.equal((await synth(base,childP)).status,403);
  assert.equal((await post(base,'/api/learner/privacy',{
   profileId:p.id,preferences:{cloudAudioInputAllowed:true,cloudAudioOutputAllowed:true}
  },childP)).status,403);
  const grant=await post(base,'/api/learner/privacy',{
   profileId:p.id,preferences:{cloudAudioInputAllowed:true,cloudAudioOutputAllowed:true}
  },parent);
  assert.equal(grant.status,200);
  assert.equal((await get(base,'/api/audio/capabilities',childP)).data.inputAllowed,true);
  assert.equal((await get(base,'/api/audio/capabilities',childP)).data.outputAllowed,true);
  assert.equal((await get(base,'/api/audio/capabilities',childQ)).data.inputAllowed,false);
  assert.equal((await upload(base,childQ)).status,403);
  assert.equal((await upload(base,oldChild)).status,403);
  assert.equal((await upload(base,childP,{mime:'text/html'})).status,400);
  assert.equal((await upload(base,childP,{duration:25000})).status,400);
  const transcript=await upload(base,childP);
  assert.equal(transcript.status,200);
  assert.equal(transcript.data.text,'Hello, Alex.');
  assert.equal(transcript.data.source,'cloud-asr');
  assert.equal(transcript.data.validated,false);
  assert.equal(transcript.data.requiresManualSubmit,true);
  const generated=await synth(base,childP);
  assert.equal(generated.status,200);
  assert.equal(generated.type,'audio/mpeg');
  assert.equal(generated.bytes,1024);
  assert.match(generated.cache,/no-store/);
  const audioAudit=(await get(base,'/api/audit',parent)).data.events;
  assert.ok(audioAudit.some(e=>e.action==='audio.transcribe'&&e.learnerId===p.id));
  assert.ok(audioAudit.some(e=>e.action==='audio.speak'&&e.learnerId===p.id));
  assert.ok(audioAudit.every(e=>!('text' in e)&&!('audio' in e)&&!('apiKey' in e)));
  assert.equal(JSON.stringify(audioAudit).includes('Hello, Alex.'),false);
  // Cancel a real in-flight localhost JSON request routed to a deliberately
  // stalled fake HTTPS speech provider; no audio may be committed afterward.
  const delayed=fetch(base+'/api/audio/speak',{method:'POST',headers:{
    'Content-Type':'application/json',Cookie:childP
  },body:JSON.stringify({text:'SLOW_AUDIO_CANCEL_TEST',language:'en'})});
  await new Promise(resolve=>setTimeout(resolve,120));
  const cancellation=await post(base,'/api/audio/cancel',{},childP);
  assert.equal(cancellation.status,200);
  assert.equal(cancellation.data.cancelled,true);
  const cancelledResponse=await delayed;
  assert.equal(cancelledResponse.status,409);
  assert.equal((await post(base,'/api/audio/cancel',{},childP)).data.cancelled,false);
  const revocation=await post(base,'/api/learner/privacy',{
   profileId:p.id,preferences:{cloudAudioInputAllowed:false}
  },parent);
  assert.equal(revocation.status,200);
  assert.equal((await upload(base,childP)).status,403);
  assert.equal((await synth(base,childP)).status,200,'TTS has a separate grant');
  const exported=(await get(base,'/api/privacy/export',parent)).data;
  assert.equal(exported.learnerPrivacy[0].preferences.cloudAudioInputAllowed,false);
  assert.equal(JSON.stringify(exported).includes('private-fixture-key'),false);
  const wiped=await post(base,'/api/privacy/erase',{scope:'child'},parent);
  assert.equal(wiped.status,200);
  assert.equal(wiped.data.clearedLearnerPrivacy,1);
  assert.equal((await get(base,'/api/audio/capabilities',childP)).data.outputAllowed,false);
  assert.equal((await synth(base,childP)).status,403);
  assert.equal((await get(base,'/api/audio/capabilities',parent)).data.inputAllowed,true);
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
test('R6 audio disabled configuration is disclosed without exposing provider secrets',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r6-off-'));
 const env={
  PORT:String(49000+Math.floor(Math.random()*9000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'another-safe-parent-password',
  ALEX_CHILD_PIN:'100020',ALEX_AUDIO_PROVIDER:'disabled',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_CONVERSATION_FILE:join(dir,'conv.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'prefs.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'creds.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'runs.json'),
  PROPOSAL_FILE:join(dir,'proposal.json')
 };
 let server;
 try{
  server=await boot(env);
  const parent=(await post(server.base,'/api/auth/login',{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const caps=await get(server.base,'/api/audio/capabilities',parent);
  assert.equal(caps.data.provider,'disabled');
  assert.equal(caps.data.inputAllowed,false);
  assert.equal(caps.data.outputAllowed,false);
  assert.equal((await upload(server.base,parent)).status,409);
  assert.equal((await synth(server.base,parent)).status,409);
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
