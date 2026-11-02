import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';
import {PlanOrchestrator,compilePlan,validatePlanGraph,PLAN_TEMPLATES} from '../scripts/plan-orchestrator.mjs';
import {HomeCore} from '../dist/index.js';
const rid=()=>`request_${randomUUID().replaceAll('-','')}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-v07-'));
 let time=Date.now();const clock=()=>time;
 const registry=new DeviceRegistry(join(dir,'devices.json'),{clock});
 const gateway=new DeviceGateway(join(dir,'jobs.json'),registry,{clock,freshMs:60000});
 const skills=new HomeCore().skills;
 const received=[];
 const create=()=>new PlanOrchestrator(join(dir,'plans.json'),{registry,gateway,skills,clock,timeoutMs:30000,maxEvents:12,onEvent:e=>received.push(e)});
 const plans=create();
 const device=async()=>{
   const code=registry.start('parent').code;
   const d=await registry.complete(code,'Simulator');
   await gateway.announce(d.deviceId,d.token,['sim.navigation.goto','audio.output'],1);
   await registry.heartbeat(d.deviceId,d.token);
   await gateway.approve('parent',d.deviceId,['sim.navigation.goto','audio.output']);
   return d;
 };
 const finish=async(d,jobId)=>{
   assert.equal((await gateway.result(d.deviceId,d.token,{jobId,status:'running'})).ok,true);
   assert.equal((await gateway.result(d.deviceId,d.token,{jobId,status:'succeeded'})).ok,true);
 };
 return {dir,registry,gateway,skills,plans,create,device,finish,clock,advance:ms=>time+=ms,received,close:()=>rm(dir,{recursive:true,force:true})};
}

test('v0.7 parser only compiles explicit allowlisted intentions',()=>{
 assert.equal(compilePlan('Alex 去书桌学英语'),'learn.at.desk');
 assert.equal(compilePlan('去故事角讲故事'),'story.at.corner');
 assert.equal(compilePlan('给我讲个故事'),'story.here');
 assert.equal(compilePlan('直接驱动电机全速移动'),null);
 assert.equal(compilePlan('{}'.repeat(501)),null);
 assert.equal(Object.keys(PLAN_TEMPLATES).length,3);
});
test('v0.7 validate graph rejects cycles, invalid tools, missing dependencies and unbounded graphs',()=>{
 assert.throws(()=>validatePlanGraph([{id:'a',kind:'skill',skillId:'story.interactive',dependsOn:['b']},{id:'b',kind:'skill',skillId:'story.interactive',dependsOn:['a']}]),/PLAN_CYCLE/);
 assert.throws(()=>validatePlanGraph([{id:'a',kind:'device',capability:'motor.direct',params:{},dependsOn:[]}]),/INVALID_PLAN_ACTION/);
 assert.throws(()=>validatePlanGraph([{id:'a',kind:'skill',skillId:'story.interactive',dependsOn:['absent']}]),/PLAN_MISSING_DEPENDENCY/);
 assert.throws(()=>validatePlanGraph(Array.from({length:7},(_,i)=>({id:`step${i}`,kind:'skill',skillId:'story.interactive',dependsOn:[]}))),/INVALID_PLAN_GRAPH/);
 assert.equal(validatePlanGraph(PLAN_TEMPLATES['story.here']).length,2);
});
test('v0.7 device task -> verified skill -> audio, persistent monotonic event journal',async()=>{
 const f=await fixture();try{
  const d=await f.device();const input={templateId:'learn.at.desk',requestId:rid()};
  const started=await f.plans.start('parent',input);assert.equal(started.ok,true);
  assert.deepEqual(started.plan.steps.map(s=>s.status),['running','pending','pending']);
  assert.equal(f.gateway.list().length,1);
  const duplicate=await f.plans.start('parent',input);assert.equal(duplicate.duplicate,true);assert.equal(f.gateway.list().length,1);
  assert.equal((await f.plans.start('parent',{...input,templateId:'story.here'})).message,'IDEMPOTENCY_CONFLICT');
  await f.finish(d,started.plan.steps[0].jobId);await f.plans.tick();
  const middle=f.plans.get(started.plan.id);assert.deepEqual(middle.steps.map(s=>s.status),['succeeded','succeeded','running']);
  assert.equal(f.gateway.list().find(j=>j.id===middle.steps[2].jobId).capability,'audio.output');
  await f.finish(d,middle.steps[2].jobId);await f.plans.tick();
  assert.equal(f.plans.get(started.plan.id).status,'succeeded');
  const events=f.plans.getEvents();assert.equal(events.at(-1).type,'plan.succeeded');
  assert.equal(new Set(events.map(e=>e.seq)).size,events.length);
  assert.ok(events.every(e=>!('payload' in e)&&!('lastOutput' in e)));
  const file=await readFile(join(f.dir,'plans.json'),'utf8');assert.ok(!file.includes(d.token));
  assert.equal(f.plans.getEvents(events.at(-1).seq).length,0);
 }finally{await f.close();}
});
test('v0.7 child denied; no approved device, busy device and revoked capability fail closed',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.plans.start('child',{templateId:'story.here',requestId:rid()}),/PARENT_REQUIRED/);
  assert.equal((await f.plans.start('parent',{templateId:'story.here',requestId:rid()})).message,'NO_APPROVED_AVAILABLE_DEVICE');
  const d=await f.device();const p=await f.plans.start('parent',{templateId:'learn.at.desk',requestId:rid()});
  assert.equal(p.ok,true);assert.equal((await f.plans.start('parent',{templateId:'story.here',requestId:rid()})).message,'NO_APPROVED_AVAILABLE_DEVICE');
  await f.finish(d,p.plan.steps[0].jobId);
  await f.gateway.approve('parent',d.deviceId,['sim.navigation.goto']);
  await f.plans.tick();assert.equal(f.plans.get(p.plan.id).status,'stopped');
  assert.equal(f.gateway.list().filter(j=>j.capability==='audio.output').length,0);
 }finally{await f.close();}
});
test('v0.7 stop and cancel prevent dependent device side effects',async()=>{
 const f=await fixture();try{
  const d=await f.device(),p=await f.plans.start('parent',{templateId:'story.at.corner',requestId:rid()});
  await assert.rejects(f.plans.cancel('child',p.plan.id),/PARENT_REQUIRED/);
  assert.equal((await f.plans.cancel('parent',p.plan.id)).ok,true);
  assert.equal(f.gateway.list().find(j=>j.id===p.plan.steps[0].jobId).status,'cancelled');
  await f.plans.tick();assert.equal(f.plans.get(p.plan.id).status,'cancelled');
  assert.equal(f.gateway.list().filter(j=>j.capability==='audio.output').length,0);
  const next=await f.plans.start('parent',{templateId:'learn.at.desk',requestId:rid()});
  assert.equal(next.ok,true);
  f.advance(31000);await f.plans.tick();
  assert.equal(f.plans.get(next.plan.id).status,'stopped');
  assert.equal(f.gateway.list().find(j=>j.id===next.plan.steps[0].jobId).status,'cancelled');
 }finally{await f.close();}
});
test('v0.7 restart fails closed without replay, idempotency survives and journal cursor increases',async()=>{
 const f=await fixture();try{
  await f.device();const input={templateId:'story.here',requestId:rid()};const p=await f.plans.start('parent',input);
  assert.equal(p.ok,true);const oldSeq=f.plans.getEvents().at(-1).seq;
  const fresh=f.create();await fresh.load();
  assert.equal(fresh.get(p.plan.id).status,'stopped');
  assert.equal((await fresh.start('parent',input)).duplicate,true);
  assert.ok(fresh.getEvents(oldSeq).some(e=>e.type==='plan.stopped'));
  await fresh.tick();assert.equal(f.gateway.list().length,1);
 }finally{await f.close();}
});
test('v0.7 malformed cursor is rejected, listener errors cannot break persistence',async()=>{
 const f=await fixture();try{
  await f.device();f.plans.onEvent=()=>{throw new Error('should not break execution');};
  const p=await f.plans.start('parent',{templateId:'story.here',requestId:rid()});assert.equal(p.ok,true);
  assert.throws(()=>f.plans.getEvents(-1),/INVALID_EVENT_CURSOR/);
  const newPlan=f.create();await newPlan.load();assert.equal(newPlan.get(p.plan.id).status,'stopped');
 }finally{await f.close();}
});
test('v0.7 HTTP routes enforce session-bound parent identity and reject untrusted plans',{timeout:25000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-v07-http-'));
 const port=48000+Math.floor(Math.random()*9000),base=`http://127.0.0.1:${port}`;
 const env={...process.env,AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'unique-v07-parent-pass',ALEX_CHILD_PIN:'445566',AGENT_PROVIDER:'rules',PORT:String(port),STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json')};
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd:new URL('..',import.meta.url).pathname,env,stdio:'ignore'});
 const request=async(method,path,data,cookie)=>{const res=await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 try{
  let healthy=false;
  for(let i=0;i<75;i++){try{if((await fetch(base+'/api/health')).ok){healthy=true;break;}}catch{}await delay(85);}
  assert.equal(healthy,true);
  const parent=(await request('POST','/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const kid=(await request('POST','/api/auth/login',{role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
  assert.equal((await request('GET','/api/plans')).status,401);
  assert.equal((await request('GET','/api/plans',null,kid)).status,403);
  assert.equal((await request('POST','/api/plans/start',{actor:'parent',templateId:'story.here',requestId:rid()},kid)).status,403);
  assert.equal((await request('GET','/api/plans',null,parent)).status,200);
  assert.equal((await request('GET','/api/plans/events?after=not_number',null,parent)).status,400);
  assert.equal((await request('POST','/api/plans/start',{templateId:'motor.direct',requestId:rid()},parent)).status,400);
  assert.equal((await request('POST','/api/plans/command',{text:'打开家门',requestId:rid()},parent)).status,409);
 }finally{
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(1600)]);}
  await rm(dir,{recursive:true,force:true});
 }
});

