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
  if(child.exitCode!==null)throw Error('R23_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(70);
 }
 child.kill('SIGTERM');throw Error('R23_SERVER_START_TIMEOUT');
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const completed=once(server.child,'exit');server.child.kill('SIGTERM');await completed;
}
async function request(base,path,{method='GET',data,cookie}={}){
 const response=await fetch(base+path,{method,headers:{
  ...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})
 },...(data?{body:JSON.stringify(data)}:{})});
 return {status:response.status,data:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
test('R23 parent can import mapped supplier CSV while anonymous requests are denied',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r23-http-'));
 const env={
  PORT:String(43000+Math.floor(Math.random()*10000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r23-long-parent-secret',
  ALEX_CHILD_PIN:'814295',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
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
  const csv=[
   'id,vendor,ccy,start,end,model,metric,qty,amount',
   'invoice-r23,tts-vendor,USD,2026-11-01T00:00:00Z,2026-11-02T00:00:00Z,voice-v1,pcm_bytes,9600,12'
  ].join('\n');
  const mapping={statementId:'id',provider:'vendor',currency:'ccy',
   periodStart:'start',periodEnd:'end',model:'model',metric:'metric',
   quantity:'qty',amountMinor:'amount'};
  const imported=await request(server.base,'/api/audio/provider-billing/csv',{
   method:'POST',cookie:parent,data:{csv,mapping}});
  assert.equal(imported.status,201);assert.equal(imported.data.rowsImported,1);
  assert.equal((await request(server.base,'/api/audio/provider-billing/csv',{
   method:'POST',cookie:parent,data:{csv,mapping}})).status,200);
  const list=await request(server.base,'/api/audio/provider-billing/statements',{cookie:parent});
  assert.equal(list.status,200);assert.equal(list.data.statements.length,1);
  assert.equal((await request(server.base,'/api/audio/provider-billing/csv',{
   method:'POST',data:{csv,mapping}})).status,401);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
