import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {evaluateReleaseReadiness} from '../scripts/release-readiness.mjs';
import {composeReleaseReadinessMatrix} from '../scripts/release-readiness-matrix.mjs';
import {createCiEvidence} from '../scripts/ci-evidence.mjs';
import {createReleaseCandidate} from '../scripts/release-candidate-manifest.mjs';

const cwd=resolve(import.meta.dirname,'..');
const SHA='0123456789abcdef0123456789abcdef01234567';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const matrix=()=>composeReleaseReadinessMatrix({
 staticReadiness:evaluateReleaseReadiness({
  authMode:'local',childLoginEnabled:true,profileCount:1,
  skillReconciliation:{status:'consistent',findings:[]},
  singleWal:{pending:0,remaining:400},batchWal:{pending:0,remaining:400},
  audioConfigured:true,conversationProvider:'offline',writerLockHeld:true
 }),
 runtimeGate:{
  schema:'alex.dev/runtime-acceptance-gate/v1',read_only:true,
  status:'manual-review-required',
  ros_runtime:'not_run',
  voice_real_provider:'verified-by-set',
  voice_workflow_evidence:'verified-by-set',
  voice_artifact_attestation:'verified-by-set',
  voice_evidence_set:'verified-coherent',
  voice_github_readback:'verified-by-set',
  acoustic_io:'verified-by-set',
  acoustic_artifact_attestation:'verified-by-set',
  acoustic_evidence_set:'verified-coherent',
  acoustic_github_readback:'verified-by-set',
 full_voice_turn:'verified-by-set',
 full_voice_turn_artifact_attestation:'verified-by-set',
 full_voice_turn_evidence_set:'verified-coherent',
 full_voice_turn_github_readback:'verified-by-set',
  full_voice_turn:'verified-by-set',
  full_voice_turn_artifact_attestation:'verified-by-set',
  full_voice_turn_evidence_set:'verified-coherent',
  full_voice_turn_github_readback:'verified-by-set',
  nav2_fault_contract:'not_run',
  ros_cancel_runtime:'not_run',ros_recovery_runtime:'not_run',
  ros_bridge_runtime:'not_run',ros_workflow_bundle:'not_run',
  ros_artifact_attestation:'not_run',ros_evidence_set:'not_run',
  ros_github_readback:'not_run',ros_runner_provenance:'not_run',
  physical_safety_certified:false,release_approved:false,
  subjects:{voice:{run_id:'987654321',attempt:2,commit_sha:SHA},ros:null,
   acoustic:{run_id:'8877665544',attempt:1,commit_sha:SHA},
   full_voice_turn:{run_id:'9988776655',attempt:1,commit_sha:SHA}},
  remaining:[
   'GAZEBO_NAV2_THREE_LEG_RUNTIME','GAZEBO_NAV2_CANCEL_RUNTIME',
   'GAZEBO_NAV2_RECOVERY_RUNTIME','GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME',
   'GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE','GAZEBO_ACTIONS_ARTIFACT_ATTESTATION',
   'GAZEBO_ROS_COHERENT_EVIDENCE_SET','GAZEBO_GITHUB_ACTIONS_READBACK_AUDIT',
   'GAZEBO_RUNNER_ENVIRONMENT_PROVENANCE','PHYSICAL_SAFETY_REVIEW'
  ]
 },
 ciEvidence:createCiEvidence({
  GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',
  GITHUB_REPOSITORY:'jlongguo/alex',GITHUB_JOB:'evidence-summary',
  RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
  GITHUB_RUN_ID:'43759975148',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:SHA,
  ALEX_CI_TEST_RESULT:'success',ALEX_CI_BROWSER_RESULT:'success',
  ALEX_CI_SIM_STATIC_RESULT:'success'
 })
});
const candidateAt=createdAt=>createReleaseCandidate(matrix(),{
 createdAt,
 sourceEvidence:{
  staticDigestSha256:'a'.repeat(64),
  runtimeDigestSha256:'b'.repeat(64),
  ciDigestSha256:'c'.repeat(64)
 }
});

