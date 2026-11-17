import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {evaluateReleaseReadiness} from '../scripts/release-readiness.mjs';
import {
 composeReleaseReadinessMatrix,verifyReleaseReadinessMatrix
} from '../scripts/release-readiness-matrix.mjs';
import {createCiEvidence} from '../scripts/ci-evidence.mjs';
import {
 createReleaseCandidate,verifyReleaseCandidate,sha256
} from '../scripts/release-candidate-manifest.mjs';
import {ReleaseApprovalLedger} from '../scripts/release-approval-ledger.mjs';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';

const root=resolve(import.meta.dirname,'..');
const SHA='0123456789abcdef0123456789abcdef01234567';
const staticBase=()=>evaluateReleaseReadiness({
 authMode:'local',childLoginEnabled:true,profileCount:1,
 skillReconciliation:{status:'consistent',findings:[]},
 singleWal:{pending:0,remaining:400},batchWal:{pending:0,remaining:400},
 audioConfigured:true,conversationProvider:'offline',writerLockHeld:true
});
const ci=()=>createCiEvidence({
 GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',
 GITHUB_REPOSITORY:'jlongguo/alex',GITHUB_JOB:'evidence-summary',
 RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
 GITHUB_RUN_ID:'43759975148',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:SHA,
 ALEX_CI_TEST_RESULT:'success',ALEX_CI_BROWSER_RESULT:'success',
 ALEX_CI_SIM_STATIC_RESULT:'success'
});
const runtimeVoice=()=>({
 schema:'alex.dev/runtime-acceptance-gate/v1',read_only:true,
 status:'manual-review-required',
 ros_runtime:'not_run',
 voice_real_provider:'verified-by-set',
 voice_workflow_evidence:'verified-by-set',
 voice_artifact_attestation:'verified-by-set',
 voice_evidence_set:'verified-coherent',
 voice_github_readback:'verified-by-set',
 acoustic_io:'not_run',
 nav2_fault_contract:'not_run',
 ros_cancel_runtime:'not_run',
 ros_recovery_runtime:'not_run',
 ros_bridge_runtime:'not_run',
 ros_workflow_bundle:'not_run',
 ros_artifact_attestation:'not_run',
 ros_evidence_set:'not_run',
 ros_github_readback:'not_run',
 ros_runner_provenance:'not_run',
 physical_safety_certified:false,release_approved:false,
 subjects:{
  voice:{run_id:'987654321',attempt:2,commit_sha:SHA},
  ros:null,
  acoustic:null
 },
 remaining:[
  'GAZEBO_NAV2_THREE_LEG_RUNTIME','GAZEBO_NAV2_CANCEL_RUNTIME',
  'GAZEBO_NAV2_RECOVERY_RUNTIME','GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME',
  'GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE','GAZEBO_ACTIONS_ARTIFACT_ATTESTATION',
  'GAZEBO_ROS_COHERENT_EVIDENCE_SET','GAZEBO_GITHUB_ACTIONS_READBACK_AUDIT',
  'GAZEBO_RUNNER_ENVIRONMENT_PROVENANCE','REAL_ACOUSTIC_IO','PHYSICAL_SAFETY_REVIEW'
 ]
});
const matrix=()=>composeReleaseReadinessMatrix({
 staticReadiness:staticBase(),runtimeGate:runtimeVoice(),ciEvidence:ci()
});
const sourceEvidence=()=>({
 staticDigestSha256:sha256(staticBase()),
 runtimeDigestSha256:sha256(runtimeVoice()),
 ciDigestSha256:sha256(ci())
});
const timestamp='2026-11-16T00:00:00.000Z';
const candidateAt=(createdAt=timestamp)=>createReleaseCandidate(matrix(),{
 createdAt,sourceEvidence:sourceEvidence()
});

test('R72 只有软件自动证据齐全且进入人工复核阶段才能冻结候选',()=>{
 const value=matrix();
 assert.equal(value.targets.softwarePilot.status,'manual-release-review');
 assert.equal(value.targets.robotCandidate.status,'evidence-required');
 assert.equal(verifyReleaseReadinessMatrix(value),true);
 const candidate=createReleaseCandidate(value,{createdAt:timestamp,sourceEvidence:sourceEvidence()});
 assert.equal(verifyReleaseCandidate(candidate,{expectedCommit:SHA}),true);
 assert.equal(candidate.releaseApproved,false);
 assert.equal(candidate.deployExecuted,false);
 assert.equal(candidate.physicalSafetyCertified,false);
 assert.deepEqual(candidate.requiredHumanChecks,[
  'realAcousticIo','realChildJourney','recoveryDrill'
 ]);
 assert.equal(candidate.automatedEvidence.ci,'pass');
 assert.equal(candidate.automatedEvidence.browserJourney,'pass');
 assert.equal(candidate.automatedEvidence.voiceProvider,'pass');
});

