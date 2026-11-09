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
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,
  env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<130;i++){
  if(child.exitCode!==null)throw Error('R28_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(60);
 }
 child.kill('SIGTERM');throw Error('R28_SERVER_START_TIMEOUT');
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const done=once(server.child,'exit');server.child.kill('SIGTERM');await done;
}
async function request(base,path,{method='GET',data,cookie}={}){
 const r=await fetch(base+path,{method,headers:{
  ...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})
 },...(data?{body:JSON.stringify(data)}:{})});
 return {status:r.status,data:await r.json().catch(()=>({})),
  cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
test('R28 device gateway events endpoint requires local parent and validates cursor',{timeout:40000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r28-http-'));
 const env={
  PORT:String(42000+Math.floor(Math.random()*12000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r28-local-parent-password',
  ALEX_CHILD_PIN:'556677',AGENT_PROVIDER:'rules',
  ALEX_CHAT_PROVIDER:'offline',ALEX_AUDIO_PROVIDER:'disabled',
  ALEX_REALTIME_PROVIDER:'disabled',ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
  MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning-plans.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json')
 };
 let server;
 try{
  server=await boot(env);
  const parent=(await request(server.base,'/api/auth/login',{
   method:'POST',data:{role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  const child=(await request(server.base,'/api/auth/login',{
   method:'POST',data:{role:'child',secret:env.ALEX_CHILD_PIN}})).cookie;
  assert.equal((await request(server.base,'/api/gateway/events')).status,401);
  assert.equal((await request(server.base,'/api/gateway/events',{cookie:child})).status,403);
  const events=await request(server.base,'/api/gateway/events',{cookie:parent});
  assert.equal(events.status,200);
  assert.equal(events.data.latestSeq,0);
  assert.deepEqual(events.data.events,[]);
  for(const path of ['/api/gateway/events?after=-1',
   '/api/gateway/events?limit=0','/api/gateway/events?after=abc',
   '/api/gateway/events?limit=501']){
   assert.equal((await request(server.base,path,{cookie:parent})).status,400,path);
  }
  const valid=await request(server.base,'/api/gateway/events?after=0&limit=2',{cookie:parent});
  assert.equal(valid.status,200);assert.equal(valid.data.cursorExpired,false);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