test('v0.7 cross-version workflow and plan cannot reserve same virtual device',async()=>{
 const f=await fixture();try{
  const d=await f.device();
  const {WorkflowOrchestrator}=await import('../scripts/workflow-orchestrator.mjs');
  const wf=new WorkflowOrchestrator(join(f.dir,'workflows.json'),{gateway:f.gateway,registry:f.registry,skills:f.skills,busyDevice:id=>f.plans.list().some(p=>p.deviceId===id&&p.status==='running')});
  const active=await f.plans.start('parent',{templateId:'learn.at.desk',requestId:rid()});
  assert.equal(active.ok,true);
  assert.equal((await wf.start('parent',{recipe:'study.english',requestId:rid()})).message,'NO_APPROVED_AVAILABLE_DEVICE');
  await f.plans.cancel('parent',active.plan.id);
  const next=await wf.start('parent',{recipe:'study.english',requestId:rid()});
  assert.equal(next.ok,true);
  assert.equal((await f.plans.start('parent',{templateId:'story.here',requestId:rid()})).message,'NO_APPROVED_AVAILABLE_DEVICE');
  await wf.cancel('parent',next.workflow.id);
 }finally{await f.close();}
});

test('v0.7 bounded event retention and only metadata persisted, no raw lesson output',async()=>{
 const f=await fixture();try{
  const d=await f.device();
  const start=await f.plans.start('parent',{templateId:'story.here',requestId:rid()});
  assert.equal(start.ok,true);
  const job=start.plan.steps.find(s=>s.jobId).jobId;
  await f.finish(d,job);await f.plans.tick();
  const events=f.plans.getEvents();assert.ok(events.length<=12);
  const data=await readFile(join(f.dir,'plans.json'),'utf8');
  assert.doesNotMatch(data,/小机器人在星空下/);
  assert.equal(data.includes(d.token),false);
 }finally{await f.close();}
});
