import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {evaluateReleaseReadiness} from '../scripts/release-readiness.mjs';
import {
 composeReleaseReadinessMatrix
} from '../scripts/release-readiness-matrix.mjs';
import {
 createCiEvidence,verifyCiEvidence
} from '../scripts/ci-evidence.mjs';

const root=resolve(import.meta.dirname,'..');
const SHA='0123456789abcdef0123456789abcdef01234567';
const staticBase=()=>evaluateReleaseReadiness({
 authMode:'local',childLoginEnabled:true,profileCount:1,
 skillReconciliation:{status:'consistent',findings:[]},
 singleWal:{pending:0,remaining:400},batchWal:{pending:0,remaining:400},
 audioConfigured:true,conversationProvider:'offline',writerLockHeld:true
});
const runtimeBase=()=>({
 schema:'alex.dev/runtime-acceptance-gate/v1',read_only:true,
 status:'manual-review-required',
 ros_runtime:'not_run',
 voice_real_provider:'not_run',
 voice_workflow_evidence:'not_run',
 voice_artifact_attestation:'not_run',
 voice_evidence_set:'not_run',
 voice_github_readback:'not_run',
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
 subjects:{ros:null,voice:null,acoustic:null},
 remaining:[
  'REAL_ASR_LLM_TTS_PROVIDER_E2E',
  'VOICE_PROVIDER_WORKFLOW_EVIDENCE',
  'VOICE_ACTIONS_ARTIFACT_ATTESTATION',
  'VOICE_PROVIDER_COHERENT_EVIDENCE_SET',
  'VOICE_GITHUB_ACTIONS_READBACK_AUDIT',
  'REAL_ACOUSTIC_IO',
  'GAZEBO_NAV2_THREE_LEG_RUNTIME',
  'GAZEBO_NAV2_CANCEL_RUNTIME',
  'GAZEBO_NAV2_RECOVERY_RUNTIME',
  'GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME',
  'GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE',
  'GAZEBO_ACTIONS_ARTIFACT_ATTESTATION',
  'GAZEBO_ROS_COHERENT_EVIDENCE_SET',
  'GAZEBO_GITHUB_ACTIONS_READBACK_AUDIT',
  'GAZEBO_RUNNER_ENVIRONMENT_PROVENANCE',
  'PHYSICAL_SAFETY_REVIEW'
 ]
});
const ciEnv=(overrides={})=>({
 GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',
 GITHUB_REPOSITORY:'jlongguo/alex',GITHUB_JOB:'evidence-summary',
 RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
 GITHUB_RUN_ID:'43753250820',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:SHA,
 ALEX_CI_TEST_RESULT:'success',ALEX_CI_BROWSER_RESULT:'success',
 ALEX_CI_SIM_STATIC_RESULT:'success',GITHUB_TOKEN:'must-not-be-recorded',
 ...overrides
});

test('R71 只有 R42 静态报告时，矩阵不会推导 CI/Voice/ROS 已通过',()=>{
 const matrix=composeReleaseReadinessMatrix({staticReadiness:staticBase()});
 assert.equal(matrix.schema,'alex.dev/release-readiness-matrix/v1');
 assert.equal(matrix.status,'evidence-required');
 assert.equal(matrix.releaseApproved,false);
 assert.equal(matrix.physicalSafetyCertified,false);
 assert.equal(matrix.domains.staticConfiguration.status,'pass');
 assert.equal(matrix.domains.ci.status,'evidence-required');
 assert.equal(matrix.domains.browserJourney.status,'evidence-required');
 assert.equal(matrix.domains.voiceProvider.status,'evidence-required');
 assert.equal(matrix.domains.rosSimulation.status,'evidence-required');
 assert.equal(matrix.domains.realAcousticIo.status,'manual-required');
 assert.equal(matrix.domains.realChildJourney.status,'manual-required');
 assert.equal(matrix.domains.physicalSafety.status,'manual-required');
 assert.equal(matrix.targets.softwarePilot.status,'evidence-required');
 assert.equal(matrix.targets.robotCandidate.status,'evidence-required');
});