test('R72 Matrix verifier 会重算 software target，不能通过删人工检查项伪造可批准候选',()=>{
 const value=matrix();
 value.targets.softwarePilot.manual=value.targets.softwarePilot.manual
  .filter(item=>item!=='realAcousticIo');
 assert.throws(()=>verifyReleaseReadinessMatrix(value),
  /READINESS_MATRIX_SOFTWARE_TARGET_DRIFT/);
 assert.throws(()=>createReleaseCandidate(value,{createdAt:timestamp,sourceEvidence:sourceEvidence()}),
  /READINESS_MATRIX_SOFTWARE_TARGET_DRIFT/);
});

test('R72 缺真实 Voice coherent evidence 时不能创建软件候选',()=>{
 const runtime=runtimeVoice();
 runtime.voice_real_provider='not_run';
 runtime.voice_workflow_evidence='not_run';
 runtime.voice_artifact_attestation='not_run';
 runtime.voice_evidence_set='not_run';
 runtime.voice_github_readback='not_run';
 runtime.subjects.voice=null;
 const value=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:runtime,ciEvidence:ci()
 });
 assert.equal(value.targets.softwarePilot.status,'evidence-required');
 assert.throws(()=>createReleaseCandidate(value,{createdAt:timestamp,sourceEvidence:sourceEvidence()}),
  /RELEASE_CANDIDATE_SOFTWARE_NOT_READY_FOR_HUMAN_REVIEW/);
});

test('R72 Candidate ID/Digest 固定 Matrix 与 Commit，任何字段篡改都会失败',()=>{
 const candidate=candidateAt();
 const digest=candidate.candidateDigestSha256;
 const changed=structuredClone(candidate);
 changed.commitSha='f'.repeat(40);
 assert.throws(()=>verifyReleaseCandidate(changed),
  /RELEASE_CANDIDATE_ID_MISMATCH|RELEASE_CANDIDATE_DIGEST_MISMATCH/);
 const changedChecks=structuredClone(candidate);
 changedChecks.requiredHumanChecks.pop();
 assert.throws(()=>verifyReleaseCandidate(changedChecks),
  /RELEASE_CANDIDATE_ID_MISMATCH|RELEASE_CANDIDATE_DIGEST_MISMATCH/);
 assert.equal(candidate.candidateDigestSha256,digest);
});

