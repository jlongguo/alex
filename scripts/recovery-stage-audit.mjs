// R48 隔离恢复副本验收：仅对照已验证的备份清单，不读取或输出家庭数据原文。
// 该核验不保证业务模块可加载；真实 Node 启动由独立 HTTP 测试完成。
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyOfflineBackup} from './offline-state-backup.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
export async function auditIsolatedRecovery({backupDir,stageDir}={}){
 if(typeof backupDir!=='string'||!backupDir||
  typeof stageDir!=='string'||!stageDir)fail('RECOVERY_AUDIT_INVALID_PATH');
 const source=resolve(backupDir),target=resolve(stageDir);
 if(source===target||source.startsWith(target+sep)||target.startsWith(source+sep))
  fail('RECOVERY_AUDIT_OVERLAPPING_PATH');
 const verified=await verifyOfflineBackup({directory:source});
 const targetStat=await lstat(target);
 if(!targetStat.isDirectory()||targetStat.isSymbolicLink())
  fail('RECOVERY_AUDIT_UNSAFE_TARGET');
 const manifest=JSON.parse(await readFile(join(source,'backup-manifest.json'),'utf8'));
 const expected=manifest.files.map(x=>x.name).sort();
 const actual=(await readdir(target)).sort();
 if(JSON.stringify(expected)!==JSON.stringify(actual))
  fail('RECOVERY_AUDIT_FILE_SET_MISMATCH');
 for(const item of manifest.files){
  const location=join(target,item.name);
  const stat=await lstat(location);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==item.size)
   fail('RECOVERY_AUDIT_UNSAFE_FILE');
  const bytes=await readFile(location);
  if(bytes.byteLength!==item.size||digest(bytes)!==item.sha256)
   fail('RECOVERY_AUDIT_DIGEST_MISMATCH');
 }
 return {schemaVersion:'alex.dev/recovery-stage-audit/v1',
  status:'staging-copy-verified',fileCount:verified.files,
  byteCount:verified.bytes,readOnly:true,
  productionRestored:false,businessLoadVerified:false,
  rollbackExecuted:false,releaseApproved:false,
  note:'已核对隔离副本与备份逐文件一致；未证明业务启动或真实家庭恢复'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==4){
  console.error('用法: node scripts/recovery-stage-audit.mjs <备份目录> <隔离恢复目录>');
  process.exitCode=2;
 }else{
  try{console.log(JSON.stringify(await auditIsolatedRecovery({
   backupDir:process.argv[2],stageDir:process.argv[3]
  }),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
 }
}