test('R71 当前 Commit 三域 CI 全绿只证明 unit/browser/sim-static，不会冒充 Runtime Gate',()=>{
 const ci=createCiEvidence(ciEnv());
 verifyCiEvidence(ci);
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),ciEvidence:ci
 });
 assert.equal(matrix.domains.ci.status,'pass');
 assert.equal(matrix.domains.browserJourney.status,'pass');
 assert.equal(matrix.domains.browserJourney.evidenceLevel,
  'real-browser-synthetic-family');
 assert.equal(matrix.domains.voiceProvider.status,'evidence-required');
 assert.equal(matrix.domains.rosSimulation.status,'evidence-required');
 assert.equal(matrix.targets.softwarePilot.status,'evidence-required');
});

test('R71 Voice 与 ROS coherent set 全部验证后仍保留真实声学/儿童旅程/恢复/物理安全人工门槛',()=>{
 const runtime=runtimeBase();
 Object.assign(runtime,{
  voice_real_provider:'verified-by-set',
  voice_workflow_evidence:'verified-by-set',
  voice_artifact_attestation:'verified-by-set',
  voice_evidence_set:'verified-coherent',
  voice_github_readback:'verified-by-set',
  ros_runtime:'verified-by-set',
  ros_cancel_runtime:'verified-by-set',
  ros_recovery_runtime:'verified-by-set',
  ros_bridge_runtime:'verified-by-set',
  ros_workflow_bundle:'verified-by-set',
  ros_artifact_attestation:'verified-by-set',
  ros_evidence_set:'verified-coherent',
  ros_github_readback:'verified-by-set',
  ros_runner_provenance:'verified-by-set',
  subjects:{
   voice:{run_id:'876543210',attempt:2,commit_sha:SHA},
   ros:{run_id:'76543210',attempt:3,commit_sha:SHA}
  },
  remaining:['PHYSICAL_SAFETY_REVIEW']
 });
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:runtime,
  ciEvidence:createCiEvidence(ciEnv())
 });
 assert.equal(matrix.domains.voiceProvider.status,'pass');
 assert.equal(matrix.domains.rosSimulation.status,'pass');
 assert.equal(matrix.targets.softwarePilot.status,'manual-release-review');
 assert.equal(matrix.targets.robotCandidate.status,'manual-release-review');
 for(const id of ['realAcousticIo','realChildJourney','recoveryDrill',
  'physicalSafety'])assert.ok(matrix.manual.includes(id),id);
 assert.equal(matrix.releaseApproved,false);
 assert.equal(matrix.targets.robotCandidate.physicalSafetyCertified,false);
});

test('R71 CI、Voice、ROS 必须属于同一 Commit，跨 Commit 拼接直接 blocked',()=>{
 const runtime=runtimeBase();
 Object.assign(runtime,{
  voice_real_provider:'verified-by-set',
  voice_workflow_evidence:'verified-by-set',
  voice_artifact_attestation:'verified-by-set',
  voice_evidence_set:'verified-coherent',
  voice_github_readback:'verified-by-set',
  ros_runtime:'verified-by-set',
  ros_cancel_runtime:'verified-by-set',
  ros_recovery_runtime:'verified-by-set',
  ros_bridge_runtime:'verified-by-set',
  ros_workflow_bundle:'verified-by-set',
  ros_artifact_attestation:'verified-by-set',
  ros_evidence_set:'verified-coherent',
  ros_github_readback:'verified-by-set',
  ros_runner_provenance:'verified-by-set',
  subjects:{
   voice:{run_id:'876543210',attempt:2,commit_sha:'f'.repeat(40)},
   ros:{run_id:'76543210',attempt:3,commit_sha:SHA}
  }
 });
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:runtime,
  ciEvidence:createCiEvidence(ciEnv())
 });
 assert.equal(matrix.status,'blocked');
 assert.equal(matrix.domains.voiceProvider.evidenceLevel,'commit-mismatch');
 assert.equal(matrix.domains.rosSimulation.evidenceLevel,'commit-mismatch');
 assert.equal(matrix.inputs.subjects.ciCommit,SHA);
});

