import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createOfflineBackup,stageOfflineRestore} from '../scripts/offline-state-backup.mjs';
import {auditIsolatedRecovery} from '../scripts/recovery-stage-audit.mjs';

async function dirs(){
 const root=await mkdtemp(join(tmpdir(),'alex-r48-stage-'));
 const source=join(root,'source'),backup=join(root,'backup'),stage=join(root,'stage');
 await mkdir(source);await mkdir(stage);
 await writeFile(join(source,'profiles.json'),'{"version":1,"profiles":[]}');
 await createOfflineBackup({sourceDir:source,destinationDir:backup});
 await stageOfflineRestore({directory:backup,targetDir:stage});
 return {root,source,backup,stage,close:()=>rm(root,{recursive:true,force:true})};
}
test('R48 只读核验备份恢复副本完整性，不能冒充业务加载',async()=>{
 const f=await dirs();try{
  const result=await auditIsolatedRecovery({backupDir:f.backup,stageDir:f.stage});
  assert.equal(result.status,'staging-copy-verified');
  assert.equal(result.fileCount,1);
  assert.equal(result.businessLoadVerified,false);
  assert.equal(result.rollbackExecuted,false);
  assert.equal(result.releaseApproved,false);
  assert.equal(result.productionRestored,false);
 }finally{await f.close();}
});
test('R48 已复制的隔离文件被修改必须拒绝恢复验收',async()=>{
 const f=await dirs();try{
  await writeFile(join(f.stage,'profiles.json'),'{"version":1,"profiles":[1]}');
  await assert.rejects(auditIsolatedRecovery({
   backupDir:f.backup,stageDir:f.stage
  }),/RECOVERY_AUDIT_DIGEST_MISMATCH/);
 }finally{await f.close();}
});
test('R48 额外临时文件或缺文件必须拒绝校验，不能默默忽略',async()=>{
 const f=await dirs();try{
  await writeFile(join(f.stage,'unexpected.json'),'{"error":true}');
  await assert.rejects(auditIsolatedRecovery({
   backupDir:f.backup,stageDir:f.stage
  }),/RECOVERY_AUDIT_FILE_SET_MISMATCH/);
 }finally{await f.close();}
});
test('R48 不允许备份和隔离恢复目录重叠',async()=>{
 const f=await dirs();try{
  await assert.rejects(auditIsolatedRecovery({
   backupDir:f.backup,stageDir:f.backup
  }),/RECOVERY_AUDIT_OVERLAPPING_PATH/);
 }finally{await f.close();}
});
test('R48 CLI 返回机器可读聚合状态且不打印儿童隐私信息',async()=>{
 const f=await dirs();try{
  const original=await readFile(join(f.stage,'profiles.json'),'utf8');
  const cmd=spawnSync(process.execPath,[
   resolve(import.meta.dirname,'../scripts/recovery-stage-audit.mjs'),
   f.backup,f.stage],{encoding:'utf8',timeout:12000});
  assert.equal(cmd.status,0,cmd.stderr);
  const result=JSON.parse(cmd.stdout);
  assert.equal(result.status,'staging-copy-verified');
  assert.equal(result.businessLoadVerified,false);
  assert.equal(JSON.stringify(result).includes('profiles.json'),false);
  assert.equal(await readFile(join(f.stage,'profiles.json'),'utf8'),original);
 }finally{await f.close();}
});