test('R72 审批必须由 parent 对当前候选逐项确认，批准只改变审批状态不执行部署',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r72-approval-'));
 try{
  const candidateFile=join(dir,'candidate.json');
  const ledgerFile=join(dir,'approvals.json');
  const candidate=candidateAt();
  await writeFile(candidateFile,JSON.stringify(candidate));
  const ledger=new ReleaseApprovalLedger(ledgerFile,{
   candidateFile,clock:()=>Date.parse('2026-11-16T00:10:00.000Z')
  });
  await ledger.load();
  let status=await ledger.status();
  assert.equal(status.status,'pending-review');
  assert.equal(status.releaseApproved,false);
  await assert.rejects(()=>ledger.decide('child',{
   action:'approved',candidateId:candidate.candidateId,
   candidateDigestSha256:candidate.candidateDigestSha256,
   acknowledgements:candidate.requiredHumanChecks,requestId:'request_child_001'
  }),/PARENT_REQUIRED/);
  await assert.rejects(()=>ledger.decide('parent',{
   action:'approved',candidateId:candidate.candidateId,
   candidateDigestSha256:candidate.candidateDigestSha256,
   acknowledgements:['realChildJourney'],requestId:'request_parent_001'
  }),/RELEASE_APPROVAL_HUMAN_CHECKS_INCOMPLETE/);

  const approved=await ledger.decide('parent',{
   action:'approved',candidateId:candidate.candidateId,
   candidateDigestSha256:candidate.candidateDigestSha256,
   acknowledgements:candidate.requiredHumanChecks,
   requestId:'request_parent_002'
  });
  assert.equal(approved.status.releaseApproved,true);
  assert.equal(approved.status.deployExecuted,false);
  assert.equal(approved.status.physicalSafetyCertified,false);
  assert.equal(approved.event.reviewerRole,'parent');
  assert.equal(approved.event.action,'approved');

  const duplicate=await ledger.decide('parent',{
   action:'approved',candidateId:candidate.candidateId,
   candidateDigestSha256:candidate.candidateDigestSha256,
   acknowledgements:candidate.requiredHumanChecks,
   requestId:'request_parent_002'
  });
  assert.equal(duplicate.duplicate,true);
  await ledger.flush();

  const reloaded=new ReleaseApprovalLedger(ledgerFile,{candidateFile});
  await reloaded.load();
  status=await reloaded.status();
  assert.equal(status.releaseApproved,true);
  assert.equal(status.decision.action,'approved');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R72 候选 digest 变化后旧批准不会继承，旧客户端也不能批准新候选',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r72-change-'));
 try{
  const candidateFile=join(dir,'candidate.json');
  const ledgerFile=join(dir,'approvals.json');
  const first=candidateAt();
  await writeFile(candidateFile,JSON.stringify(first));
  const ledger=new ReleaseApprovalLedger(ledgerFile,{candidateFile});
  await ledger.load();
  await ledger.decide('parent',{
   action:'approved',candidateId:first.candidateId,
   candidateDigestSha256:first.candidateDigestSha256,
   acknowledgements:first.requiredHumanChecks,
   requestId:'request_first_001'
  });
  assert.equal((await ledger.status()).releaseApproved,true);

  const second=candidateAt('2026-11-16T00:01:00.000Z');
  await writeFile(candidateFile,JSON.stringify(second));
  const status=await ledger.status();
  assert.equal(status.releaseApproved,false);
  assert.equal(status.status,'pending-review');
  assert.equal(status.candidate.candidateId,second.candidateId);
  await assert.rejects(()=>ledger.decide('parent',{
   action:'approved',candidateId:first.candidateId,
   candidateDigestSha256:first.candidateDigestSha256,
   acknowledgements:first.requiredHumanChecks,
   requestId:'request_stale_001'
  }),/RELEASE_CANDIDATE_CHANGED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R72 审批哈希链被篡改后重启必须 fail closed',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r72-chain-'));
 try{
  const candidateFile=join(dir,'candidate.json');
  const ledgerFile=join(dir,'approvals.json');
  const candidate=candidateAt();
  await writeFile(candidateFile,JSON.stringify(candidate));
  const ledger=new ReleaseApprovalLedger(ledgerFile,{candidateFile});
  await ledger.load();
  await ledger.decide('parent',{
   action:'approved',candidateId:candidate.candidateId,
   candidateDigestSha256:candidate.candidateDigestSha256,
   acknowledgements:candidate.requiredHumanChecks,
   requestId:'request_chain_001'
  });
  await ledger.flush();
  const state=JSON.parse(await readFile(ledgerFile,'utf8'));
  state.events[0].acknowledgements=['realChildJourney'];
  await writeFile(ledgerFile,JSON.stringify(state));
  const corrupted=new ReleaseApprovalLedger(ledgerFile,{candidateFile});
  await assert.rejects(()=>corrupted.load(),/RELEASE_APPROVAL_HASH_CHAIN_INVALID/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R72 candidate CLI create/verify 只写候选文件，不执行发布',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r72-cli-'));
 try{
  const staticFile=join(dir,'static.json'),runtimeFile=join(dir,'runtime.json');
  const ciFile=join(dir,'ci.json'),candidateFile=join(dir,'candidate.json');
  const staticReadiness=staticBase(),runtimeGate=runtimeVoice(),ciEvidence=ci();
  await writeFile(staticFile,JSON.stringify(staticReadiness));
  await writeFile(runtimeFile,JSON.stringify(runtimeGate));
  await writeFile(ciFile,JSON.stringify(ciEvidence));
  let checked=spawnSync(process.execPath,[
   'scripts/release-candidate-manifest.mjs','create',
   staticFile,runtimeFile,ciFile,candidateFile
  ],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(checked.status,0,checked.stderr);
  assert.match(checked.stdout,/RELEASE_CANDIDATE_WRITTEN:/);
  checked=spawnSync(process.execPath,[
   'scripts/release-candidate-manifest.mjs','verify',candidateFile,SHA
  ],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(checked.status,0,checked.stderr);
  assert.match(checked.stdout,/RELEASE_CANDIDATE_VERIFIED:/);
  const value=JSON.parse(await readFile(candidateFile,'utf8'));
  assert.equal(value.releaseApproved,false);
  assert.equal(value.deployExecuted,false);
  assert.equal(value.sourceEvidence.staticDigestSha256,sha256(staticReadiness));
  assert.equal(value.sourceEvidence.runtimeDigestSha256,sha256(runtimeGate));
  assert.equal(value.sourceEvidence.ciDigestSha256,sha256(ciEvidence));
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('R72 发布预检把审批账本纳入备份范围，外置账本不能被默认备份静默遗漏',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r72-preflight-'));
 try{
  const stateDir=join(dir,'state');
  const external=join(dir,'outside','release-approvals.json');
  await (await import('node:fs/promises')).mkdir(stateDir,{recursive:true});
  const report=await inspectReleasePreflight({
   stateDir,
   env:{
    AUTH_MODE:'local',
    ALEX_PARENT_PASSWORD:'r72-preflight-parent-password',
    ALEX_RELEASE_APPROVAL_FILE:external
   }
  });
  assert.ok(report.blocked.includes('BACKUP_SCOPE'));
  assert.ok(report.storage.outsideDefaultBackup>=1);
  assert.equal(report.releaseApproved,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
