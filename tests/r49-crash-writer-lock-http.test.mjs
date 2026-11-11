import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';
import {inspectWriterLease} from '../scripts/inspect-writer-lease.mjs';

const cwd=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const files={
 STATE_FILE:'state.json',MEMORY_FILE:'memory.json',AUDIT_FILE:'audit.jsonl',
 PROFILES_FILE:'profiles.json',DEVICES_FILE:'devices.json',
 LEARNER_CREDENTIALS_FILE:'learner-credentials.json',
 ALEX_LEARNER_PRIVACY_FILE:'learner-privacy.json',
 ALEX_LEARNING_PLANS_FILE:'learning-plans.json',
 GATEWAY_FILE:'gateway.json',WORKFLOW_FILE:'workflows.json',
 PLAN_FILE:'plans.json',PROPOSAL_FILE:'proposals.json',
 ALEX_CONVERSATION_FILE:'conversations.json',
 ALEX_SKILL_GOVERNANCE_FILE:'skill-governance.json',
 ALEX_SKILL_TRUST_FILE:'skill-trust.json',
 ALEX_SKILL_PACKAGES_FILE:'skill-packages.json',
 ALEX_SKILL_TRANSACTIONS_FILE:'skill-transactions.json',
 ALEX_SKILL_BATCH_WAL_FILE:'skill-batch-wal.json'
};
async function createProcess(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd,env:{...process.env,...env},stdio:['ignore','ignore','pipe']
 });
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',part=>{if(stderr.length<1500)stderr+=part.slice(0,1500);});
 return {child,getError:()=>stderr};
}
async function waitForReady(child,port){
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('R49_SERVER_EXIT_EARLY');
  try{
   const response=await fetch('http://127.0.0.1:'+port+'/api/health');
   if(response.ok)return;
  }catch{}
  await sleep(50);
 }
 throw Error('R49_SERVER_NOT_READY');
}
async function killSpawnedProcess(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 const done=once(child,'exit');
 child.kill('SIGKILL');
 await done;
}
test('R49 仅测试子进程模拟异常退出：写者锁必须保留，二次启动拒绝接管',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r49-crash-'));
 const port=59000+Math.floor(Math.random()*2000);
 const env={
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r49-only-test-parent-password',
  ALEX_CHILD_PIN:'778866',PORT:String(port),
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ...Object.fromEntries(Object.entries(files).map(([key,file])=>[key,join(dir,file)]))
 };
 const lock=join(dir,'.alex-writer.lock');
 let first,second;
 try{
  first=await createProcess(env);
  await waitForReady(first.child,port);
  const owner=JSON.parse(await readFile(lock,'utf8'));
  assert.equal(owner.pid,first.child.pid);
  const logged=await fetch('http://127.0.0.1:'+port+'/api/auth/login',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({role:'parent',secret:env.ALEX_PARENT_PASSWORD})
  });
  assert.equal(logged.status,200);
  await killSpawnedProcess(first.child);
  const persisted=await readFile(lock,'utf8');
  assert.equal(JSON.parse(persisted).nonce,owner.nonce);
  const inspected=await inspectWriterLease(lock);
  assert.equal(inspected.status,'present');
  assert.equal(inspected.safeToStart,false);
  assert.equal(inspected.manualReview,true);
  const preflight=await inspectReleasePreflight({stateDir:dir,env});
  assert.ok(preflight.blocked.includes('SERVER_STOPPED'));
  second=await createProcess(env);
  const done=once(second.child,'exit');
  const result=await Promise.race([
   done, sleep(8000).then(()=>{throw Error('R49_SECOND_INSTANCE_NOT_REJECTED');})
  ]);
  assert.notEqual(result[0],0,'遗留写者锁必须拒绝第二实例接管');
  assert.match(second.getError(),/ALEX_INSTANCE_ALREADY_RUNNING/);
  assert.equal(await readFile(lock,'utf8'),persisted);
 }finally{
  // 仅销毁由本测试创建的两个子进程与临时目录，不清理用户目录中的锁。
  await killSpawnedProcess(second?.child);
  await killSpawnedProcess(first?.child);
  await rm(dir,{recursive:true,force:true});
 }
});
