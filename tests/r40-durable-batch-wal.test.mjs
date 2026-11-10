import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {SkillBatchTransactions} from '../scripts/skill-batch-transactions.mjs';
const schema={type:'object',properties:{},required:[],additionalProperties:false};
const manifest=(id,version,dependencies=[])=>({
 schemaVersion:'alex.skill/v1',id,version,name:'Signed metadata',
 description:'No executable payload',permissions:[],allowedActors:['parent'],
 dependencies,inputSchema:schema,outputSchema:schema});
const pin=(id,version)=>({id,version});
const operationId='parent-batch-operation-001';
const trust={
 assertTrusted:m=>({publisherId:'family.publisher',
 manifestSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64)})
};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r40-'));
 const file=join(dir,'registry.json'),wal=join(dir,'batch-wal.json');
 const registry=new SkillPackageRegistry({file});
 const batch=new SkillBatchTransactions({file:wal,registry,trust});
 const cleanup=()=>rm(dir,{recursive:true,force:true});
 return {file,wal,registry,batch,cleanup};
}
async function setup(registry){
 const versions=[
  manifest('family.alpha','1.0.0',[pin('family.beta','1.0.0')]),
  manifest('family.beta','1.0.0'),
  manifest('family.alpha','2.0.0',[pin('family.beta','2.0.0')]),
  manifest('family.beta','2.0.0')
 ];
 for(const m of versions){
  await registry.submit('parent',m);
  await registry.review('parent',{id:m.id,version:m.version,decision:'approve'});
 }
 await registry.install('parent',{id:'family.beta',version:'1.0.0'});
 await registry.install('parent',{id:'family.alpha',version:'1.0.0'});
}
const request=r=>({operationId,
 targets:[pin('family.alpha','2.0.0'),pin('family.beta','2.0.0')],
 expectedPins:r.list('parent').installed});
test('R40 durable batch WAL verifies two mutually-pinned upgrades and idempotence',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry),before=f.registry.list('parent');
  assert.throws(()=>f.batch.apply('child',data),/PARENT_REQUIRED/);
  const result=await f.batch.apply('parent',data);
  assert.equal(result.status,'committed');assert.equal(result.executable,false);
  const state=f.registry.list('parent');
  assert.equal(state.history.length,before.history.length+1);
  assert.equal(state.history.at(-1).action,'batch-install');
  assert.deepEqual(state.installed.map(i=>i.version),['2.0.0','2.0.0']);
  assert.equal(f.batch.list('parent').records[0].phase,'committed');
  assert.equal((await f.batch.apply('parent',data)).status,'committed');
  assert.equal(f.registry.list('parent').history.length,state.history.length);
  await assert.rejects(f.batch.apply('parent',{...data,targets:[pin('family.alpha','1.0.0')]}),
   /SKILL_BATCH_IDEMPOTENCY_CONFLICT/);
 }finally{await f.cleanup();}
});
test('R40 crash after durable prepare but before registry snapshot is safely replayed once',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  const original=f.registry.installBatch.bind(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_CRASH_BEFORE_REGISTRY');};
  await assert.rejects(f.batch.apply('parent',data),/INJECTED_CRASH_BEFORE_REGISTRY/);
  const before=f.registry.list('parent');
  assert.equal(f.batch.list('parent').records[0].phase,'prepared');
  await assert.rejects(f.registry.submit('parent',manifest('family.other','1.0.0')),
   /SKILL_BATCH_TRANSACTION_ISOLATED/);
  const registry=new SkillPackageRegistry({file:f.file});await registry.load();
  const resumed=new SkillBatchTransactions({file:f.wal,registry,trust});await resumed.load();
  const recovered=await resumed.recover('parent');
  assert.equal(recovered.pending,0);
  assert.equal(recovered.reports[0].status,'committed');
  assert.equal(registry.list('parent').history.length,before.history.length+1);
  assert.equal(registry.list('parent').history.at(-1).action,'batch-install');
  assert.equal((await resumed.recover('parent')).pending,0);
  f.registry.installBatch=original;
 }finally{await f.cleanup();}
});
test('R40 crash after atomic registry commit but before WAL completion is not replayed',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  const original=f.batch.store.save.bind(f.batch.store);
  let saves=0;
  f.batch.store.save=async next=>{
   if(++saves===2)throw Error('INJECTED_CRASH_AFTER_REGISTRY');
   return original(next);
  };
  await assert.rejects(f.batch.apply('parent',data),/INJECTED_CRASH_AFTER_REGISTRY/);
  const before=f.registry.list('parent');
  assert.equal(before.installed[0].version,'2.0.0');
  const registry=new SkillPackageRegistry({file:f.file});await registry.load();
  const recovered=new SkillBatchTransactions({file:f.wal,registry,trust});
  await recovered.load();
  assert.equal((await recovered.recover('parent')).pending,0);
  assert.equal(registry.list('parent').history.length,before.history.length);
  assert.equal(recovered.list('parent').records[0].phase,'committed');
 }finally{await f.cleanup();}
});
test('R40 signed evidence change fails closed and does not alter registry',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_BEFORE_INSTALL');};
  await assert.rejects(f.batch.apply('parent',data),/INJECTED_BEFORE_INSTALL/);
  const before=f.registry.list('parent');
  const badTrust={assertTrusted:()=>({...trust.assertTrusted(),artifactSha256:'c'.repeat(64)})};
  const restartedRegistry=new SkillPackageRegistry({file:f.file});await restartedRegistry.load();
  const restarted=new SkillBatchTransactions({file:f.wal,registry:restartedRegistry,trust:badTrust});
  await restarted.load();
  const recovery=await restarted.recover('parent');
  assert.equal(recovery.pending,1);
  assert.equal(recovery.reports[0].error,'SKILL_BATCH_EVIDENCE_DRIFT');
  assert.deepEqual(restartedRegistry.list('parent'),before);
 }finally{await f.cleanup();}
});
test('R40 protected WAL can only be abandoned while checkpoint remains untouched',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_AFTER_PREPARE');};
  await assert.rejects(f.batch.apply('parent',data),/INJECTED_AFTER_PREPARE/);
  assert.throws(()=>f.batch.abandon('child',{operationId}),/PARENT_REQUIRED/);
  const result=await f.batch.abandon('parent',{operationId});
  assert.equal(result.status,'abandoned');
  assert.equal(f.batch.list('parent').records[0].phase,'abandoned');
  await assert.rejects(f.batch.apply('parent',data),/SKILL_BATCH_TRANSACTION_ABANDONED/);
  await f.registry.submit('parent',manifest('family.other','1.0.0'));
 }finally{await f.cleanup();}
});
test('R40 tampered WAL digest is rejected on restart',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  await f.batch.apply('parent',request(f.registry));
  const forged=JSON.parse(await readFile(f.wal,'utf8'));
  forged.records[0].targets[0].version='99.0.0';
  await writeFile(f.wal,JSON.stringify(forged));
  const restarted=new SkillBatchTransactions({file:f.wal,registry:f.registry,trust});
  await assert.rejects(restarted.load(),/INVALID_SKILL_BATCH_WAL/);
 }finally{await f.cleanup();}
});
test('R40 stale precondition and invalid target fail before WAL prepare',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  await assert.rejects(f.batch.apply('parent',{...data,expectedPins:[]}),/SKILL_INSTALL_CONFLICT/);
  await assert.rejects(f.batch.apply('parent',{...data,targets:[data.targets[0],data.targets[0]]}),
   /INVALID_SKILL_BATCH_TRANSACTION/);
  assert.deepEqual(f.batch.list('parent').records,[]);
 }finally{await f.cleanup();}
});

