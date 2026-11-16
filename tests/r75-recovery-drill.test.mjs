import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createOfflineBackup} from '../scripts/offline-state-backup.mjs';
import {
 runRecoveryDrill,verifyRecoveryDrillEvidence
} from '../scripts/recovery-drill.mjs';

const root=resolve(import.meta.dirname,'..');
const SHA='0123456789abcdef0123456789abcdef01234567';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r75-drill-'));
 const source=join(dir,'source'),backup=join(dir,'backup'),stage=join(dir,'stage');
 await mkdir(source);await mkdir(stage);
 await writeFile(join(source,'profiles.json'),JSON.stringify({version:1,profiles:[]}));
 await createOfflineBackup({sourceDir:source,destinationDir:backup});
 return {dir,source,backup,stage,close:()=>rm(dir,{recursive:true,force:true})};
}

test('R75 正式 Recovery Drill 从备份恢复 staging 并真实启动 Alex health',{timeout:30000},async()=>{
 const f=await fixture();
 try{
  const report=await runRecoveryDrill({
   backupDir:f.backup,stageDir:f.stage,commitSha:SHA,
   createdAt:'2026-11-16T10:00:00.000Z'
  });
  assert.equal(report.schema,'alex.dev/recovery-drill/v1');
  assert.equal(report.status,'verified');
  assert.equal(report.commitSha,SHA);
  assert.equal(report.backup.integrity,'verified-before-and-after');
  assert.equal(report.staging.productionRestored,false);
  assert.equal(report.staging.audit,'staging-copy-verified');
  assert.deepEqual(report.preflight.blocked,[]);
  assert.equal(report.businessLoad.serverBooted,true);
  assert.equal(report.businessLoad.healthEndpointVerified,true);
  assert.equal(report.businessLoad.cleanShutdown,true);
  assert.equal(report.businessLoad.externalProvidersDisabled,true);
  assert.equal(report.rollbackExecuted,false);
  assert.equal(report.releaseApproved,false);
  assert.equal(report.physicalSafetyCertified,false);
  assert.equal(verifyRecoveryDrillEvidence(report,{expectedCommit:SHA}),true);
 }finally{await f.close();}
});

test('R75 Recovery Drill 拒绝非空 staging，绝不覆盖既有状态',{timeout:15000},async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.stage,'keep.json'),'{"keep":true}');
  await assert.rejects(runRecoveryDrill({
   backupDir:f.backup,stageDir:f.stage,commitSha:SHA
  }),/ALEX_RESTORE_TARGET_NOT_EMPTY/);
  assert.equal(await readFile(join(f.stage,'keep.json'),'utf8'),'{"keep":true}');
 }finally{await f.close();}
});

test('R75 Recovery Drill Evidence 被篡改或跨 Commit 使用必须拒绝',{timeout:30000},async()=>{
 const f=await fixture();
 try{
  const report=await runRecoveryDrill({
   backupDir:f.backup,stageDir:f.stage,commitSha:SHA
  });
  const altered=structuredClone(report);
  altered.businessLoad.cleanShutdown=false;
  assert.throws(()=>verifyRecoveryDrillEvidence(altered),/RECOVERY_DRILL_EVIDENCE_INVALID/);
  assert.throws(()=>verifyRecoveryDrillEvidence(report,{expectedCommit:'f'.repeat(40)}),
   /RECOVERY_DRILL_COMMIT_MISMATCH/);
  const digestTamper=structuredClone(report);
  digestTamper.note+=' changed';
  assert.throws(()=>verifyRecoveryDrillEvidence(digestTamper),/RECOVERY_DRILL_DIGEST_MISMATCH/);
 }finally{await f.close();}
});

test('R75 CLI 写出机器可读证据且 verify 绑定 commit',{timeout:30000},async()=>{
 const f=await fixture();
 const report=join(f.dir,'report.json');
 try{
  const run=spawnSync(process.execPath,[
   'scripts/recovery-drill.mjs','run',f.backup,f.stage,SHA,report
  ],{cwd:root,encoding:'utf8',timeout:25000});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/RECOVERY_DRILL_VERIFIED:/);
  const verify=spawnSync(process.execPath,[
   'scripts/recovery-drill.mjs','verify',report,SHA
  ],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(verify.status,0,verify.stderr);
  assert.match(verify.stdout,/RECOVERY_DRILL_EVIDENCE_VERIFIED:/);
 }finally{await f.close();}
});