test('R71 任一 Runtime Gate invalid 或 CI failure 都必须使矩阵 blocked',()=>{
 const badRuntime=runtimeBase();
 badRuntime.voice_evidence_set='invalid';
 let matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:badRuntime,
  ciEvidence:createCiEvidence(ciEnv())
 });
 assert.equal(matrix.status,'blocked');
 assert.ok(matrix.blockers.includes('voiceProvider'));

 const badCi=createCiEvidence(ciEnv({ALEX_CI_BROWSER_RESULT:'failure'}));
 matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),ciEvidence:badCi
 });
 assert.equal(matrix.status,'blocked');
 assert.ok(matrix.blockers.includes('ci'));
 assert.ok(matrix.blockers.includes('browserJourney'));
});

test('R71 CI evidence 严格绑定当前 Run/Attempt/SHA，且绝不记录 GitHub Token',()=>{
 const report=createCiEvidence(ciEnv());
 assert.equal(report.status,'verified');
 assert.equal(report.context.runId,'43753250820');
 assert.equal(report.context.runAttempt,1);
 assert.equal(report.context.commitSha,SHA);
 assert.equal(report.domains.browser.realEngine,true);
 assert.equal(report.domains.rosStatic.runtimeVerified,false);
 assert.equal(JSON.stringify(report).includes('must-not-be-recorded'),false);

 const tampered=structuredClone(report);
 tampered.status='blocked';
 assert.throws(()=>verifyCiEvidence(tampered),/CI_EVIDENCE_STATUS_MISMATCH/);
 assert.throws(()=>createCiEvidence(ciEnv({GITHUB_SHA:'bad'})),
  /CI_EVIDENCE_COMMIT_INVALID/);
 assert.throws(()=>createCiEvidence(ciEnv({ALEX_CI_TEST_RESULT:'unknown'})),
  /CI_EVIDENCE_JOB_RESULT_INVALID/);
});

test('R71 拒绝伪造或不完整的 Runtime Gate / Static readiness 输入',()=>{
 const runtime=runtimeBase();
 runtime.ros_runtime='passed';
 assert.throws(()=>composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:runtime
 }),/READINESS_MATRIX_RUNTIME_STATUS_INVALID/);
 const stat=staticBase();
 stat.releaseApproved=true;
 assert.throws(()=>composeReleaseReadinessMatrix({staticReadiness:stat}),
  /READINESS_MATRIX_STATIC_/);
});

test('R71 matrix CLI 对 JSON 文件做只读汇总，blocked 时非零但不执行发布动作',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r71-matrix-'));
 try{
  const staticPath=join(dir,'static.json');
  const runtimePath=join(dir,'runtime.json');
  const ciPath=join(dir,'ci.json');
  await writeFile(staticPath,JSON.stringify(staticBase()));
  await writeFile(runtimePath,JSON.stringify(runtimeBase()));
  await writeFile(ciPath,JSON.stringify(createCiEvidence(ciEnv())));
  const checked=spawnSync('node',[
   'scripts/release-readiness-matrix.mjs',
   '--static',staticPath,'--runtime',runtimePath,'--ci',ciPath
  ],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(checked.status,0,checked.stderr);
  const matrix=JSON.parse(checked.stdout);
  assert.equal(matrix.status,'evidence-required');
  assert.equal(matrix.executable,false);
  assert.equal(matrix.releaseApproved,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R75 当前 Commit 的正式 Recovery Drill Evidence 可解除 recoveryDrill 人工门槛',async()=>{
 const recovery={
  schema:'alex.dev/recovery-drill/v1',status:'verified',commitSha:SHA,
  createdAt:'2026-11-16T10:00:00.000Z',
  backup:{snapshotId:'11111111-1111-4111-8111-111111111111',files:3,bytes:128,
   integrity:'verified-before-and-after'},
  staging:{restored:true,stagingOnly:true,productionRestored:false,fileCount:3,byteCount:128,
   audit:'staging-copy-verified'},
  preflight:{status:'manual-review-required',blocked:[],manual:['REAL_USER_ACCEPTANCE']},
  businessLoad:{serverBooted:true,healthEndpointVerified:true,cleanShutdown:true,
   externalProvidersDisabled:true},
  readOnlyEvidence:true,rollbackExecuted:false,releaseApproved:false,
  physicalSafetyCertified:false,
  note:'fixture'
 };
 const {createHash}=await import('node:crypto');
 const canonical=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 };
 recovery.evidenceDigestSha256=createHash('sha256').update(canonical(recovery)).digest('hex');
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),
  ciEvidence:createCiEvidence(ciEnv()),
  recoveryEvidence:recovery
 });
 assert.equal(matrix.domains.recoveryDrill.status,'pass');
 assert.equal(matrix.domains.recoveryDrill.evidenceLevel,'isolated-business-load');
 assert.equal(matrix.inputs.subjects.recoveryCommit,SHA);
 assert.ok(!matrix.manual.includes('recoveryDrill'));
});

