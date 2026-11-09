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
const rid=()=> 'r30_'+randomUUID().replaceAll('-','');
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r30-devices-'));
 let now=Date.UTC(2026,10,9,3,0);
 const clock=()=>now;
 const registry=new DeviceRegistry(join(dir,'devices.json'),{clock});
 const skills=new HomeCore().skills;
 const files={gateway:join(dir,'gateway.json'),plans:join(dir,'plans.json'),
  workflows:join(dir,'workflows.json')};
 const create=()=>{
  const gateway=new DeviceGateway(files.gateway,registry,{clock,freshMs:15000,timeoutMs:30000});
  let plans,workflows;
  plans=new PlanOrchestrator(files.plans,{gateway,registry,skills,clock,
   busyDevice:id=>workflows.list().some(w=>w.deviceId===id&&
    ['dispatching','navigating','speaking'].includes(w.status))});
  workflows=new WorkflowOrchestrator(files.workflows,{gateway,registry,skills,clock,
   busyDevice:id=>plans.list().some(p=>p.deviceId===id&&p.status==='running')});
  const projector=new ExecutionTraceProjector({plans,workflows,gateway});
  return {gateway,plans,workflows,projector};
 };
 const services=create();
 const device=async name=>{
  const pairing=registry.start('parent');
  const d=await registry.complete(pairing.code,name);
  await services.gateway.announce(d.deviceId,d.token,['sim.navigation.goto','audio.output'],1);
  await registry.heartbeat(d.deviceId,d.token);
  await services.gateway.approve('parent',d.deviceId,['sim.navigation.goto','audio.output']);
  return d;
 };
 const finish=async(d,id)=>{
  assert.equal((await services.gateway.result(d.deviceId,d.token,{jobId:id,status:'running'})).ok,true);
  assert.equal((await services.gateway.result(d.deviceId,d.token,{jobId:id,status:'succeeded'})).ok,true);
 };
 return {...services,create,device,finish,registry,clock,files,advance:n=>now+=n,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('R30 two approved devices independently execute Plan and Workflow with separate traces',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.device('desk terminal'),f.device('story terminal')]);
  const [plan,workflow]=await Promise.all([
   f.plans.start('parent',{templateId:'learn.at.desk',deviceId:a.deviceId,requestId:rid()}),
   f.workflows.start('parent',{recipe:'story.corner',deviceId:b.deviceId,requestId:rid()})
  ]);
  assert.equal(plan.ok,true);assert.equal(workflow.ok,true);
  assert.notEqual(plan.plan.deviceId,workflow.workflow.deviceId);
  assert.equal(f.projector.list({deviceId:a.deviceId}).length,1);
  assert.equal(f.projector.list({deviceId:b.deviceId}).length,1);
  await f.finish(a,plan.plan.steps[0].jobId);
  await f.plans.tick();
  await f.finish(b,workflow.workflow.navigationJobId);
  await f.workflows.tick();
  assert.equal(f.projector.get(plan.plan.id).steps[1].status,'succeeded');
  assert.equal(f.projector.get(workflow.workflow.id).steps[1].status,'succeeded');
  const audioA=f.plans.get(plan.plan.id).steps.at(-1).jobId;
  const audioB=f.workflows.get(workflow.workflow.id).audioJobId;
  assert.ok(audioA&&audioB&&audioA!==audioB);
  await f.finish(a,audioA);await f.finish(b,audioB);
  await Promise.all([f.plans.tick(),f.workflows.tick()]);
  assert.equal(f.projector.get(plan.plan.id).status,'succeeded');
  assert.equal(f.projector.get(workflow.workflow.id).status,'succeeded');
  assert.equal(f.projector.get(plan.plan.id).steps.at(-1).job.deviceId,a.deviceId);
  assert.equal(f.projector.get(workflow.workflow.id).steps.at(-1).job.deviceId,b.deviceId);
 }finally{await f.close();}
});
test('R30 same device is never reserved twice by simultaneous Plan and Workflow starts',async()=>{
 const f=await fixture();try{
  const d=await f.device('shared terminal');
  const [plan,workflow]=await Promise.all([
   f.plans.start('parent',{templateId:'learn.at.desk',deviceId:d.deviceId,requestId:rid()}),
   f.workflows.start('parent',{recipe:'story.corner',deviceId:d.deviceId,requestId:rid()})
  ]);
  assert.equal(Number(plan.ok)+Number(workflow.ok),1);
  const active=f.gateway.list().filter(j=>j.deviceId===d.deviceId&&
   ['queued','running'].includes(j.status));
  assert.equal(active.length,1);
  assert.equal(active[0].capability,'sim.navigation.goto');
 }finally{await f.close();}
});
test('R30 direct gateway job blocks a Workflow until cleared, without another dispatch',async()=>{
 const f=await fixture();try{
  const d=await f.device('shared terminal');
  const job=await f.gateway.dispatch('parent',{deviceId:d.deviceId,
   capability:'audio.output',params:{text:'Virtual notification'},requestId:rid()});
  assert.equal(job.ok,true);
  const blocked=await f.workflows.start('parent',{recipe:'story.corner',
   deviceId:d.deviceId,requestId:rid()});
  assert.equal(blocked.ok,false);
  assert.equal(blocked.message,'NO_APPROVED_AVAILABLE_DEVICE');
  assert.equal(f.gateway.list().length,1);
  await f.gateway.cancel('parent',job.job.id);
  const next=await f.workflows.start('parent',{recipe:'story.corner',
   deviceId:d.deviceId,requestId:rid()});
  assert.equal(next.ok,true);
 }finally{await f.close();}
});
test('R30 device revoke isolates the other device and prevents replay on restart',async()=>{
 const f=await fixture();try{
  const a=await f.device('device to revoke'),b=await f.device('other device');
  const [one,two]=await Promise.all([
   f.plans.start('parent',{templateId:'story.here',deviceId:a.deviceId,requestId:rid()}),
   f.plans.start('parent',{templateId:'story.here',deviceId:b.deviceId,requestId:rid()})
  ]);
  assert.equal(one.ok,true);assert.equal(two.ok,true);
  const initial=f.gateway.list().length;
  await f.registry.revoke('parent',a.deviceId);
  await f.gateway.disconnect(a.deviceId);
  await f.plans.tick();
  assert.equal(f.plans.get(one.plan.id).status,'stopped');
  assert.equal(f.plans.get(two.plan.id).status,'running');
  const restarted=f.create();
  await restarted.gateway.load();await restarted.plans.load();await restarted.workflows.load();
  assert.equal(restarted.gateway.list().length,initial);
  assert.equal(restarted.projector.get(one.plan.id).status,'stopped');
  assert.equal(restarted.projector.get(two.plan.id).status,'stopped');
  assert.equal(restarted.projector.get(two.plan.id).steps.at(-1).job.status,'stopped');
 }finally{await f.close();}
});
