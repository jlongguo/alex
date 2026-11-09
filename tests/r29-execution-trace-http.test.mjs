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
  if(child.exitCode!==null)throw Error('R29_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(70);
 }
 child.kill('SIGTERM');throw Error('R29_SERVER_START_TIMEOUT');
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
test('R29 parent-only execution trace lists and detail survive restart without device replay',{timeout:48000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r29-http-'));
 const env={
  PORT:String(42000+Math.floor(Math.random()*12000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r29-parent-password-value',
  ALEX_CHILD_PIN:'223344',AGENT_PROVIDER:'rules',
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
  assert.equal((await request(server.base,'/api/executions')).status,401);
  assert.equal((await request(server.base,'/api/executions',{cookie:child})).status,403);
  const empty=await request(server.base,'/api/executions',{cookie:parent});
  assert.equal(empty.status,200);assert.deepEqual(empty.data.executions,[]);
  assert.equal(empty.data.hasMore,false);
  assert.equal(empty.data.nextCursor,null);
  for(const path of ['/api/executions?limit=0','/api/executions?limit=101','/api/executions?cursor=broken',
   '/api/executions?cursor=abc%2Fdef',
   '/api/executions?kind=arbitrary','/api/executions?deviceId=not-a-device',
   '/api/executions/not-an-id']){
   const result=await request(server.base,path,{cookie:parent});
   assert.ok([400,404].includes(result.status),path+' '+result.status);
  }
  const unknown=await request(server.base,'/api/executions/plan-11111111-1111-4111-8111-111111111111',{cookie:parent});
  assert.equal(unknown.status,404);
  await stop(server);server=null;
  env.PORT=String(Number(env.PORT)+1);
  server=await boot(env);
  const parent2=(await request(server.base,'/api/auth/login',{
   method:'POST',data:{role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  assert.deepEqual((await request(server.base,'/api/executions',{cookie:parent2})).data.executions,[]);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