test('R75 Recovery Drill 与当前 CI Commit 不一致时矩阵必须 blocked',async()=>{
 const {createHash}=await import('node:crypto');
 const recovery={
  schema:'alex.dev/recovery-drill/v1',status:'verified',commitSha:'f'.repeat(40),
  createdAt:'2026-11-16T10:00:00.000Z',
  backup:{snapshotId:'11111111-1111-4111-8111-111111111111',files:1,bytes:64,
   integrity:'verified-before-and-after'},
  staging:{restored:true,stagingOnly:true,productionRestored:false,fileCount:1,byteCount:64,
   audit:'staging-copy-verified'},
  preflight:{status:'manual-review-required',blocked:[],manual:[]},
  businessLoad:{serverBooted:true,healthEndpointVerified:true,cleanShutdown:true,
   externalProvidersDisabled:true},
  readOnlyEvidence:true,rollbackExecuted:false,releaseApproved:false,
  physicalSafetyCertified:false,note:'fixture'
 };
 const canonical=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 };
 recovery.evidenceDigestSha256=createHash('sha256').update(canonical(recovery)).digest('hex');
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),ciEvidence:createCiEvidence(ciEnv()),
  recoveryEvidence:recovery
 });
 assert.equal(matrix.domains.recoveryDrill.status,'blocked');
 assert.equal(matrix.domains.recoveryDrill.evidenceLevel,'commit-mismatch');
});

test('R76 self-hosted Acoustic subject 与当前 CI Commit 一致时 realAcousticIo 可通过',()=>{
 const runtime=runtimeBase();
 runtime.acoustic_io='verified-self-hosted';
 runtime.subjects.acoustic={run_id:'43800000001',attempt:1,commit_sha:SHA};
 runtime.remaining=runtime.remaining.filter(x=>x!=='REAL_ACOUSTIC_IO');
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:runtime,
  ciEvidence:createCiEvidence(ciEnv())
 });
 assert.equal(matrix.domains.realAcousticIo.status,'pass');
 assert.equal(matrix.domains.realAcousticIo.evidenceLevel,'self-hosted-physical-loop');
 assert.equal(matrix.inputs.subjects.acoustic.commit_sha,SHA);
});

test('R76 Acoustic evidence 跨 Commit 或 invalid 必须阻断软件发布矩阵',()=>{
 let runtime=runtimeBase();
 runtime.acoustic_io='verified-self-hosted';
 runtime.subjects.acoustic={run_id:'43800000001',attempt:1,commit_sha:'f'.repeat(40)};
 let matrix=composeReleaseReadinessMatrix({
  staticReadiness:staticBase(),runtimeGate:runtime,
  ciEvidence:createCiEvidence(ciEnv())
 });
 assert.equal(matrix.domains.realAcousticIo.status,'blocked');
 assert.equal(matrix.domains.realAcousticIo.evidenceLevel,'commit-mismatch');
 assert.ok(matrix.targets.softwarePilot.blockers.includes('realAcousticIo'));
 runtime=runtimeBase();runtime.acoustic_io='invalid';
 matrix=composeReleaseReadinessMatrix({staticReadiness:staticBase(),runtimeGate:runtime});
 assert.equal(matrix.domains.realAcousticIo.status,'blocked');
});
