import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';
import {SIM_MAP_VERSION,initialPose} from '../scripts/navigation-simulator.mjs';
const rid=()=> 'r26_'+randomUUID().replaceAll('-','');
async function fixture({freshMs=1000,timeoutMs=5000}={}){
 const dir=await mkdtemp(join(tmpdir(),'alex-r26-feedback-'));
 let now=Date.UTC(2026,10,9,0,0);
 const clock=()=>now;
 const registry=new DeviceRegistry(join(dir,'devices.json'),{clock});
 const gateway=new DeviceGateway(join(dir,'gateway.json'),registry,{clock,freshMs,timeoutMs});
 const pairing=registry.start('parent');
 const device=await registry.complete(pairing.code,'R26 virtual terminal');
 await gateway.announce(device.deviceId,device.token,
  ['sim.navigation.goto','audio.output','display.face'],3);
 await registry.heartbeat(device.deviceId,device.token);
 await gateway.approve('parent',device.deviceId,
  ['sim.navigation.goto','audio.output','display.face']);
 const dispatch=async(capability,params)=>{
  const created=await gateway.dispatch('parent',{
   deviceId:device.deviceId,capability,params,requestId:rid()
  });
  assert.equal(created.ok,true);return created.job;
 };
 return {dir,clock,registry,gateway,device,dispatch,advance:ms=>now+=ms,
  heartbeat:()=>registry.heartbeat(device.deviceId,device.token),
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('R26 late completion after deadline fails closed even before periodic expire()',async()=>{
 const t=await fixture();try{
  const job=await t.dispatch('audio.output',{text:'A safe demo message'});
  assert.equal((await t.gateway.result(t.device.deviceId,t.device.token,
   {jobId:job.id,status:'running'})).ok,true);
  t.advance(6000);await t.heartbeat();
  const finish=await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'succeeded'});
  assert.deepEqual({ok:finish.ok,message:finish.message},
   {ok:false,message:'TASK_FEEDBACK_EXPIRED'});
  assert.equal(t.gateway.list().find(x=>x.id===job.id).status,'stopped');
  const restored=new DeviceGateway(join(t.dir,'gateway.json'),t.registry,
   {clock:t.clock});await restored.load();
  assert.equal(restored.list().find(x=>x.id===job.id).status,'stopped');
  assert.equal((await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'succeeded'})).message,'TASK_ALREADY_TERMINAL');
 }finally{await t.close();}
});
test('R26 stale heartbeat prevents a queued task from starting',async()=>{
 const t=await fixture();try{
  const job=await t.dispatch('display.face',{expression:'happy'});
  t.advance(1200);
  const started=await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'running'});
  assert.equal(started.message,'TASK_FEEDBACK_EXPIRED');
  assert.equal(t.gateway.list().find(x=>x.id===job.id).status,'stopped');
  assert.equal((await t.gateway.expire()),0);
 }finally{await t.close();}
});
test('R26 stale presentation evidence cannot authorize success',async()=>{
 const t=await fixture();try{
  const job=await t.dispatch('audio.output',{text:'Short text'});
  await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'running'});
  t.advance(1200);
  const evidence=await t.gateway.presentation(t.device.deviceId,t.device.token,{
   jobId:job.id,sequence:1,phase:'rendered',kind:'audio.output',
   observed:{characters:10}});
  assert.equal(evidence.message,'TASK_FEEDBACK_EXPIRED');
  assert.equal(t.gateway.list().find(x=>x.id===job.id).presentationEvidence,undefined);
  assert.equal((await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'succeeded'})).message,'TASK_ALREADY_TERMINAL');
 }finally{await t.close();}
});
test('R26 stale navigation telemetry cannot change pose or progress',async()=>{
 const t=await fixture();try{
  const job=await t.dispatch('sim.navigation.goto',{destination:'dock'});
  await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'running'});
  t.advance(1200);
  const result=await t.gateway.telemetry(t.device.deviceId,t.device.token,{
   jobId:job.id,sequence:1,phase:'planning',progress:0,
   pose:initialPose(),mapVersion:SIM_MAP_VERSION});
  assert.equal(result.message,'TASK_FEEDBACK_EXPIRED');
  const saved=t.gateway.list().find(x=>x.id===job.id);
  assert.equal(saved.status,'stopped');assert.equal(saved.telemetry,undefined);
 }finally{await t.close();}
});
test('R26 on-time feedback remains compatible with existing virtual client',async()=>{
 const t=await fixture();try{
  const job=await t.dispatch('audio.output',{text:'Hello'});
  assert.equal((await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'running'})).ok,true);
  const evidence=await t.gateway.presentation(t.device.deviceId,t.device.token,{
   jobId:job.id,sequence:1,phase:'rendered',kind:'audio.output',
   observed:{characters:5}});
  assert.equal(evidence.ok,true);
  assert.equal((await t.gateway.result(t.device.deviceId,t.device.token,{
   jobId:job.id,status:'succeeded'})).ok,true);
 }finally{await t.close();}
});
