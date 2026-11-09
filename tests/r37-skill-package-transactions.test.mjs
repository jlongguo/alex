import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {SkillPackageTransactions} from '../scripts/skill-package-transactions.mjs';
const shape={type:'object',properties:{message:{type:'string'}},required:[],additionalProperties:false};
const manifest=(version='1.0.0')=>({schemaVersion:'alex.skill/v1',id:'family.sample',
 version,name:'Sample',description:'Declarative only',permissions:[],allowedActors:['parent'],
 dependencies:[],inputSchema:shape,outputSchema:shape});
const proof={publisherId:'family.publisher',manifestSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64)};
const operationId='operation-test-001';
const intent={operationId,id:'family.sample',version:'1.0.0',expectedCurrentVersion:null};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r37-'));
 const file=join(dir,'transactions.json'),registryFile=join(dir,'registry.json');
 const trust={assertTrusted:()=>({...proof})};
 const registry=new SkillPackageRegistry({file:registryFile});
 const wal=new SkillPackageTransactions({file,registry,trust});
 await registry.submit('parent',manifest());
 return {dir,file,registryFile,trust,registry,wal,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
test('R37 WAL persists intent, approves signed metadata, commits and returns idempotent result',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.wal.apply('child',intent),/PARENT_REQUIRED/);
  const result=await f.wal.apply('parent',intent);
  assert.deepEqual(result,{operationId,status:'committed',id:'family.sample',version:'1.0.0',executable:false});
  const r=f.registry.list('parent');
  assert.equal(r.packages[0].status,'approved');
  assert.equal(r.installed[0].version,'1.0.0');
  assert.deepEqual(r.history.map(e=>e.action),['submit','review','install']);
  assert.equal(f.wal.list('parent').records[0].phase,'committed');
  assert.equal(f.wal.list('parent').records[0].intent.publisherId,proof.publisherId);
  assert.equal((await f.wal.apply('parent',intent)).status,'committed');
  assert.equal(f.registry.list('parent').history.length,3);
  await assert.rejects(f.wal.apply('parent',{...intent,version:'1.0.1'}),
    /UNKNOWN_SKILL_PACKAGE/);
  const fresh=new SkillPackageTransactions({file:f.file,registry:f.registry,trust:f.trust});
  await fresh.load();
  assert.equal((await fresh.recover('parent')).pending,0);
 }finally{await f.cleanup();}
});
test('R37 crash between persisted intent and registry review is recoverable',async()=>{
 const f=await fixture();try{
  const original=f.registry.review.bind(f.registry);
  f.registry.review=async()=>{throw Error('INJECTED_CRASH_AFTER_PREPARE');};
  await assert.rejects(f.wal.apply('parent',intent),/INJECTED_CRASH_AFTER_PREPARE/);
  assert.equal(f.wal.list('parent').records[0].phase,'prepared');
  f.registry.review=original;
  const registry=new SkillPackageRegistry({file:f.registryFile});await registry.load();
  const coordinator=new SkillPackageTransactions({file:f.file,registry,trust:f.trust});
  await coordinator.load();
  const recovery=await coordinator.recover('parent');
  assert.equal(recovery.pending,0);
  assert.equal(recovery.reports[0].status,'committed');
  assert.equal(registry.list('parent').history.filter(x=>x.action==='review').length,1);
  assert.equal(registry.list('parent').history.filter(x=>x.action==='install').length,1);
 }finally{await f.cleanup();}
});
test('R37 crash after review before install retries only install, no duplicate approval',async()=>{
 const f=await fixture();try{
  const original=f.registry.install.bind(f.registry);
  f.registry.install=async()=>{throw Error('INJECTED_CRASH_AFTER_REVIEW');};
  await assert.rejects(f.wal.apply('parent',intent),/INJECTED_CRASH_AFTER_REVIEW/);
  assert.equal(f.registry.list('parent').packages[0].status,'approved');
  f.registry.install=original;
  const restartRegistry=new SkillPackageRegistry({file:f.registryFile});await restartRegistry.load();
  const restarted=new SkillPackageTransactions({file:f.file,registry:restartRegistry,trust:f.trust});
  await restarted.load();
  assert.equal((await restarted.recover('parent')).pending,0);
  assert.deepEqual(restartRegistry.list('parent').history.map(x=>x.action),['submit','review','install']);
 }finally{await f.cleanup();}
});
test('R37 crash after installed pin but before WAL commit does not install twice',async()=>{
 const f=await fixture();try{
  const original=f.wal.store.save.bind(f.wal.store);
  let saveCount=0;
  f.wal.store.save=async snapshot=>{
   saveCount++;
   if(saveCount===2)throw Error('INJECTED_CRASH_AFTER_INSTALL');
   return original(snapshot);
  };
  await assert.rejects(f.wal.apply('parent',intent),/INJECTED_CRASH_AFTER_INSTALL/);
  assert.equal(f.registry.list('parent').installed.length,1);
  const before=f.registry.list('parent').history.length;
  const restarted=new SkillPackageTransactions({file:f.file,registry:f.registry,trust:f.trust});
  await restarted.load();
  assert.equal((await restarted.recover('parent')).pending,0);
  assert.equal(f.registry.list('parent').history.length,before);
  assert.equal(restarted.list('parent').records[0].phase,'committed');
 }finally{await f.cleanup();}
});
test('R37 trust revocation prevents unsafe automatic recovery and leaves journal pending',async()=>{
 const f=await fixture();try{
  f.registry.install=async()=>{throw Error('INJECTED_CRASH');};
  await assert.rejects(f.wal.apply('parent',intent),/INJECTED_CRASH/);
  const badTrust={assertTrusted:()=>{throw Error('PUBLISHER_NOT_ACTIVE');}};
  const recovery=new SkillPackageTransactions({file:f.file,registry:f.registry,trust:badTrust});
  await recovery.load();
  const result=await recovery.recover('parent');
  assert.equal(result.pending,1);
  assert.equal(result.reports[0].status,'needs-review');
  assert.equal(result.reports[0].error,'PUBLISHER_NOT_ACTIVE');
 }finally{await f.cleanup();}
});
test('R37 corrupted WAL evidence hash is rejected on boot',async()=>{
 const f=await fixture();try{
  await f.wal.apply('parent',intent);
  const tampered=JSON.parse(await readFile(f.file,'utf8'));
  tampered.records[0].intent.publisherId='forged.publisher';
  await writeFile(f.file,JSON.stringify(tampered));
  const restarted=new SkillPackageTransactions({file:f.file,registry:f.registry,trust:f.trust});
  await assert.rejects(restarted.load(),/INVALID_SKILL_TRANSACTION_STATE/);
 }finally{await f.cleanup();}
});
