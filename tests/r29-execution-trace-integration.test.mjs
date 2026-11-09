import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';
import {PlanOrchestrator} from '../scripts/plan-orchestrator.mjs';
import {WorkflowOrchestrator} from '../scripts/workflow-orchestrator.mjs';
import {ExecutionTraceProjector} from '../scripts/execution-trace-projector.mjs';
import {HomeCore} from '../dist/index.js';

const requestId=()=> 'r29_'+randomUUID().replaceAll('-','');
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r29-integrated-'));
 let now=Date.UTC(2026,10,9,1,0);
 const clock=()=>now;
 const registry=new DeviceRegistry(join(dir,'devices.json'),{clock});
 const gatewayFile=join(dir,'gateway.json'),planFile=join(dir,'plans.json');
 const workflowFile=join(dir,'workflows.json');
 const skills=new HomeCore().skills;
 const create=()=> {
  const gateway=new DeviceGateway(gatewayFile,registry,{clock,freshMs:30000,timeoutMs:60000});
  const plans=new PlanOrchestrator(planFile,{gateway,registry,skills,clock});
  const workflows=new WorkflowOrchestrator(workflowFile,{gateway,registry,skills,clock});
  return {gateway,plans,workflows,projector:new ExecutionTraceProjector({
   gateway,plans,workflows
  })};
 };
 const parts=create();
 const pairing=registry.start('parent');
 const d=await registry.complete(pairing.code,'R29 virtual device');
 await parts.gateway.announce(d.deviceId,d.token,['sim.navigation.goto','audio.output'],1);
 await registry.heartbeat(d.deviceId,d.token);
 await parts.gateway.approve('parent',d.deviceId,['sim.navigation.goto','audio.output']);
 return {...parts,registry,d,create,advance:ms=>now+=ms,
  close:()=>rm(dir,{recursive:true,force:true})};
}
const result=async(f,jobId)=>{
 assert.equal((await f.gateway.result(f.d.deviceId,f.d.token,{
  jobId,status:'running'})).ok,true);
 assert.equal((await f.gateway.result(f.d.deviceId,f.d.token,{
  jobId,status:'succeeded'})).ok,true);
};
test('R29 actual plan -> gateway -> local skill -> gateway trace is end-to-end correlated',async()=>{
 const f=await fixture();try{
  const started=await f.plans.start('parent',{
   templateId:'learn.at.desk',requestId:requestId()});
  assert.equal(started.ok,true);
  const planId=started.plan.id,nav=started.plan.steps[0].jobId;
  assert.ok(nav);
  let trace=f.projector.get(planId);
  assert.equal(trace.steps[0].job.jobId,nav);
  assert.equal(trace.steps[0].events[0].type,'job.queued');
  await result(f,nav);await f.plans.tick();
  trace=f.projector.get(planId);
  assert.equal(trace.steps[1].status,'succeeded');
  assert.equal(trace.steps[1].skillId,'learning.english');
  assert.equal(trace.steps[2].correlation,'matched');
  const audio=trace.steps[2].job.jobId;
  await result(f,audio);await f.plans.tick();
  trace=f.projector.get(planId);
  assert.equal(trace.status,'succeeded');
  assert.equal(trace.steps[2].status,'succeeded');
  assert.ok(trace.planEvents.some(e=>e.type==='plan.succeeded'));
  assert.ok(!JSON.stringify(trace).includes('Ready.'));
 }finally{await f.close();}
});
test('R29 restart produces stopped trace without dispatching any new device job',async()=>{
 const f=await fixture();try{
  const started=await f.plans.start('parent',{
   templateId:'story.here',requestId:requestId()});
  assert.equal(started.ok,true);
  const before=f.gateway.list().length;
  const restarted=f.create();
  await restarted.gateway.load();
  await restarted.plans.load();
  await restarted.workflows.load();
  assert.equal(restarted.gateway.list().length,before);
  const trace=restarted.projector.get(started.plan.id);
  assert.equal(trace.status,'stopped');
  assert.ok(trace.planEvents.some(e=>e.type==='plan.stopped'));
  assert.equal(trace.steps.at(-1).job.status,'stopped');
  assert.ok(trace.steps.at(-1).events.some(e=>e.type==='job.stopped'));
 }finally{await f.close();}
});
test('R29 correlation survives completed plan restart',async()=>{
 const f=await fixture();try{
  const start=await f.plans.start('parent',{
   templateId:'story.here',requestId:requestId()});
  const jobId=start.plan.steps.at(-1).jobId;
  await result(f,jobId);await f.plans.tick();
  const restarted=f.create();
  await restarted.gateway.load();await restarted.plans.load();
  await restarted.workflows.load();
  const trace=restarted.projector.get(start.plan.id);
  assert.equal(trace.status,'succeeded');
  assert.equal(trace.steps.at(-1).job.jobId,jobId);
  assert.equal(trace.steps.at(-1).correlation,'matched');
  assert.equal(trace.steps.at(-1).job.status,'succeeded');
 }finally{await f.close();}
});