async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd,env:{...process.env,...env},stdio:['ignore','ignore','pipe']
 });
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{if(stderr.length<5000)stderr+=chunk;});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('R72_SERVER_EXITED:'+stderr);
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(60);
 }
 child.kill('SIGTERM');throw Error('R72_SERVER_TIMEOUT:'+stderr);
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const done=once(server.child,'exit');
 server.child.kill('SIGTERM');await done;
}
async function req(base,path,{cookie,data}={}){
 const response=await fetch(base+path,{
  method:data?'POST':'GET',
  headers:{
   ...(cookie?{Cookie:cookie}:{}),
   ...(data?{'Content-Type':'application/json'}:{})
  },
  ...(data?{body:JSON.stringify(data)}:{})
 });
 return {
  status:response.status,
  body:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]
 };
}
function envFor(dir,candidateFile){
 return {
  PORT:String(50000+Math.floor(Math.random()*5000)),
  AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r72-parent-password-long',
  ALEX_CHILD_PIN:'782244',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
  MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'governance.json'),
  ALEX_SKILL_TRUST_FILE:join(dir,'trust.json'),
  ALEX_SKILL_PACKAGES_FILE:join(dir,'packages.json'),
  ALEX_SKILL_TRANSACTIONS_FILE:join(dir,'transactions.json'),
  ALEX_SKILL_BATCH_WAL_FILE:join(dir,'batch-wal.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  GATEWAY_FILE:join(dir,'gateway.json'),PROPOSAL_FILE:join(dir,'proposals.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  ALEX_RELEASE_CANDIDATE_FILE:candidateFile,
  ALEX_RELEASE_APPROVAL_FILE:join(dir,'release-approvals.json')
 };
}

