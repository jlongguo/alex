import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
 createOfflineBackup,verifyOfflineBackup,planOfflineRestore,stageOfflineRestore
} from '../scripts/offline-state-backup.mjs';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';
import {auditIsolatedRecovery} from '../scripts/recovery-stage-audit.mjs';

const cwd=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const configFiles={
 STATE_FILE:'state.json',AUDIT_FILE:'audit.jsonl',
 MEMORY_FILE:'memory.json',DEVICES_FILE:'devices.json',
 PROFILES_FILE:'profiles.json',LEARNER_CREDENTIALS_FILE:'learner-credentials.json',
 ALEX_LEARNER_PRIVACY_FILE:'learner-privacy.json',
 ALEX_LEARNING_PLANS_FILE:'learning-plans.json',
 GATEWAY_FILE:'gateway.json',ALEX_SKILL_GOVERNANCE_FILE:'skill-governance.json',
 ALEX_SKILL_TRUST_FILE:'skill-trust.json',
 ALEX_SKILL_PACKAGES_FILE:'skill-packages.json',
 ALEX_SKILL_TRANSACTIONS_FILE:'skill-transactions.json',
 ALEX_SKILL_BATCH_WAL_FILE:'skill-batch-wal.json',
 WORKFLOW_FILE:'workflows.json',PLAN_FILE:'plans.json',
 PROPOSAL_FILE:'proposals.json',ALEX_CONVERSATION_FILE:'conversations.json'
};
const baseEnv={
 AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r48-isolated-test-parent-password',
 ALEX_CHILD_PIN:'885544',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
 ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
 ALEX_SPEECH_STREAM_PROVIDER:'disabled',
 ALEX_SPEECH_PROVIDER_USAGE_FILE:'',ALEX_SPEECH_PROVIDER_BILLING_FILE:'',
 ALEX_SPEECH_DELIVERY_LEDGER_FILE:''
};
const envFor=(dir,port)=>({
 ...baseEnv,PORT:String(port),
 ...Object.fromEntries(Object.entries(configFiles).map(([key,name])=>[key,join(dir,name)]))
});
async function start(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd,env:{...process.env,...env},stdio:['ignore','ignore','pipe']
 });
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{if(stderr.length<3000)stderr+=chunk.slice(0,3000);});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<160;i++){
  if(child.exitCode!==null)throw Error('R48_RESTORED_SERVER_EXIT:'+stderr);
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(50);
 }
 child.kill('SIGTERM');throw Error('R48_SERVER_TIMEOUT:'+stderr);
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const done=once(server.child,'exit');
 server.child.kill('SIGTERM');
 await done;
 assert.equal(server.child.exitCode,0,'模拟服务必须正常停止并释放写者锁');
}
async function http(base,path,{cookie,data}={}){
 const res=await fetch(base+path,{method:data?'POST':'GET',
  headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
  ...(data?{body:JSON.stringify(data)}:{})});
 return {status:res.status,data:await res.json().catch(()=>({})),
  cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
const getCookie=async(base,role,secret,code)=>{
 const response=await http(base,'/api/auth/login',{data:{role,secret,...(code?{code}:{})}});
 assert.equal(response.status,200,JSON.stringify(response.data));
 return response.cookie;
};
async function digestState(dir){
 const names=(await readdir(dir)).filter(name=>name.endsWith('.json')||name.endsWith('.jsonl')).sort();
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 return Object.fromEntries(await Promise.all(names.map(async name=>[name,sha(await readFile(join(dir,name)))])));
}

test('R48 真实 Node 家庭恢复演练：家长/双儿童身份、对话、课程和隐私在隔离副本重启后保持',{timeout:75000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'alex-r48-recovery-'));
 const source=join(root,'source'),backup=join(root,'backup'),stage=join(root,'stage');
 await mkdir(source);await mkdir(stage);
 let live=null,restored=null;
 try{
  const firstEnv=envFor(source,56000+Math.floor(Math.random()*1000));
  live=await start(firstEnv);
  const parent=await getCookie(live.base,'parent',firstEnv.ALEX_PARENT_PASSWORD);
  const profiles=[];
  for(const nickname of ['孩子甲','孩子乙']){
   const p=await http(live.base,'/api/profiles',{cookie:parent,data:{
    nickname,ageBand:'6-8',interests:[]}});
   assert.equal(p.status,200,JSON.stringify(p.data));
   profiles.push(p.data.profile.id);
  }
  const codes=[];
  for(const [i,id] of profiles.entries()){
   const pin=String(621300+i);
   const credential=await http(live.base,'/api/learners/set-pin',{
    cookie:parent,data:{profileId:id,pin}});
   assert.equal(credential.status,200,JSON.stringify(credential.data));
   codes.push({code:credential.data.learner.code,pin});
   const privacy=await http(live.base,'/api/learner/privacy',{
    cookie:parent,data:{profileId:id,preferences:{
     voiceInputAllowed:false,voiceOutputAllowed:false,cloudTextAllowed:false,
     cloudAudioInputAllowed:false,cloudAudioOutputAllowed:false,
     preferredLanguage:'bilingual',learningPace:'slow',topics:[]}}});
   assert.equal(privacy.status,200,JSON.stringify(privacy.data));
  }
  const assign=await http(live.base,'/api/learning/assign',{cookie:parent,
   data:{profileId:profiles[0],courseId:'english.a1.greetings',targetCompletions:2}});
  assert.equal(assign.status,200,JSON.stringify(assign.data));
  const learner=await getCookie(live.base,'learner',codes[0].pin,codes[0].code);
  const opened=await http(live.base,'/api/companion/open',{cookie:learner,
   data:{mode:'english',lessonId:'english.a1.greetings'}});
  assert.equal(opened.status,200,JSON.stringify(opened.data));
  const turn=await http(live.base,'/api/companion/turn',{cookie:learner,
   data:{id:opened.data.session.id,text:'Hello, Alex!'}});
  assert.equal(turn.status,200,JSON.stringify(turn.data));
  const before=await http(live.base,'/api/learning/journey',{cookie:learner});
  assert.equal(before.status,200);
  assert.equal(before.data.report.recentSessionId,opened.data.session.id);
  await stop(live);live=null;

  const original=await digestState(source);
  const created=await createOfflineBackup({sourceDir:source,destinationDir:backup});
  assert.equal(created.verified.status,'verified');
  assert.equal((await verifyOfflineBackup({directory:backup})).status,'verified');
  const planned=await planOfflineRestore({directory:backup,targetDir:stage});
  assert.equal(planned.eligibleForManualRestore,true);
  const staged=await stageOfflineRestore({directory:backup,targetDir:stage});
  assert.equal(staged.status,'staged');
  assert.equal(staged.productionRestored,false);
  const audited=await auditIsolatedRecovery({backupDir:backup,stageDir:stage});
  assert.equal(audited.status,'staging-copy-verified');
  assert.equal(audited.businessLoadVerified,false);
  assert.equal(audited.releaseApproved,false);
  assert.deepEqual(await digestState(source),original);
  assert.deepEqual(await digestState(stage),original);

  const secondEnv=envFor(stage,57000+Math.floor(Math.random()*1000));
  const preflight=await inspectReleasePreflight({
   stateDir:stage,backupDir:backup,env:secondEnv
  });
  assert.deepEqual(preflight.blocked,[],JSON.stringify(preflight.blocked));
  assert.equal(preflight.releaseApproved,false);
  assert.ok(preflight.manual.includes('REAL_USER_ACCEPTANCE'));
  restored=await start(secondEnv);
  const parentRestored=await getCookie(restored.base,'parent',secondEnv.ALEX_PARENT_PASSWORD);
  const childA=await getCookie(restored.base,'learner',codes[0].pin,codes[0].code);
  const childB=await getCookie(restored.base,'learner',codes[1].pin,codes[1].code);
  const restoredJourney=await http(restored.base,'/api/learning/journey',{cookie:childA});
  assert.equal(restoredJourney.status,200,JSON.stringify(restoredJourney.data));
  assert.equal(restoredJourney.data.report.recentSessionId,opened.data.session.id);
  assert.equal(restoredJourney.data.report.plans[0].courseId,'english.a1.greetings');
  const previous=await http(restored.base,
   '/api/companion/session?id='+encodeURIComponent(opened.data.session.id),{cookie:childA});
  assert.equal(previous.status,200,JSON.stringify(previous.data));
  assert.ok(previous.data.session.messages.some(m=>m.text==='Hello, Alex!'));
  const denied=await http(restored.base,
   '/api/companion/session?id='+encodeURIComponent(opened.data.session.id),{cookie:childB});
  assert.notEqual(denied.status,200);
  assert.deepEqual((await http(restored.base,'/api/learning/journey',{cookie:childB}))
   .data.report.sessions,[]);
  assert.equal((await http(restored.base,'/api/learner/privacy?profileId='+profiles[0],
   {cookie:childA})).status,403);
  const p=await http(restored.base,'/api/learner/privacy?profileId='+profiles[0],
   {cookie:parentRestored});
  assert.equal(p.status,200);
  assert.equal(p.data.preferences.cloudTextAllowed,false);
  const dispatch=await http(restored.base,'/api/gateway/dispatch',{cookie:childA,
   data:{deviceId:'dev-11111111-1111-4111-8111-111111111111',
    capability:'sim.navigation.goto',params:{destination:'study_desk'},requestId:'r48isolated1'}});
  assert.notEqual(dispatch.status,200);
  await stop(restored);restored=null;
  assert.deepEqual(await digestState(source),original,'隔离重启不得修改源家庭状态');
 }finally{
  await stop(restored);await stop(live);
  await rm(root,{recursive:true,force:true});
 }
});

test('R48 损坏的备份不得还原到隔离目录，更不能启动为已验证恢复',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'alex-r48-corrupt-'));
 const source=join(root,'source'),backup=join(root,'backup'),stage=join(root,'stage');
 await mkdir(source);await mkdir(stage);
 try{
  const {writeFile}=await import('node:fs/promises');
  await writeFile(join(source,'profiles.json'),'{"version":1,"profiles":[]}');
  await createOfflineBackup({sourceDir:source,destinationDir:backup});
  await writeFile(join(backup,'profiles.json'),'{"version":1,"profiles":[{"id":"corrupt"}]}');
  await assert.rejects(stageOfflineRestore({directory:backup,targetDir:stage}),
   /ALEX_BACKUP_FILE_MISMATCH/);
  assert.deepEqual(await readdir(stage),[]);
  assert.equal((await inspectReleasePreflight({
   stateDir:source,backupDir:backup,env:envFor(source,58001)
  })).blocked.includes('BACKUP_INTEGRITY'),true);
 }finally{await rm(root,{recursive:true,force:true});}
});