test('R40 external registry modification after prepare is never mistaken for own batch commit',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_CRASH_BEFORE_REGISTRY');};
  await assert.rejects(f.batch.apply('parent',data),/INJECTED_CRASH_BEFORE_REGISTRY/);
  const altered=new SkillPackageRegistry({file:f.file});await altered.load();
  await altered.submit('parent',manifest('family.unrelated','1.0.0'));
  const before=altered.list('parent');
  const recovering=new SkillBatchTransactions({file:f.wal,registry:altered,trust});
  await recovering.load();
  const result=await recovering.recover('parent');
  assert.equal(result.pending,1);
  assert.equal(result.reports[0].error,'SKILL_BATCH_RECOVERY_CONFLICT');
  assert.deepEqual(altered.list('parent'),before);
  await assert.rejects(recovering.abandon('parent',{operationId}),/SKILL_BATCH_RECOVERY_CONFLICT/);
 }finally{await f.cleanup();}
});
test('R40 publisher revocation after prepare blocks restart until parent resolves trust',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_BEFORE_COMMIT');};
  await assert.rejects(f.batch.apply('parent',data),/INJECTED_BEFORE_COMMIT/);
  const freshRegistry=new SkillPackageRegistry({file:f.file});await freshRegistry.load();
  const revoked={assertTrusted:()=>{throw Error('PUBLISHER_NOT_ACTIVE');}};
  const batch=new SkillBatchTransactions({file:f.wal,registry:freshRegistry,trust:revoked});
  await batch.load();
  const recovery=await batch.recover('parent');
  assert.equal(recovery.pending,1);
  assert.equal(recovery.reports[0].error,'PUBLISHER_NOT_ACTIVE');
  assert.equal(freshRegistry.list('parent').installed[0].version,'1.0.0');
 }finally{await f.cleanup();}
});
test('R40 committed WAL survives full restart and preserves original idempotency key',async()=>{
 const f=await fixture();try{
  await setup(f.registry);
  const data=request(f.registry);
  await f.batch.apply('parent',data);
  const loaded=new SkillPackageRegistry({file:f.file});await loaded.load();
  const wal=new SkillBatchTransactions({file:f.wal,registry:loaded,trust});await wal.load();
  const before=loaded.list('parent').history.length;
  assert.equal((await wal.apply('parent',data)).status,'committed');
  assert.equal((await wal.recover('parent')).pending,0);
  assert.equal(loaded.list('parent').history.length,before);
  assert.equal(wal.readiness('parent').remaining,399);
 }finally{await f.cleanup();}
});
