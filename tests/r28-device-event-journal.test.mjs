import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';

async function fixture({maxEvents=500}={}){
 const dir=await mkdtemp(join(tmpdir(),'alex-r28-journal-'));
 let now=Date.UTC(2026,10,9,0,0);
 const clock=()=>now;
 const registry=new DeviceRegistry(join(dir,'devices.json'),{clock});
 const file=join(dir,'gateway.json');
 const gateway=new DeviceGateway(file,registry,{clock,freshMs:1000,timeoutMs:5000});
 const pairing=registry.start('parent');
 const d=await registry.complete(pairing.code,'R28 child-safe virtual terminal');
 await gateway.announce(d.deviceId,d.token,['audio.output','display.face'],3);
 await registry.heartbeat(d.deviceId,d.token);
 await gateway.approve('parent',d.deviceId,['audio.output','display.face']);
 const dispatch=async(text='Sensitive child speech should never enter the gateway event ledger')=>{
  const response=await gateway.dispatch('parent',{
   deviceId:d.deviceId,capability:'audio.output',params:{text},
   requestId:'r28_'+randomUUID().replaceAll('-','')
  });
  assert.equal(response.ok,true);return response.job;
 };
 return {dir,clock,file,gateway,registry,d,dispatch,
  advance:ms=>now+=ms,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('R28 durable gateway events connect dispatched jobs, result and presentation without text',async()=>{
 const t=await fixture();try{
  const job=await t.dispatch();
  await t.gateway.result(t.d.deviceId,t.d.token,{jobId:job.id,status:'running'});
  assert.equal((await t.gateway.presentation(t.d.deviceId,t.d.token,{
   jobId:job.id,sequence:1,phase:'rendered',kind:'audio.output',
   observed:{characters:job.params.text.length}})).ok,true);
  await t.gateway.result(t.d.deviceId,t.d.token,{jobId:job.id,status:'succeeded'});
  const result=t.gateway.getEvents();
  assert.equal(result.latestSeq,4);
  assert.deepEqual(result.events.map(e=>e.type),[
   'job.queued','job.updated','presentation.rendered','job.updated']);
  assert.deepEqual(result.events.map(e=>e.seq),[1,2,3,4]);
  assert.ok(result.events.every(e=>e.jobId===job.id&&e.deviceId===t.d.deviceId));
  const persisted=await readFile(t.file,'utf8');
  assert.ok(persisted.includes('Sensitive child speech'),
   'legacy task snapshot still stores virtual audio text; event history does not');
  const eventsJson=JSON.stringify(JSON.parse(persisted).events);
  assert.ok(!eventsJson.includes('Sensitive child speech'));
  assert.ok(!eventsJson.includes('params'));
  assert.ok(!eventsJson.includes('token'));
  const restored=new DeviceGateway(t.file,t.registry,{clock:t.clock});
  await restored.load();
  assert.deepEqual(restored.getEvents(),result);
  assert.deepEqual(restored.getEvents(2,{limit:1}).events.map(e=>e.seq),[3]);
 }finally{await t.close();}
});
test('R28 cancelled and expired tasks emit exactly one durable stop/cancel event',async()=>{
 const t=await fixture();try{
  const cancel=await t.dispatch('Cancel me');
  await t.gateway.cancel('parent',cancel.id);
  const late=await t.gateway.cancel('parent',cancel.id);
  assert.equal(late.ok,false);
  assert.equal(t.gateway.getEvents().events.filter(x=>x.type==='job.cancelled').length,1);
  const expire=await t.dispatch('Expire me');
  t.advance(6000);
  assert.equal((await t.gateway.result(t.d.deviceId,t.d.token,{
   jobId:expire.id,status:'running'})).message,'TASK_FEEDBACK_EXPIRED');
  assert.equal(await t.gateway.expire(),0);
  assert.equal(t.gateway.getEvents().events.filter(x=>x.jobId===expire.id&&x.type==='job.stopped').length,1);
 }finally{await t.close();}
});
test('R28 event cursor validates bounds and preserves replay-gap information',async()=>{
 const t=await fixture();try{
  await t.dispatch('A');
  assert.throws(()=>t.gateway.getEvents(-1),/INVALID_GATEWAY_EVENT_CURSOR/);
  assert.throws(()=>t.gateway.getEvents(0,{limit:501}),/INVALID_GATEWAY_EVENT_CURSOR/);
  assert.equal(t.gateway.getEvents(1).events.length,0);
  assert.equal(t.gateway.getEvents().cursorExpired,false);
  const row=await readFile(t.file,'utf8');
  const doc=JSON.parse(row);
  doc.eventSeq=800;
  doc.events=Array.from({length:500},(_,i)=>({
   seq:301+i,type:'job.updated',deviceId:t.d.deviceId,
   jobId:doc.jobs[0].id,status:'running',at:new Date(t.clock()).toISOString()
  }));
  await writeFile(t.file,JSON.stringify(doc));
  const recovered=new DeviceGateway(t.file,t.registry,{clock:t.clock});
  await recovered.load();
  const result=recovered.getEvents(0,{limit:2});
  assert.equal(result.cursorExpired,true);
  assert.equal(result.oldestSeq,301);
  assert.deepEqual(result.events.map(x=>x.seq),[301,302]);
 }finally{await t.close();}
});
test('R28 rejects tampered event sequences or payload fields at startup',async()=>{
 const t=await fixture();try{
  await t.dispatch();
  const doc=JSON.parse(await readFile(t.file,'utf8'));
  doc.events[0].params={text:'private'};
  await writeFile(t.file,JSON.stringify(doc));
  const restored=new DeviceGateway(t.file,t.registry,{clock:t.clock});
  await assert.rejects(restored.load(),/INVALID_GATEWAY_EVENTS/);
 }finally{await t.close();}
});
test('R28 revoking a device creates no duplicate events for earlier stopped jobs',async()=>{
 const t=await fixture();try{
  const first=await t.dispatch('First');
  await t.gateway.cancel('parent',first.id);
  const next=await t.dispatch('Second');
  await t.gateway.disconnect(t.d.deviceId);
  await t.gateway.disconnect(t.d.deviceId);
  const stopped=t.gateway.getEvents().events.filter(e=>e.type==='job.stopped');
  assert.equal(stopped.length,1);
  assert.equal(stopped[0].jobId,next.id);
  assert.equal(t.gateway.getEvents().events.filter(e=>e.jobId===first.id&&e.type==='job.cancelled').length,1);
 }finally{await t.close();}
});
