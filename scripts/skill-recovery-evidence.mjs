// R52：只读检查 prepared WAL 的签名来源与 Registry 关联关系。
// 有效证明只意味着可进入人工恢复演练，绝不代表事务会自动执行或升级获批。
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectWalRecoveryRisks} from './wal-recovery-risks.mjs';
import {inspectSkillStateCompatibility} from './skill-state-compat.mjs';
import {SkillPackageRegistry} from './skill-package-registry.mjs';
import {SkillPackageTrust} from './skill-package-trust.mjs';
import {SkillPackageTransactions} from './skill-package-transactions.mjs';
import {SkillBatchTransactions} from './skill-batch-transactions.mjs';

const pathFor=(root,env,key,name)=>resolve(env[key]||join(root,name));
const sameEvidence=(expected,actual)=>expected.publisherId===actual.publisherId&&
 expected.manifestSha256===actual.manifestSha256&&
 expected.artifactSha256===actual.artifactSha256;
export async function inspectSkillRecoveryEvidence({stateDir='.local',env=process.env}={}){
 if(typeof stateDir!=='string'||!stateDir)throw Error('INVALID_RECOVERY_EVIDENCE_DIRECTORY');
 const root=resolve(stateDir);
 const wal=await inspectWalRecoveryRisks({stateDir:root,env});
 const compat=await inspectSkillStateCompatibility({stateDir:root,env});
 if(wal.blocked.length||compat.blocked.length){
  return {schemaVersion:'alex.dev/skill-recovery-evidence/v1',
   status:'blocked',pending:0,proofChecked:0,proofRejected:0,
   blockers:['WAL_OR_SKILL_STATE_INVALID'],readOnly:true,
   replayExecuted:false,recoveryApproved:false,releaseApproved:false};
 }
 const registry=new SkillPackageRegistry({file:pathFor(root,env,
  'ALEX_SKILL_PACKAGES_FILE','skill-packages.json')});
 const trust=new SkillPackageTrust({file:pathFor(root,env,
  'ALEX_SKILL_TRUST_FILE','skill-trust.json')});
 await registry.load();await trust.load();
 const single=new SkillPackageTransactions({
  file:pathFor(root,env,'ALEX_SKILL_TRANSACTIONS_FILE','skill-transactions.json'),
  registry,trust});
 const batch=new SkillBatchTransactions({
  file:pathFor(root,env,'ALEX_SKILL_BATCH_WAL_FILE','skill-batch-wal.json'),
  registry,trust});
 await single.load();await batch.load();
 const catalog=registry.list('parent').packages;
 const checks=[];
 const verify=(id,version,evidence,approved)=>{
  const entry=catalog.find(p=>p.manifest.id===id&&p.manifest.version===version);
  if(!entry||approved&&entry.status!=='approved')return false;
  try{return sameEvidence(evidence,trust.assertTrusted(entry.manifest));}
  catch(error){
   if(!(error instanceof Error))throw error;
   return false;
  }
 };
 for(const row of single.list('parent').records.filter(r=>r.phase==='prepared')){
  checks.push(verify(row.intent.id,row.intent.version,row.intent,false));
 }
 for(const row of batch.list('parent').records.filter(r=>r.phase==='prepared')){
  // 同一 WAL 内各目标的证明必须与原 Registry 的已审批清单匹配。
  checks.push(row.proofs.length===row.targets.length&&row.proofs.every(proof=>
   verify(proof.id,proof.version,proof,true)));
 }
 const rejected=checks.filter(ok=>!ok).length;
 const count=checks.length;
 return {schemaVersion:'alex.dev/skill-recovery-evidence/v1',
  status:rejected?'blocked':count?'manual-review-required':'pass',
  pending:count,proofChecked:count,proofRejected:rejected,
  blockers:rejected?['PENDING_PROVENANCE_INVALID']:[],
  readOnly:true,replayExecuted:false,recoveryApproved:false,releaseApproved:false,
  note:'已复核 prepared WAL 的签名与已保存 Manifest；没有执行事务、冲突解决或实际恢复'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length>3){
  console.error('用法: node scripts/skill-recovery-evidence.mjs [状态目录]');
  process.exitCode=2;
 }else{
  try{
   const result=await inspectSkillRecoveryEvidence({stateDir:process.argv[2]??'.local'});
   console.log(JSON.stringify(result,null,2));
   if(result.status==='blocked'||result.pending)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=2;}
 }
}
