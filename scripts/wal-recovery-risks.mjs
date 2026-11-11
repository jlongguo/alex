// R49 只读 WAL 风险扫描：读取元数据，不执行 recover，也不修改已存在的文件。
// 完整哈希链和外部 Skill 信任证明仍由正式事务加载器验证；本模块不会伪称它们通过。
import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const definitions=Object.freeze([
 {id:'single',env:'ALEX_SKILL_TRANSACTIONS_FILE',name:'skill-transactions.json',
  phases:['prepared','committed','blocked'],limit:400},
 {id:'batch',env:'ALEX_SKILL_BATCH_WAL_FILE',name:'skill-batch-wal.json',
  phases:['prepared','committed','abandoned'],limit:400}
]);
const validHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
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
  if(!data||data.schemaVersion!==1||Object.keys(data).sort().join(',')!=='records,schemaVersion'||
   !Array.isArray(data.records)||data.records.length>item.limit){
   checks.push({id:item.id,status:'blocked',records:null,pending:null,
    corrupted:true,readOnly:true});
   continue;
  }
  let valid=true,prev='0'.repeat(64),pending=0;
  const ids=new Set();
  for(const [i,row] of data.records.entries()){
   const op=item.id==='single'?row?.intent?.operationId:row?.operationId;
   const keys=item.id==='single'?'hash,intent,phase,prevHash,requestHash,seq':
    'baseline,expectedPins,hash,operationId,phase,prevHash,proofs,requestHash,seq,targets';
   if(!row||Object.keys(row).sort().join(',')!==keys||
    !item.phases.includes(row.phase)||
    !Number.isSafeInteger(row.seq)||row.seq!==i+1||
    typeof op!=='string'||!/^[A-Za-z0-9._:-]{8,100}$/.test(op)||ids.has(op)||
    !validHash(row.prevHash)||row.prevHash!==prev||
    !validHash(row.hash)||!validHash(row.requestHash)){
    valid=false;break;
   }
   ids.add(op);prev=row.hash;
   if(row.phase==='prepared')pending++;
  }
  checks.push({id:item.id,
   status:!valid?'blocked':pending?'manual-review-required':'pass',
   records:data.records.length,pending:valid?pending:null,
   corrupted:!valid,readOnly:true});
 }
 return {schemaVersion:'alex.dev/wal-risk-scan/v1',checks,
  blocked:checks.filter(x=>x.status==='blocked').map(x=>x.id),
  pending:checks.filter(x=>x.status==='manual-review-required').map(x=>x.id),
  readOnly:true,recoveryExecuted:false,hashChainCryptographicallyVerified:false,
  approvedForUpgrade:false,
  note:'此扫描核对结构与前序摘要格式，不替代原事务引擎的完整哈希及信任链验证'};
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
