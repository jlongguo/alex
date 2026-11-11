import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {SkillPackageTrust,manifestDigest,signedPayload} from '../scripts/skill-package-trust.mjs';
import {SkillPackageTransactions} from '../scripts/skill-package-transactions.mjs';
import {SkillBatchTransactions} from '../scripts/skill-batch-transactions.mjs';
import {inspectWalRecoveryRisks} from '../scripts/wal-recovery-risks.mjs';
import {inspectSkillStateCompatibility} from '../scripts/skill-state-compat.mjs';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';
import {inspectSkillRecoveryEvidence} from '../scripts/skill-recovery-evidence.mjs';
import {
 createOfflineBackup,verifyOfflineBackup,stageOfflineRestore
} from '../scripts/offline-state-backup.mjs';
import {auditIsolatedRecovery} from '../scripts/recovery-stage-audit.mjs';

const schema={type:'object',properties:{message:{type:'string'}},
 required:[],additionalProperties:false};
const manifest=id=>({schemaVersion:'alex.skill/v1',id,version:'1.0.0',
 name:'R52 本地声明式 Skill',description:'只含元数据，不加载任何第三方代码',
 permissions:[],allowedActors:['parent'],dependencies:[],
 inputSchema:schema,outputSchema:schema});
const pin=id=>({id,version:'1.0.0'});
const ids=['family.r52alpha','family.r52beta'];
const auth={AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r52-isolated-parent-test-password'};
const fileNames=['skill-packages.json','skill-trust.json',
 'skill-transactions.json','skill-batch-wal.json'];
async function workspace(){
 const root=await mkdtemp(join(tmpdir(),'alex-r52-signed-wal-'));
 const source=join(root,'source'),backup=join(root,'backup'),stage=join(root,'stage');
 await mkdir(source);await mkdir(stage);
 return {root,source,backup,stage,
  close:()=>rm(root,{recursive:true,force:true})};
}
async function load(dir){
 const registry=new SkillPackageRegistry({file:join(dir,'skill-packages.json')});
 const trust=new SkillPackageTrust({file:join(dir,'skill-trust.json')});
 await registry.load();await trust.load();
 const single=new SkillPackageTransactions({
  file:join(dir,'skill-transactions.json'),registry,trust});
 const batch=new SkillBatchTransactions({
  file:join(dir,'skill-batch-wal.json'),registry,trust});
 await single.load();await batch.load();
 return {registry,trust,single,batch};
}
async function setup(dir){
 const bundle=await load(dir);
 const keys=generateKeyPairSync('ed25519');
 const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'});
 await bundle.trust.enroll('parent',{publisherId:'family.r52publisher',publicKeyPem});
 for(const id of ids){
  const m=manifest(id),artifact=Buffer.from('R52 signed artifact for '+id);
  const manifestSha256=manifestDigest(m);
  const artifactSha256=createHash('sha256').update(artifact).digest('hex');
  const signature=sign(null,signedPayload(manifestSha256,artifactSha256),
   keys.privateKey).toString('base64');
  await bundle.registry.submit('parent',m);
  await bundle.trust.attest('parent',{manifest:m,publisherId:'family.r52publisher',
   artifactBase64:artifact.toString('base64'),signature});
  await bundle.registry.review('parent',{id,version:m.version,decision:'approve'});
 }
 return bundle;
}
const snapshot=async(dir)=>Object.fromEntries(await Promise.all(fileNames.map(async name=>{
 try{return [name,await readFile(join(dir,name),'utf8')];}
 catch(error){if(error?.code==='ENOENT')return [name,null];throw error;}
})));
const report=async(dir)=>({
 wal:await inspectWalRecoveryRisks({stateDir:dir,env:auth}),
 compat:await inspectSkillStateCompatibility({stateDir:dir,env:auth}),
 release:await inspectReleasePreflight({stateDir:dir,env:auth})
});
async function restore(f){
 const original=await snapshot(f.source);
 const created=await createOfflineBackup({sourceDir:f.source,destinationDir:f.backup});
 assert.equal(created.verified.status,'verified');
 assert.equal((await verifyOfflineBackup({directory:f.backup})).status,'verified');
 const copied=await stageOfflineRestore({directory:f.backup,targetDir:f.stage});
 assert.equal(copied.status,'staged');
 assert.equal((await auditIsolatedRecovery({
  backupDir:f.backup,stageDir:f.stage})).status,'staging-copy-verified');
 assert.deepEqual(await snapshot(f.stage),original);
 return original;
}

test('R52 真实 Ed25519 单包 WAL：prepared→备份→隔离恢复→重放一次，来源不变',{timeout:25000},async()=>{
 const f=await workspace();try{
  const initial=await setup(f.source);
  const originalInstall=initial.registry.install.bind(initial.registry);
  initial.registry.install=async()=>{throw Error('R52_INJECTED_SINGLE_CRASH');};
  await assert.rejects(initial.single.apply('parent',{
   operationId:'r52-single-prepare-001',...pin(ids[0])}),/R52_INJECTED_SINGLE_CRASH/);
  initial.registry.install=originalInstall;
  const before=await report(f.source);
  assert.deepEqual(before.wal.pending,['single']);
  const proofBefore=await inspectSkillRecoveryEvidence({stateDir:f.source,env:auth});
  assert.equal(proofBefore.status,'manual-review-required');
  assert.equal(proofBefore.pending,1);
  assert.equal(proofBefore.proofRejected,0);
  assert.equal(proofBefore.replayExecuted,false);
  assert.ok(before.release.blocked.includes('WAL_SINGLE'));
  assert.equal(before.compat.checks.find(c=>c.id==='TRUST').status,'pass');
  assert.equal(before.release.releaseApproved,false);
  const sourceFiles=await restore(f);
  const restarted=await load(f.stage);
  const recovered=await restarted.single.recover('parent');
  assert.equal(recovered.pending,0);
  assert.equal(recovered.reports[0].status,'committed');
  assert.deepEqual(restarted.registry.list('parent').installed,[pin(ids[0])]);
  const historyLength=restarted.registry.list('parent').history.length;
  assert.equal((await restarted.single.recover('parent')).pending,0);
  assert.equal(restarted.registry.list('parent').history.length,historyLength);
  const after=await report(f.stage);
  assert.deepEqual(after.wal.pending,[]);
  assert.equal((await inspectSkillRecoveryEvidence({stateDir:f.stage,env:auth})).status,'pass');
  assert.deepEqual(after.compat.blocked,[]);
  assert.deepEqual(after.release.blocked,[]);
  assert.equal(after.release.releaseApproved,false);
  assert.deepEqual(await snapshot(f.source),sourceFiles);
 }finally{await f.close();}
});

test('R52 双包真实签名批量安装：Registry 已提交而 WAL commit 失败，隔离恢复无重复安装',{timeout:25000},async()=>{
 const f=await workspace();try{
  const initial=await setup(f.source);
  const save=initial.batch.store.save.bind(initial.batch.store);
  let writes=0;
  initial.batch.store.save=async value=>{
   writes++;
   if(writes===2)throw Error('R52_INJECTED_BATCH_COMMIT_CRASH');
   return save(value);
  };
  await assert.rejects(initial.batch.apply('parent',{
   operationId:'r52-batch-commit-001',targets:ids.map(pin),expectedPins:[]
  }),/R52_INJECTED_BATCH_COMMIT_CRASH/);
  assert.deepEqual(initial.registry.list('parent').installed,ids.map(pin));
  const pending=await report(f.source);
  assert.deepEqual(pending.wal.pending,['batch']);
  const pendingProof=await inspectSkillRecoveryEvidence({stateDir:f.source,env:auth});
  assert.equal(pendingProof.pending,1);
  assert.equal(pendingProof.proofRejected,0);
  assert.equal(pendingProof.status,'manual-review-required');
  assert.deepEqual(pending.compat.blocked,[]);
  assert.ok(pending.release.blocked.includes('WAL_BATCH'));
  const originals=await restore(f);
  const restarted=await load(f.stage);
  const originalHistory=restarted.registry.list('parent').history.length;
  const recovered=await restarted.batch.recover('parent');
  assert.equal(recovered.pending,0);
  assert.equal(recovered.reports[0].status,'committed');
  assert.equal(restarted.registry.list('parent').history.length,originalHistory);
  assert.deepEqual(restarted.registry.list('parent').installed,ids.map(pin));
  assert.equal((await restarted.batch.recover('parent')).pending,0);
  assert.equal(restarted.registry.list('parent').history.length,originalHistory);
  const after=await report(f.stage);
  assert.deepEqual(after.wal.blocked,[]);
  assert.deepEqual(after.wal.pending,[]);
  assert.deepEqual(after.compat.blocked,[]);
  assert.deepEqual(after.release.blocked,[]);
  assert.equal(after.release.releaseApproved,false);
  assert.deepEqual(await snapshot(f.source),originals);
 }finally{await f.close();}
});

test('R52 证书撤销后不能自动重放 prepared；日志及安装引用保持未修改',{timeout:25000},async()=>{
 const f=await workspace();try{
  const initial=await setup(f.source);
  initial.registry.installBatch=async()=>{throw Error('R52_INJECTED_PREPARE');};
  await assert.rejects(initial.batch.apply('parent',{
   operationId:'r52-batch-revoke-001',targets:ids.map(pin),expectedPins:[]
  }),/R52_INJECTED_PREPARE/);
  await initial.trust.revoke('parent',{publisherId:'family.r52publisher'});
  const originals=await restore(f);
  const restarted=await load(f.stage);
  const before=await snapshot(f.stage);
  const recovered=await restarted.batch.recover('parent');
  assert.equal(recovered.pending,1);
  assert.equal(recovered.reports[0].status,'needs-review');
  assert.equal(recovered.reports[0].error,'PUBLISHER_NOT_ACTIVE');
  assert.deepEqual(restarted.registry.list('parent').installed,[]);
  assert.deepEqual(await snapshot(f.stage),before);
  const verification=await report(f.stage);
  assert.deepEqual(verification.wal.pending,['batch']);
  const rejected=await inspectSkillRecoveryEvidence({stateDir:f.stage,env:auth});
  assert.equal(rejected.status,'blocked');
  assert.equal(rejected.proofRejected,1);
  assert.deepEqual(rejected.blockers,['PENDING_PROVENANCE_INVALID']);
  assert.ok(verification.release.blocked.includes('SKILL_PENDING_PROOFS'));
  assert.ok(verification.release.blocked.includes('WAL_BATCH'));
  assert.equal(verification.release.releaseApproved,false);
  assert.deepEqual(await snapshot(f.source),originals);
 }finally{await f.close();}
});

test('R52 备份文件的 WAL proof 发生篡改，不允许作为隔离恢复候选',{timeout:25000},async()=>{
 const f=await workspace();try{
  const initial=await setup(f.source);
  initial.registry.installBatch=async()=>{throw Error('R52_INJECTED_PREPARE');};
  await assert.rejects(initial.batch.apply('parent',{
   operationId:'r52-batch-proof-001',targets:ids.map(pin),expectedPins:[]
  }),/R52_INJECTED_PREPARE/);
  await createOfflineBackup({sourceDir:f.source,destinationDir:f.backup});
  const walPath=join(f.backup,'skill-batch-wal.json');
  const tampered=JSON.parse(await readFile(walPath,'utf8'));
  tampered.records[0].proofs[0].artifactSha256='f'.repeat(64);
  await writeFile(walPath,JSON.stringify(tampered));
  await assert.rejects(stageOfflineRestore({
   directory:f.backup,targetDir:f.stage
  }),/ALEX_BACKUP_FILE_MISMATCH/);
  assert.deepEqual(await snapshot(f.stage),Object.fromEntries(fileNames.map(n=>[n,null])));
 }finally{await f.close();}
});
