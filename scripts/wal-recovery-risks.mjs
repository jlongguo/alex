// R49 只读 WAL 风险扫描：读取元数据，不执行 recover，也不修改已存在的文件。
// 精确复核已有事务格式的 SHA-256 哈希链；外部 Skill 签名、Registry 状态仍由正式加载器验证。
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonicalJson} from './skill-package-trust.mjs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const definitions=Object.freeze([
 {id:'single',env:'ALEX_SKILL_TRANSACTIONS_FILE',name:'skill-transactions.json',
  phases:['prepared','committed','blocked'],limit:400},
 {id:'batch',env:'ALEX_SKILL_BATCH_WAL_FILE',name:'skill-batch-wal.json',
  phases:['prepared','committed','abandoned'],limit:400}
]);
const validHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

const sha=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const pin=p=>p&&Object.keys(p).sort().join(',')==='id,version'&&
 typeof p.id==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(p.id)&&
 typeof p.version==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(p.version);
const uniquePins=rows=>Array.isArray(rows)&&rows.every(pin)&&
 new Set(rows.map(p=>p.id)).size===rows.length;
const safeVersion=v=>v===null||typeof v==='string'&&
 /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
const singleIntent=intent=>intent&&
 Object.keys(intent).sort().join(',')===
 'artifactSha256,expectedCurrentVersion,id,manifestSha256,operationId,publisherId,version'&&
 pin({id:intent.id,version:intent.version})&&safeVersion(intent.expectedCurrentVersion)&&
 typeof intent.publisherId==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(intent.publisherId)&&
 validHash(intent.manifestSha256)&&validHash(intent.artifactSha256);
function completeHash(item,row){
 if(item.id==='single'){
  if(!singleIntent(row.intent)||row.requestHash!==sha(row.intent))return false;
  return row.hash===sha({seq:row.seq,phase:row.phase,intent:row.intent,
   requestHash:row.requestHash,prevHash:row.prevHash});
 }
 if(!uniquePins(row.targets)||row.targets.length<1||row.targets.length>12||
  !uniquePins(row.expectedPins)||row.expectedPins.length>100||
  !Array.isArray(row.proofs)||row.proofs.length!==row.targets.length||
  row.proofs.some(p=>!p||Object.keys(p).sort().join(',')!==
   'artifactSha256,id,manifestSha256,publisherId,version'||
   !pin({id:p.id,version:p.version})||!validHash(p.artifactSha256)||
   !validHash(p.manifestSha256)||typeof p.publisherId!=='string')||
  !row.baseline||Object.keys(row.baseline).sort().join(',')!==
  'historyHash,historyLength,snapshotHash'||
  !Number.isSafeInteger(row.baseline.historyLength)||row.baseline.historyLength<0||
  !validHash(row.baseline.historyHash)||!validHash(row.baseline.snapshotHash)||
  row.requestHash!==sha({targets:row.targets,expectedPins:row.expectedPins}))
  return false;
 return row.hash===sha({seq:row.seq,phase:row.phase,operationId:row.operationId,
  requestHash:row.requestHash,targets:row.targets,expectedPins:row.expectedPins,
  proofs:row.proofs,baseline:row.baseline,prevHash:row.prevHash});
}

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
   let good=false;
   try{
    good=!!row&&Object.keys(row).sort().join(',')===keys&&
     item.phases.includes(row.phase)&&Number.isSafeInteger(row.seq)&&row.seq===i+1&&
     typeof op==='string'&&/^[A-Za-z0-9._:-]{8,100}$/.test(op)&&!ids.has(op)&&
     validHash(row.prevHash)&&row.prevHash===prev&&
     validHash(row.hash)&&validHash(row.requestHash)&&completeHash(item,row);
   }catch(error){
    // 不可信 WAL 输入导致 canonicalJson 失败也必须阻断，而不能跳过该行。
    if(!(error instanceof Error))throw error;
   }
   if(!good){
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
