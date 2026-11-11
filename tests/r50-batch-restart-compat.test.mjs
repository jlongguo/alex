import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {SkillBatchTransactions} from '../scripts/skill-batch-transactions.mjs';
import {SkillPackageTransactions} from '../scripts/skill-package-transactions.mjs';
import {inspectWalRecoveryRisks} from '../scripts/wal-recovery-risks.mjs';

const schema={type:'object',properties:{message:{type:'string'}},
 required:[],additionalProperties:false};
const manifest=(id)=>({schemaVersion:'alex.skill/v1',id,version:'1.0.0',
 name:'R50 metadata',description:'恢复场景测试，不运行脚本',
 permissions:[],allowedActors:['parent'],dependencies:[],
 inputSchema:schema,outputSchema:schema});
const pin=id=>({id,version:'1.0.0'});
const targets=[pin('family.alpha'),pin('family.beta')];
const proof={publisherId:'family.publisher',
 manifestSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64)};
const trust={assertTrusted:()=>({...proof})};
const batchIntent={operationId:'r50-batch-replay-01',targets,expectedPins:[]};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r50-batch-'));
 const registryFile=join(dir,'skill-packages.json');
 const batchFile=join(dir,'skill-batch-wal.json');
 const registry=new SkillPackageRegistry({file:registryFile});
 for(const row of targets){
  await registry.submit('parent',manifest(row.id));
  await registry.review('parent',{...row,decision:'approve'});
 }
 const batch=new SkillBatchTransactions({file:batchFile,registry,trust});
 return {dir,registryFile,batchFile,registry,batch,
  close:()=>rm(dir,{recursive:true,force:true})};
}
async function reopen(f){
 const registry=new SkillPackageRegistry({file:f.registryFile});
 await registry.load();
 const batch=new SkillBatchTransactions({file:f.batchFile,registry,trust});
 await batch.load();
 return {registry,batch};
}
test('R50 批量事务在 prepared 持久化后崩溃：真实重开文件、完整哈希校验与恢复仅一次',async()=>{
 const f=await fixture();try{
  const saved=f.registry.installBatch.bind(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_BEFORE_BATCH_INSTALL');};
  await assert.rejects(f.batch.apply('parent',batchIntent),/INJECTED_BEFORE_BATCH_INSTALL/);
  f.registry.installBatch=saved;
  assert.equal(f.batch.list('parent').records[0].phase,'prepared');
  const pre=await inspectWalRecoveryRisks({stateDir:f.dir});
  assert.deepEqual(pre.pending,['batch']);
  assert.equal(pre.hashChainCryptographicallyVerified,true);
  const restarted=await reopen(f);
  const report=await restarted.batch.recover('parent');
  assert.equal(report.pending,0);
  assert.equal(report.reports[0].status,'committed');
  assert.deepEqual(restarted.registry.list('parent').installed,targets);
  const baseline=restarted.registry.list('parent').history.length;
  assert.equal((await restarted.batch.recover('parent')).pending,0);
  assert.equal(restarted.registry.list('parent').history.length,baseline);
  assert.equal((await inspectWalRecoveryRisks({stateDir:f.dir})).checks[1].status,'pass');
 }finally{await f.close();}
});
test('R50 Registry 提交成功但 WAL 提交失败：重启必须识别已经应用，避免二次安装',async()=>{
 const f=await fixture();try{
  const save=f.batch.store.save.bind(f.batch.store);
  let writes=0;
  f.batch.store.save=async value=>{
   writes++;
   if(writes===2)throw Error('INJECTED_BATCH_WAL_COMMIT_CRASH');
   return save(value);
  };
  await assert.rejects(f.batch.apply('parent',batchIntent),/INJECTED_BATCH_WAL_COMMIT_CRASH/);
  assert.equal(f.batch.list('parent').records[0].phase,'prepared');
  assert.deepEqual(f.registry.list('parent').installed,targets);
  const lastHistory=f.registry.list('parent').history.length;
  const restarted=await reopen(f);
  const report=await restarted.batch.recover('parent');
  assert.equal(report.pending,0);
  assert.equal(report.reports[0].status,'committed');
  assert.equal(restarted.registry.list('parent').history.length,lastHistory);
  assert.deepEqual(restarted.registry.list('parent').installed,targets);
 }finally{await f.close();}
});
test('R50 批量事务的存储文件被篡改：扫描和事务加载都拒绝',async()=>{
 const f=await fixture();try{
  const save=f.registry.installBatch.bind(f.registry);
  f.registry.installBatch=async()=>{throw Error('INJECTED_PREPARE');};
  await assert.rejects(f.batch.apply('parent',batchIntent),/INJECTED_PREPARE/);
  f.registry.installBatch=save;
  const original=await readFile(f.batchFile,'utf8');
  const changed=JSON.parse(original);
  changed.records[0].proofs[0].artifactSha256='c'.repeat(64);
  await writeFile(f.batchFile,JSON.stringify(changed));
  assert.deepEqual((await inspectWalRecoveryRisks({stateDir:f.dir})).blocked,['batch']);
  const registry=new SkillPackageRegistry({file:f.registryFile});
  await registry.load();
  const batch=new SkillBatchTransactions({file:f.batchFile,registry,trust});
  await assert.rejects(batch.load(),/INVALID_SKILL_BATCH_WAL/);
 }finally{await f.close();}
});
test('R50 旧版 Registry v1 状态文件可读取迁移到内存 v2，未触碰原文件',async()=>{
 const f=await fixture();try{
  const current=f.registry.list('parent');
  const legacy={schemaVersion:1,packages:current.packages,
   installed:current.installed,references:current.references};
  await writeFile(f.registryFile,JSON.stringify(legacy));
  const before=await readFile(f.registryFile,'utf8');
  const migrated=new SkillPackageRegistry({file:f.registryFile});
  await migrated.load();
  assert.equal(migrated.list('parent').schemaVersion,2);
  assert.deepEqual(migrated.list('parent').history,[]);
  assert.equal(await readFile(f.registryFile,'utf8'),before);
  assert.deepEqual(migrated.list('parent').packages,current.packages);
  // 单包 WAL 仍可在新加载器中建立；该检查不自动修改历史 v1 备份。
  const single=new SkillPackageTransactions({
   file:join(f.dir,'skill-transactions.json'),registry:migrated,trust});
  await single.load();
  assert.equal(single.readiness('parent').pending.length,0);
 }finally{await f.close();}
});
