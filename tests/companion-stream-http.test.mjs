import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

const cwd=resolve(import.meta.dirname,'..');
async function startServer(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw new Error('Server exited before health');
  try{const res=await fetch(base+'/api/health');if(res.ok)return {child,base};}catch{}
  await new Promise(ok=>setTimeout(ok,70));
 }
 child.kill('SIGTERM');throw new Error('Timed out waiting for Alex server');
}
async function login(base,role,secret){
 const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({role,secret})});
 assert.equal(response.status,200);
 return response.headers.get('set-cookie').split(';')[0];
}
async function post(base,path,data,cookie){
 const response=await fetch(base+path,{method:'POST',
  headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
  body:JSON.stringify(data)});
 return {status:response.status,headers:response.headers,raw:await response.text()};
}
function events(raw){
 const result=[];
 for(const frame of raw.split('\n\n')){
  const event=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();
  const data=frame.split('\n').find(line=>line.startsWith('data:'))?.slice(5).trim();
  if(event&&data)result.push({event,data:JSON.parse(data)});
 }
 return result;
}

test('live HTTP: streamed English turn is committed only after delta and verified-family gate', {timeout:25000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-stream-http-'));
 const env={
  PORT:String(49000+Math.floor(Math.random()*9000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'long-parent-secret-from-test',ALEX_CHILD_PIN:'574392',
  ALEX_CHAT_PROVIDER:'offline',AGENT_PROVIDER:'rules',
  ALEX_CONVERSATION_PERSIST:'1',ALEX_CONVERSATION_FILE:join(dir,'chat.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflow.json'),PLAN_FILE:join(dir,'plan.json'),
  PROPOSAL_FILE:join(dir,'proposal.json')
 };
 let service;
 try{
  service=await startServer(env);
  const child=await login(service.base,'child','574392');
  const parent=await login(service.base,'parent','long-parent-secret-from-test');
  const open=await post(service.base,'/api/companion/open',{mode:'english'},child);
  assert.equal(open.status,200);
  const id=JSON.parse(open.raw).session.id;
  const denied=await post(service.base,'/api/companion/stream',{id,text:'hi'});
  assert.equal(denied.status,401);
  const crossed=await post(service.base,'/api/companion/stream',{id,text:'spy'},parent);
  assert.equal(crossed.status,400);
  assert.doesNotMatch(crossed.raw,/nice to meet you/i);
  const answer=await post(service.base,'/api/companion/stream',{id,text:'Sunny'},child);
  assert.equal(answer.status,200);
  assert.match(answer.headers.get('content-type'),/text\/event-stream/);
  const received=events(answer.raw);
  assert.deepEqual(received.map(x=>x.event),['ready','delta','committed']);
  assert.equal(received[0].data.provisional,true);
  assert.equal(received[1].data.text.includes('Sunny'),true);
  assert.equal(received[2].data.session.step,1);
  assert.equal(received[2].data.session.messages.length,3);
  assert.equal(received[2].data.assistant.source,'offline');
  assert.ok(!received.some(x=>x.event==='job.queued'));
  // Finish the deterministic lesson: evidence is from state transitions.
  for(const text of ['I like apples','I like green','I can sing','I am fine']){
   const result=await post(service.base,'/api/companion/turn',{id,text},child);
   assert.equal(result.status,200);
  }
  const view=async(cookie,scope)=>{
   const res=await fetch(service.base+'/api/companion/progress?scope='+scope,{headers:{Cookie:cookie}});
   return {status:res.status,data:await res.json()};
  };
  const own=await view(child,'child');
  assert.equal(own.status,200);
  assert.equal(own.data.progress.englishTextExercisesCompleted,1);
  assert.equal(own.data.progress.recent[0].kind,'english_a1_text');
  assert.ok(!JSON.stringify(own.data).includes('I like apples'));
  assert.equal((await view(child,'parent')).status,403);
  assert.equal((await view(parent,'child')).data.progress.englishTextExercisesCompleted,1);
  const state=await fetch(service.base+'/api/state',{headers:{Cookie:parent}});
  assert.equal((await state.json()).tasks.length,0,'chat cannot create robot tasks');
  const erased=await post(service.base,'/api/companion/erase',{scope:'child'},parent);
  assert.equal(erased.status,200);
  assert.equal(JSON.parse(erased.raw).deletedConversations,1);
  assert.equal((await view(parent,'child')).data.progress.englishTextExercisesCompleted,0);
  const missing=await fetch(service.base+'/api/companion/session?id='+id,{headers:{Cookie:child}});
  assert.notEqual(missing.status,200);
 }finally{
  if(service){service.child.kill('SIGTERM');await once(service.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});

test('live HTTP: offline free-chat streaming fails explicitly and preserves session', {timeout:25000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-stream-chat-'));
 const env={
  PORT:String(49000+Math.floor(Math.random()*9000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'long-parent-secret-from-test',ALEX_CHILD_PIN:'574392',
  ALEX_CHAT_PROVIDER:'offline',AGENT_PROVIDER:'rules',
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflow.json'),PLAN_FILE:join(dir,'plan.json'),
  PROPOSAL_FILE:join(dir,'proposal.json')
 };
 let service;
 try{
  service=await startServer(env);
  const child=await login(service.base,'child','574392');
  const open=await post(service.base,'/api/companion/open',{mode:'chat'},child);
  const id=JSON.parse(open.raw).session.id;
  const response=await post(service.base,'/api/companion/stream',{id,text:'hello'},child);
  assert.equal(response.status,200);
  const frames=events(response.raw);
  assert.equal(frames[0].event,'ready');
  assert.equal(frames.at(-1).event,'error');
  assert.match(frames.at(-1).data.error,/CHAT_MODEL_REQUIRED/);
  assert.equal(frames.at(-1).data.partialDiscarded,true);
  assert.equal(frames.some(x=>x.event==='committed'),false);
  const latest=await fetch(service.base+'/api/companion/session?id='+id,{headers:{Cookie:child}});
  assert.equal((await latest.json()).session.messages.length,1);
 }finally{
  if(service){service.child.kill('SIGTERM');await once(service.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
