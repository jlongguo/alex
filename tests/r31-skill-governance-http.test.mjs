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
  if(child.exitCode!==null)throw Error('R31_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(60);
 }
 child.kill('SIGTERM');throw Error('R31_SERVER_START_TIMEOUT');
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
test('R31 parent-only Skill toggle persists across restart and rejects stale version',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r31-http-'));
 const env={
  PORT:String(43000+Math.floor(Math.random()*9000)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r31-long-parent-password',
  ALEX_CHILD_PIN:'334455',AGENT_PROVIDER:'rules',
  ALEX_CHAT_PROVIDER:'offline',ALEX_AUDIO_PROVIDER:'disabled',
  ALEX_REALTIME_PROVIDER:'disabled',ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'skills.json'),
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
  assert.equal((await request(server.base,'/api/skills/governance')).status,401);
  assert.equal((await request(server.base,'/api/skills/governance',{cookie:child})).status,403);
  const before=await request(server.base,'/api/skills/governance',{cookie:parent});
  assert.equal(before.status,200);assert.equal(before.data.skills.length,4);
  const payload={id:'story.interactive',enabled:false,expectedVersion:'0.2.0'};
  assert.equal((await request(server.base,'/api/skills/governance',{
   method:'POST',cookie:child,data:payload})).status,403);
  const updated=await request(server.base,'/api/skills/governance',{
   method:'POST',cookie:parent,data:payload});
  assert.equal(updated.status,200);assert.equal(updated.data.changed,true);
  assert.equal(updated.data.skill.enabled,false);
  const blocked=await request(server.base,'/api/companion/open',{
   method:'POST',cookie:parent,data:{mode:'story'}});
  assert.equal(blocked.status,403);
  assert.equal(blocked.data.error,'SKILL_DISABLED');
  assert.equal((await request(server.base,'/api/skills/governance',{
   method:'POST',cookie:parent,data:{...payload,expectedVersion:'0.1.0'}
  })).status,409);
  assert.equal((await request(server.base,'/api/skills/governance',{
   method:'POST',cookie:parent,data:payload})).data.changed,false);
  await stop(server);server=null;
  env.PORT=String(Number(env.PORT)+1);
  server=await boot(env);
  const parent2=(await request(server.base,'/api/auth/login',{
   method:'POST',data:{role:'parent',secret:env.ALEX_PARENT_PASSWORD}})).cookie;
  const restored=await request(server.base,'/api/skills/governance',{cookie:parent2});
  assert.equal(restored.status,200);
  assert.equal(restored.data.skills.find(x=>x.id==='story.interactive').enabled,false);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
