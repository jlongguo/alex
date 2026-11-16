#!/usr/bin/env node
// R75 隔离恢复演练：把已验证离线备份还原到全新 staging 目录，运行正式 preflight，
// 再启动真实 Alex Node 服务做 loopback health 验收。绝不覆盖生产状态，也不执行生产回滚。
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {lstat,readFile,rename,unlink,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import {verifyOfflineBackup,stageOfflineRestore} from './offline-state-backup.mjs';
import {auditIsolatedRecovery} from './recovery-stage-audit.mjs';
import {inspectReleasePreflight} from './release-preflight.mjs';
import {getLoopbackJson} from './loopback-http.mjs';

export const RECOVERY_DRILL_SCHEMA='alex.dev/recovery-drill/v1';
const SHA=/^[0-9a-f]{40}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const delay=ms=>new Promise(done=>setTimeout(done,ms));

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

const CONFIG_FILES=Object.freeze({
 STATE_FILE:'state.json',AUDIT_FILE:'audit.jsonl',MEMORY_FILE:'memory.json',
 DEVICES_FILE:'devices.json',PROFILES_FILE:'profiles.json',
 LEARNER_CREDENTIALS_FILE:'learner-credentials.json',
 ALEX_LEARNER_PRIVACY_FILE:'learner-privacy.json',
 ALEX_LEARNING_PLANS_FILE:'learning-plans.json',
 GATEWAY_FILE:'gateway.json',
 ALEX_SKILL_GOVERNANCE_FILE:'skill-governance.json',
 ALEX_SKILL_TRUST_FILE:'skill-trust.json',
 ALEX_SKILL_PACKAGES_FILE:'skill-packages.json',
 ALEX_SKILL_TRANSACTIONS_FILE:'skill-transactions.json',
 ALEX_SKILL_BATCH_WAL_FILE:'skill-batch-wal.json',
 ALEX_RELEASE_APPROVAL_FILE:'release-approvals.json',
 ALEX_RELEASE_TRUST_FILE:'release-trust.json',
 ALEX_RELEASE_REVOCATIONS_FILE:'release-revocations.json',
 WORKFLOW_FILE:'workflows.json',PLAN_FILE:'plans.json',
 PROPOSAL_FILE:'proposals.json',ALEX_CONVERSATION_FILE:'conversations.json'
});

async function freePort(){
 const server=createServer();
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const port=server.address().port;
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 return port;
}

function isolatedEnv(stageDir,port){
 return {
  AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r75-isolated-recovery-drill-password',
  ALEX_CHILD_PIN:'885544',
  AGENT_PROVIDER:'rules',
  ALEX_CHAT_PROVIDER:'offline',
  ALEX_CONVERSATION_PERSIST:'1',
  ALEX_AUDIO_PROVIDER:'disabled',
  ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ALEX_SPEECH_PROVIDER_USAGE_FILE:'',
  ALEX_SPEECH_PROVIDER_BILLING_FILE:'',
  ALEX_SPEECH_DELIVERY_LEDGER_FILE:'',
  PORT:String(port),
  ...Object.fromEntries(Object.entries(CONFIG_FILES)
   .map(([key,name])=>[key,join(stageDir,name)]))
 };
}

async function startIsolated(stageDir,port){
 const env=isolatedEnv(stageDir,port);
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:resolve(import.meta.dirname,'..'),
  env:{...process.env,...env},
  stdio:['ignore','ignore','pipe']
 });
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{
  if(stderr.length<2400)stderr+=chunk.slice(0,2400);
 });
 const url='http://127.0.0.1:'+port+'/api/health';
 let lastError=null;
 for(let attempt=0;attempt<160;attempt++){
  if(child.exitCode!==null)
   fail('RECOVERY_DRILL_SERVER_EXITED:'+stderr.replace(/\s+/g,' ').slice(0,800));
  try{
   const health=await getLoopbackJson(url,{timeoutMs:500,maxBytes:64*1024});
   if(object(health))return {child,health};
  }catch(error){lastError=error;}
  await delay(50);
 }
 child.kill('SIGTERM');
 fail('RECOVERY_DRILL_SERVER_NOT_READY:'+String(lastError?.message??'unknown'));
}

async function stopIsolated(child){
 if(!child||child.exitCode!==null)return;
 const exiting=once(child,'exit');
 child.kill('SIGTERM');
 const timeout=delay(8000).then(()=>fail('RECOVERY_DRILL_SERVER_STOP_TIMEOUT'));
 await Promise.race([exiting,timeout]);
 if(child.exitCode!==0)fail('RECOVERY_DRILL_SERVER_STOP_FAILED');
}

async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{
   encoding:'utf8',mode:0o600,flag:'wx'
  });
  await rename(temp,path);
 }finally{
  try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}
 }
}

