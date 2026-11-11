// R49 只读 WAL 风险扫描：读取元数据，不执行 recover，也不修改已存在的文件。
// 复用事务引擎的规范化 SHA-256 校验；外部签名和 Registry 状态仍需启动加载器验证。
import {lstat,readFile} from 'node:fs/promises';
import {inspectSkillPackageWalState} from './skill-package-transactions.mjs';
import {inspectSkillBatchWalState} from './skill-batch-transactions.mjs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const definitions=Object.freeze([
 {id:'single',env:'ALEX_SKILL_TRANSACTIONS_FILE',name:'skill-transactions.json',
  phases:['prepared','committed','blocked'],limit:400},
 {id:'batch',env:'ALEX_SKILL_BATCH_WAL_FILE',name:'skill-batch-wal.json',
  phases:['prepared','committed','abandoned'],limit:400}
]);
export async function inspectWalRecoveryRisks({stateDir='.local',env=process.env}={}){
 if(typeof stateDir!=='string'||!stateDir)throw Error('INVALID_WAL_INSPECTION_DIRECTORY');
 const root=resolve(stateDir),checks=[];
 for(const item of definitions){
  const path=resolve(env[item.env]||join(root,item.name));
  let stat;
  try{stat=await lstat(path);}
  catch(error){
   if(error?.code!=='ENOENT')throw error;
   checks.push({id:item.id,status:'absent',records:0,pending:0,
    corrupted:false,readOnly:true});
   continue;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024){
   checks.push({id:item.id,status:'blocked',records:null,pending:null,
    corrupted:true,readOnly:true});
   continue;
  }
  let data;
  try{data=JSON.parse(await readFile(path,'utf8'));}
  catch{
   checks.push({id:item.id,status:'blocked',records:null,pending:null,
    corrupted:true,readOnly:true});
   continue;
  }
  // 原事务模块严格校验 schema、哈希链、请求摘要和每条业务证明。
  // 预检在内存中调用相同校验器，不进行 recover 或文件修改。
  let result=null;
  try{
   result=item.id==='single'
    ?inspectSkillPackageWalState(data):inspectSkillBatchWalState(data);
  }catch(error){
   if(!(error instanceof Error))throw error;
  }
  const valid=result!==null;
  const pending=result?.pending??null;
  checks.push({id:item.id,
   status:!valid?'blocked':pending?'manual-review-required':'pass',
   records:valid?result.records:null,pending,
   corrupted:!valid,readOnly:true});
 }
 return {schemaVersion:'alex.dev/wal-risk-scan/v1',checks,
  blocked:checks.filter(x=>x.status==='blocked').map(x=>x.id),
  pending:checks.filter(x=>x.status==='manual-review-required').map(x=>x.id),
  readOnly:true,recoveryExecuted:false,
  hashChainCryptographicallyVerified:checks.every(c=>!c.corrupted),
  verifiedJournalCount:checks.filter(c=>c.status!=='absent'&&!c.corrupted).length,
  approvedForUpgrade:false,
  note:'只对存在且无结构错误的 WAL 确认规范化 SHA-256 链；尚未验证 Registry 状态、签名与恢复执行'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length>3){console.error('用法: node scripts/wal-recovery-risks.mjs [状态目录]');process.exitCode=2;}
 else{
  try{
   const report=await inspectWalRecoveryRisks({stateDir:process.argv[2]??'.local'});
   console.log(JSON.stringify(report,null,2));
   if(report.blocked.length||report.pending.length)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=2;}
 }
}