test('R72 真实 HTTP：只有本地家长可审批固定候选，候选变化后旧批准立即失效',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r72-http-'));
 const candidateFile=join(dir,'candidate.json');
 const first=candidateAt('2026-11-16T00:00:00.000Z');
 await writeFile(candidateFile,JSON.stringify(first));
 const env=envFor(dir,candidateFile);
 let server;
 try{
  server=await boot(env);
  const parentLogin=await req(server.base,'/api/auth/login',{data:{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD
  }});
  const childLogin=await req(server.base,'/api/auth/login',{data:{
   role:'child',secret:env.ALEX_CHILD_PIN
  }});
  assert.equal(parentLogin.status,200,JSON.stringify(parentLogin.body));
  assert.equal(childLogin.status,200,JSON.stringify(childLogin.body));
  const parent=parentLogin.cookie,child=childLogin.cookie;

  assert.equal((await req(server.base,'/api/release/candidate')).status,401);
  assert.equal((await req(server.base,'/api/release/candidate',{cookie:child})).status,403);
  let state=await req(server.base,'/api/release/candidate',{cookie:parent});
  assert.equal(state.status,200,JSON.stringify(state.body));
  assert.equal(state.body.status,'pending-review');
  assert.equal(state.body.releaseApproved,false);
  assert.equal(state.body.deployExecuted,false);
  assert.equal(state.body.candidate.candidateId,first.candidateId);

  assert.equal((await req(server.base,'/api/release/candidate/decision',{
   cookie:child,data:{
    action:'approved',candidateId:first.candidateId,
    candidateDigestSha256:first.candidateDigestSha256,
    acknowledgements:first.requiredHumanChecks,requestId:'request_child_http_1'
   }
  })).status,403);

  const incomplete=await req(server.base,'/api/release/candidate/decision',{
   cookie:parent,data:{
    action:'approved',candidateId:first.candidateId,
    candidateDigestSha256:first.candidateDigestSha256,
    acknowledgements:['realChildJourney'],requestId:'request_parent_http_1'
   }
  });
  assert.equal(incomplete.status,409,JSON.stringify(incomplete.body));
  assert.equal(incomplete.body.error,'RELEASE_APPROVAL_HUMAN_CHECKS_INCOMPLETE');

  const approved=await req(server.base,'/api/release/candidate/decision',{
   cookie:parent,data:{
    action:'approved',candidateId:first.candidateId,
    candidateDigestSha256:first.candidateDigestSha256,
    acknowledgements:first.requiredHumanChecks,requestId:'request_parent_http_2'
   }
  });
  assert.equal(approved.status,200,JSON.stringify(approved.body));
  assert.equal(approved.body.releaseApproved,true);
  assert.equal(approved.body.deployExecuted,false);
  assert.equal(approved.body.physicalSafetyCertified,false);

  state=await req(server.base,'/api/release/candidate',{cookie:parent});
  assert.equal(state.body.status,'approved');
  assert.equal(state.body.releaseApproved,true);

  const second=candidateAt('2026-11-16T00:01:00.000Z');
  await writeFile(candidateFile,JSON.stringify(second));
  state=await req(server.base,'/api/release/candidate',{cookie:parent});
  assert.equal(state.body.status,'pending-review');
  assert.equal(state.body.releaseApproved,false);
  assert.equal(state.body.candidate.candidateId,second.candidateId);

  const stale=await req(server.base,'/api/release/candidate/decision',{
   cookie:parent,data:{
    action:'approved',candidateId:first.candidateId,
    candidateDigestSha256:first.candidateDigestSha256,
    acknowledgements:first.requiredHumanChecks,requestId:'request_stale_http_1'
   }
  });
  assert.equal(stale.status,409,JSON.stringify(stale.body));
  assert.equal(stale.body.error,'RELEASE_CANDIDATE_CHANGED');

  const rejected=await req(server.base,'/api/release/candidate/decision',{
   cookie:parent,data:{
    action:'rejected',candidateId:second.candidateId,
    candidateDigestSha256:second.candidateDigestSha256,
    acknowledgements:[],requestId:'request_parent_http_3'
   }
  });
  assert.equal(rejected.status,200,JSON.stringify(rejected.body));
  assert.equal(rejected.body.status,'rejected');
  assert.equal(rejected.body.releaseApproved,false);

  const audit=await readFile(env.AUDIT_FILE,'utf8');
  assert.match(audit,/release\.candidate\.approved/);
  assert.match(audit,/release\.candidate\.rejected/);
  assert.equal(audit.includes(first.candidateDigestSha256),false);

  await stop(server);server=null;
  server=await boot(env);
  const relogin=await req(server.base,'/api/auth/login',{data:{
   role:'parent',secret:env.ALEX_PARENT_PASSWORD
  }});
  state=await req(server.base,'/api/release/candidate',{cookie:relogin.cookie});
  assert.equal(state.status,200,JSON.stringify(state.body));
  assert.equal(state.body.status,'rejected');
  assert.equal(state.body.releaseApproved,false);
 }finally{
  await stop(server);
  await rm(dir,{recursive:true,force:true});
 }
});

test('R72 前端审批必须显式逐项确认，且没有候选上传或部署 API',async()=>{
 const html=await readFile(join(cwd,'public/index.html'),'utf8');
 const app=await readFile(join(cwd,'public/app.js'),'utf8');
 const server=await readFile(join(cwd,'scripts/server.mjs'),'utf8');
 for(const id of [
  'release-candidate-status','release-candidate-meta',
  'release-candidate-checks','release-candidate-approve','release-candidate-reject'
 ])assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(app,/data-release-check/);
 assert.match(app,/window\.confirm\(prompt\)/);
 assert.match(app,/\/api\/release\/candidate\/decision/);
 assert.match(app,/acknowledgements\.length!==candidate\.requiredHumanChecks\.length/);
 assert.doesNotMatch(app,/\/api\/release\/(?:deploy|publish|candidate\/upload)/);
 assert.doesNotMatch(server,/pathname==='\/api\/release\/candidate\/upload'/);
 assert.doesNotMatch(server,/pathname==='\/api\/release\/(?:deploy|publish)'/);
 assert.match(html,/批准只写审计账本，不会执行部署、升级、回滚或设备动作/);
});