export async function runRecoveryDrill({
 backupDir,stageDir,commitSha,createdAt=new Date().toISOString()
}={}){
 if(typeof backupDir!=='string'||!backupDir||
  typeof stageDir!=='string'||!stageDir||!SHA.test(commitSha??'')||
  typeof createdAt!=='string'||Number.isNaN(Date.parse(createdAt))||
  new Date(createdAt).toISOString()!==createdAt)
  fail('RECOVERY_DRILL_INPUT_INVALID');

 const backup=await verifyOfflineBackup({directory:backupDir});
 const stageStat=await lstat(resolve(stageDir));
 if(!stageStat.isDirectory()||stageStat.isSymbolicLink())
  fail('RECOVERY_DRILL_STAGE_INVALID');

 const staged=await stageOfflineRestore({directory:backupDir,targetDir:stageDir});
 const stageAudit=await auditIsolatedRecovery({backupDir,stageDir});
 if(stageAudit.status!=='staging-copy-verified')
  fail('RECOVERY_DRILL_STAGE_AUDIT_INVALID');

 const port=await freePort();
 const env=isolatedEnv(resolve(stageDir),port);
 const preflight=await inspectReleasePreflight({
  stateDir:stageDir,backupDir,env
 });
 if(preflight.blocked.length)
  fail('RECOVERY_DRILL_PREFLIGHT_BLOCKED:'+preflight.blocked.join(','));

 let server=null;
 try{
  server=await startIsolated(resolve(stageDir),port);
  await stopIsolated(server.child);
 }catch(error){
  if(server?.child&&server.child.exitCode===null){
   try{await stopIsolated(server.child);}catch{}
  }
  throw error;
 }

 const backupAfter=await verifyOfflineBackup({directory:backupDir});
 if(backupAfter.snapshotId!==backup.snapshotId||
  backupAfter.files!==backup.files||backupAfter.bytes!==backup.bytes)
  fail('RECOVERY_DRILL_BACKUP_CHANGED');

 const base={
  schema:RECOVERY_DRILL_SCHEMA,
  status:'verified',
  commitSha,
  createdAt,
  backup:{
   snapshotId:backup.snapshotId,
   files:backup.files,
   bytes:backup.bytes,
   integrity:'verified-before-and-after'
  },
  staging:{
   restored:true,
   stagingOnly:true,
   productionRestored:false,
   fileCount:staged.files,
   byteCount:staged.bytes,
   audit:stageAudit.status
  },
  preflight:{
   status:preflight.status,
   blocked:[],
   manual:[...preflight.manual]
  },
  businessLoad:{
   serverBooted:true,
   healthEndpointVerified:true,
   cleanShutdown:true,
   externalProvidersDisabled:true
  },
  readOnlyEvidence:true,
  rollbackExecuted:false,
  releaseApproved:false,
  physicalSafetyCertified:false,
  note:'仅证明当前 Commit 可从指定离线备份恢复到隔离 staging 并启动 Alex；未覆盖生产目录，也未执行生产回滚'
 };
 return {...base,evidenceDigestSha256:digest(base)};
}

export function verifyRecoveryDrillEvidence(report,{expectedCommit=null}={}){
 if(!object(report)||report.schema!==RECOVERY_DRILL_SCHEMA||
  report.status!=='verified'||!SHA.test(report.commitSha??'')||
  typeof report.createdAt!=='string'||Number.isNaN(Date.parse(report.createdAt))||
  !object(report.backup)||typeof report.backup.snapshotId!=='string'||
  !Number.isSafeInteger(report.backup.files)||report.backup.files<1||
  !Number.isSafeInteger(report.backup.bytes)||report.backup.bytes<1||
  report.backup.integrity!=='verified-before-and-after'||
  !object(report.staging)||report.staging.restored!==true||
  report.staging.stagingOnly!==true||report.staging.productionRestored!==false||
  report.staging.audit!=='staging-copy-verified'||
  !object(report.preflight)||!Array.isArray(report.preflight.blocked)||
  report.preflight.blocked.length!==0||!Array.isArray(report.preflight.manual)||
  !object(report.businessLoad)||report.businessLoad.serverBooted!==true||
  report.businessLoad.healthEndpointVerified!==true||
  report.businessLoad.cleanShutdown!==true||
  report.businessLoad.externalProvidersDisabled!==true||
  report.readOnlyEvidence!==true||report.rollbackExecuted!==false||
  report.releaseApproved!==false||report.physicalSafetyCertified!==false||
  !HASH.test(report.evidenceDigestSha256??''))
  fail('RECOVERY_DRILL_EVIDENCE_INVALID');
 if(expectedCommit!==null&&report.commitSha!==expectedCommit)
  fail('RECOVERY_DRILL_COMMIT_MISMATCH');
 const {evidenceDigestSha256,...base}=report;
 if(digest(base)!==evidenceDigestSha256)
  fail('RECOVERY_DRILL_DIGEST_MISMATCH');
 return true;
}

async function readReport(path){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>512*1024)
  fail('RECOVERY_DRILL_REPORT_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}

async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='run'){
  if(args.length!==4)
   fail('RECOVERY_DRILL_USAGE: run <backup-dir> <empty-stage-dir> <commit-sha> <report.json>');
  const report=await runRecoveryDrill({
   backupDir:resolve(args[0]),stageDir:resolve(args[1]),commitSha:args[2]
  });
  await atomicWrite(resolve(args[3]),report);
  console.log('RECOVERY_DRILL_VERIFIED:'+report.backup.snapshotId+':'+report.commitSha);
  return;
 }
 if(mode==='verify'){
  if(args.length<1||args.length>2)
   fail('RECOVERY_DRILL_USAGE: verify <report.json> [commit-sha]');
  const report=await readReport(resolve(args[0]));
  verifyRecoveryDrillEvidence(report,{expectedCommit:args[1]??null});
  console.log('RECOVERY_DRILL_EVIDENCE_VERIFIED:'+report.backup.snapshotId+':'+report.commitSha);
  return;
 }
 fail('RECOVERY_DRILL_USAGE: run|verify');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
