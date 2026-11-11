import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../scripts/skill-package-trust.mjs';
import {inspectWalRecoveryRisks} from '../scripts/wal-recovery-risks.mjs';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';

const fixture=async()=>mkdtemp(join(tmpdir(),'alex-r49-wal-'));
const sha=x=>createHash('sha256').update(canonicalJson(x)).digest('hex');
const digest='a'.repeat(64);
const prev='0'.repeat(64);
const intent={operationId:'r49-single-01',id:'family.sample',version:'1.0.0',
 expectedCurrentVersion:null,publisherId:'family.publisher',
 manifestSha256:digest,artifactSha256:'b'.repeat(64)};
const pin={id:'family.sample',version:'1.0.0'};
const single=(phase='prepared')=>{
 const requestHash=sha(intent);
 const row={seq:1,phase,prevHash:prev,requestHash,intent};
 return {schemaVersion:1,records:[{...row,hash:sha(row)}]};
};
const batch=(phase='prepared')=>{
 const targets=[pin],expectedPins=[],proofs=[{
  ...pin,publisherId:'family.publisher',manifestSha256:digest,
  artifactSha256:'b'.repeat(64)}];
 const baseline={historyLength:0,historyHash:prev,snapshotHash:digest};
 const requestHash=sha({targets,expectedPins});
 const row={seq:1,phase,prevHash:prev,requestHash,
  operationId:'r49-batch-01',targets,expectedPins,proofs,baseline};
 return {schemaVersion:1,records:[{...row,hash:sha(row)}]};
};
const auth={AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r49-test-only-parent-password'};

test('R49 没有 WAL 时报告空白，禁止宣称运行恢复或完整加密哈希检查',async()=>{
 const dir=await fixture();try{
  const scan=await inspectWalRecoveryRisks({stateDir:dir,env:auth});
  assert.deepEqual(scan.checks.map(x=>x.status),['absent','absent']);
  assert.equal(scan.recoveryExecuted,false);
  assert.equal(scan.hashChainCryptographicallyVerified,true);
  assert.equal(scan.approvedForUpgrade,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 单包与批量 prepared 均阻止升级，即使浅层结构合法',async()=>{
 const dir=await fixture();try{
  await writeFile(join(dir,'skill-transactions.json'),JSON.stringify(single()));
  await writeFile(join(dir,'skill-batch-wal.json'),JSON.stringify(batch()));
  const scan=await inspectWalRecoveryRisks({stateDir:dir,env:auth});
  assert.deepEqual(scan.pending,['single','batch']);
  assert.deepEqual(scan.checks.map(x=>x.pending),[1,1]);
  const readiness=await inspectReleasePreflight({stateDir:dir,env:auth});
  assert.ok(readiness.blocked.includes('WAL_SINGLE'));
  assert.ok(readiness.blocked.includes('WAL_BATCH'));
  assert.equal(readiness.releaseApproved,false);
  assert.equal(JSON.parse(await readFile(join(dir,'skill-transactions.json'))).records[0].phase,'prepared');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 结构正确但伪造哈希的终态不可冒充完整加密链验证成功',async()=>{
 const dir=await fixture();try{
  const forged=single('committed');
  forged.records[0].hash=digest;
  await writeFile(join(dir,'skill-transactions.json'),JSON.stringify(forged));
  const scan=await inspectWalRecoveryRisks({stateDir:dir,env:auth});
  assert.equal(scan.checks[0].status,'blocked');
  assert.equal(scan.hashChainCryptographicallyVerified,false);
  assert.equal(scan.approvedForUpgrade,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 无效版本、重复操作、断链、非法文件均拒绝',async()=>{
 const dir=await fixture();try{
  const file=join(dir,'skill-batch-wal.json');
  const bad=[
   {schemaVersion:9,records:[]},
   {schemaVersion:1,records:[{...batch().records[0],seq:2}]},
   {schemaVersion:1,records:[batch().records[0],{...batch().records[0],seq:2,prevHash:digest}]},
   {schemaVersion:1,records:[{...batch().records[0],prevHash:digest}]}
  ];
  for(const entry of bad){
   await writeFile(file,JSON.stringify(entry));
   const result=await inspectWalRecoveryRisks({stateDir:dir,env:auth});
   assert.ok(result.blocked.includes('batch'));
  }
  await writeFile(file,'{invalid');
  assert.ok((await inspectWalRecoveryRisks({stateDir:dir,env:auth})).blocked.includes('batch'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 输出只包含有界元数据，不暴露操作 ID 和儿童敏感字段',async()=>{
 const dir=await fixture();try{
  const input=single();
  input.records[0].intent.privacy='child-name-not-for-output';
  await writeFile(join(dir,'skill-transactions.json'),JSON.stringify(input));
  const report=await inspectWalRecoveryRisks({stateDir:dir,env:auth});
  assert.ok(!JSON.stringify(report).includes('child-name-not-for-output'));
  assert.ok(!JSON.stringify(report).includes('r49-single-01'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 两种已结束 WAL 均按无 pending 处理，但不构成发布许可',async()=>{
 const dir=await fixture();try{
  await writeFile(join(dir,'skill-transactions.json'),JSON.stringify(single('blocked')));
  await writeFile(join(dir,'skill-batch-wal.json'),JSON.stringify(batch('abandoned')));
  const report=await inspectReleasePreflight({stateDir:dir,env:auth});
  assert.equal(report.checks.find(c=>c.id==='WAL_SINGLE').status,'pass',JSON.stringify(report.checks));
  assert.equal(report.checks.find(c=>c.id==='WAL_BATCH').status,'pass');
  assert.equal(report.releaseApproved,false);
  assert.ok(report.manual.includes('REAL_USER_ACCEPTANCE'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
