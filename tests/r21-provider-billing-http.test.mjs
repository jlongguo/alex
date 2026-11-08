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
  cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('R21_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(70);
 }
 child.kill('SIGTERM');throw Error('R21_SERVER_START_TIMEOUT');
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const completed=once(server.child,'exit');server.child.kill('SIGTERM');await completed;
}
async function request(base,path,{method='GET',data,cookie}={}){
 const response=await fetch(base+path,{method,headers:{
  ...(data?{'Content-Type':'application/json'}:{}),
  ...(cookie?{Cookie:cookie}:{})
 },...(data?{body:JSON.stringify(data)}:{})});
 return {status:response.status,data:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
test('R21 provider billing import and reconciliation endpoints enforce parent role',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r21-http-'));
 const env={
  PORT:String(43000+Math.floor(Math.random()*10000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r21-long-parent-secret',
  ALEX_CHILD_PIN:'814295',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ALEX_SPEECH_PROVIDER_USAGE_FILE:join(dir,'usage.jsonl'),
  ALEX_SPEECH_PROVIDER_BILLING_FILE:join(dir,'billing.jsonl'),
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
  const parent=(await request(server.base,'/api/auth/login',{
   method:'POST',data:{role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  const profile=(await request(server.base,'/api/profiles',{
   method:'POST',cookie:parent,data:{nickname:'R21 learner',ageBand:'6-8',interests:[]}
  })).data.profile;
  const learner=(await request(server.base,'/api/learners/set-pin',{
   method:'POST',cookie:parent,data:{profileId:profile.id,pin:'318294'}
  })).data.learner;
  const child=(await request(server.base,'/api/auth/login',{
   method:'POST',data:{role:'learner',code:learner.code,secret:'318294'}
  })).cookie;
  const statement={
   schemaVersion:1,statementId:'vendor-export-001',
   provider:'compatible-pcm-stream',currency:'USD',
   periodStart:'2026-11-01T00:00:00Z',periodEnd:'2026-11-02T00:00:00Z',
   items:[{model:'voice-v1',metric:'pcm_bytes',quantity:9600,amountMinor:12},
    {model:'voice-v1',metric:'characters',quantity:2000,amountMinor:8}]
  };
  const imported=await request(server.base,'/api/audio/provider-billing/statements',{
   method:'POST',cookie:parent,data:statement});
  assert.equal(imported.status,201);
  assert.equal(imported.data.imported,true);
  assert.equal((await request(server.base,'/api/audio/provider-billing/statements',{
   method:'POST',cookie:parent,data:statement})).status,200);
  const report=await request(server.base,'/api/audio/provider-billing/reconciliation',{
   cookie:parent});
  assert.equal(report.status,200);
  assert.equal(report.data.reports.length,1);
  assert.equal(report.data.reports[0].items[0].status,'comparable');
  assert.equal(report.data.reports[0].items[0].localQuantity,0);
  assert.equal(report.data.reports[0].items[1].status,'not_comparable');
  assert.equal((await request(server.base,'/api/audio/provider-billing/statements',{
   cookie:child})).status,403);
  assert.equal((await request(server.base,'/api/audio/provider-billing/reconciliation',{
   cookie:child})).status,403);
  assert.equal((await request(server.base,'/api/audio/provider-billing/statements')).status,403);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
