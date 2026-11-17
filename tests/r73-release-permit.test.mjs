import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createCiEvidence} from '../scripts/ci-evidence.mjs';
import {sha256,verifyReleaseCandidate} from '../scripts/release-candidate-manifest.mjs';
import {
 createReleasePermit,verifyReleasePermit
} from '../scripts/release-permit.mjs';

const canonical=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>
  JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
};
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const commit='a'.repeat(40);

function ciEvidence(){
 return createCiEvidence({
  GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'jlongguo/alex',
  GITHUB_JOB:'evidence-summary',RUNNER_ENVIRONMENT:'github-hosted',
  GITHUB_EVENT_NAME:'push',GITHUB_RUN_ID:'1001',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_SHA:commit,RUNNER_OS:'Linux',RUNNER_ARCH:'X64',
  ALEX_CI_TEST_RESULT:'success',ALEX_CI_BROWSER_RESULT:'success',
  ALEX_CI_SIM_STATIC_RESULT:'success'
 });
}
function runtimeGate(){
 return {
  schema:'alex.dev/runtime-acceptance-gate/v1',read_only:true,
  ros_runtime:'verified-by-set',
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
  ros_cancel_runtime:'verified-by-set',
  ros_recovery_runtime:'verified-by-set',
  ros_bridge_runtime:'verified-by-set',
  ros_workflow_bundle:'verified-by-set',
  ros_artifact_attestation:'verified-by-set',
  ros_evidence_set:'verified-coherent',
  ros_github_readback:'verified-by-set',
  ros_runner_provenance:'verified-by-set',
  physical_safety_certified:false,release_approved:false,
  subjects:{
   ros:{run_id:'2001',attempt:2,commit_sha:commit},
   voice:{run_id:'3001',attempt:1,commit_sha:commit},
   acoustic:{run_id:'4001',attempt:1,commit_sha:commit},
   full_voice_turn:{run_id:'5001',attempt:1,commit_sha:commit}
  },
  remaining:['PHYSICAL_SAFETY_REVIEW'],status:'manual-review-required'
 };
}
function candidate(runtime,ci){
 const base={
  schema:'alex.dev/release-candidate/v1',target:'software-pilot',
  commitSha:commit,createdAt:'2026-11-16T08:00:00.000Z',
  matrix:{
   schema:'alex.dev/release-readiness-matrix/v1',
   digestSha256:'b'.repeat(64),status:'manual-release-review',
   softwareStatus:'manual-release-review'
  },
  automatedEvidence:{ci:'pass',browserJourney:'pass',voiceProvider:'pass',realAcousticIo:'pass',fullVoiceTurn:'pass'},
  sourceEvidence:{
   staticDigestSha256:'c'.repeat(64),
   runtimeDigestSha256:sha256(runtime),
   ciDigestSha256:sha256(ci)
  },
  requiredHumanChecks:['realChildJourney','recoveryDrill'],
  releaseApproved:false,deployExecuted:false,rollbackExecuted:false,
  physicalSafetyCertified:false,
  note:'候选清单只冻结软件证据；人工确认与发布批准必须在独立审批账本完成，实体机器人安全不在本候选范围'
 };
 const identity=sha256(base);
 const candidateId='rc-'+identity.slice(0,24);
 const withoutDigest={...base,candidateId};
 const value={...withoutDigest,candidateDigestSha256:sha256(withoutDigest)};
 verifyReleaseCandidate(value);
 return value;
}
function ledgerFor(c,{action='approved'}={}){
 const body={
  seq:1,candidateId:c.candidateId,
  candidateDigestSha256:c.candidateDigestSha256,commitSha:c.commitSha,
  action,reviewerRole:'parent',
  acknowledgements:action==='approved'?[...c.requiredHumanChecks]:[],
  at:'2026-11-16T08:10:00.000Z',requestId:'request_r73_001',
  prevHash:'0'.repeat(64)
 };
 return {
  schema:'alex.dev/release-approval-ledger/v1',seq:1,
  events:[{...body,hash:digest(body)}]
 };
}
function keys(){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 return {
  privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),
  publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()
 };
}
function fixture(){
 const ci=ciEvidence(),runtime=runtimeGate(),c=candidate(runtime,ci);
 return {ci,runtime,c,ledger:ledgerFor(c),...keys()};
}

test('R79 生成并验证绑定 Candidate/Approval/CI/Voice/Acoustic/FullVoiceTurn/ROS 的 Ed25519 Permit',()=>{
 const f=fixture();
 const permit=createReleasePermit({
  candidate:f.c,approvalLedger:f.ledger,runtimeGate:f.runtime,
  ciEvidence:f.ci,privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1',
  createdAt:'2026-11-16T08:20:00.000Z',
  expiresAt:'2026-11-17T08:20:00.000Z'
 });
 assert.equal(permit.releaseApproved,true);
 assert.equal(permit.deployAuthorized,false);
 assert.equal(permit.deployExecuted,false);
 assert.equal(permit.physicalSafetyCertified,false);
 assert.equal(permit.subjects.ci.runId,'1001');
 assert.equal(permit.subjects.voice.runId,'3001');
 assert.equal(permit.subjects.acoustic.runId,'4001');
 assert.equal(permit.subjects.fullVoiceTurn.runId,'5001');
 assert.equal(permit.subjects.ros.runId,'2001');
 assert.equal(permit.approval.eventHash,f.ledger.events[0].hash);
 assert.equal(verifyReleasePermit(permit,{
  publicKeyPem:f.publicKeyPem,expectedCommit:commit,
  now:'2026-11-16T09:00:00.000Z'
 }),true);
});

test('R73 拒绝最新审批不是 approved 的候选',()=>{
 const f=fixture();
 assert.throws(()=>createReleasePermit({
  candidate:f.c,approvalLedger:ledgerFor(f.c,{action:'rejected'}),
  runtimeGate:f.runtime,ciEvidence:f.ci,
  privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1'
 }),/RELEASE_PERMIT_CURRENT_APPROVAL_REQUIRED/);
});

test('R73 拒绝 Runtime Gate 摘要与 Candidate 冻结摘要不一致',()=>{
 const f=fixture();
 const changed=structuredClone(f.runtime);
 changed.subjects.ros.run_id='2999';
 assert.throws(()=>createReleasePermit({
  candidate:f.c,approvalLedger:f.ledger,runtimeGate:changed,ciEvidence:f.ci,
  privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1'
 }),/RELEASE_PERMIT_RUNTIME_DIGEST_MISMATCH/);
});

test('R73 拒绝 Voice/ROS subject 指向不同 Commit',()=>{
 const f=fixture();
 const changed=structuredClone(f.runtime);
 changed.subjects.voice.commit_sha='d'.repeat(40);
 const c=candidate(changed,f.ci);
 const ledger=ledgerFor(c);
 assert.throws(()=>createReleasePermit({
  candidate:c,approvalLedger:ledger,runtimeGate:changed,ciEvidence:f.ci,
  privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1'
 }),/RELEASE_PERMIT_VOICE_COMMIT_MISMATCH/);
});

test('R73 Permit 内容被改写后签名验证失败',()=>{
 const f=fixture();
 const permit=createReleasePermit({
  candidate:f.c,approvalLedger:f.ledger,runtimeGate:f.runtime,
  ciEvidence:f.ci,privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1',
  createdAt:'2026-11-16T08:20:00.000Z'
 });
 const tampered=structuredClone(permit);
 tampered.note='tampered';
 assert.throws(()=>verifyReleasePermit(tampered,{publicKeyPem:f.publicKeyPem}),
  /RELEASE_PERMIT_DIGEST_MISMATCH/);
});

test('R73 Permit 过期后不能作为当前发布许可',()=>{
 const f=fixture();
 const permit=createReleasePermit({
  candidate:f.c,approvalLedger:f.ledger,runtimeGate:f.runtime,
  ciEvidence:f.ci,privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1',
  createdAt:'2026-11-16T08:20:00.000Z',
  expiresAt:'2026-11-16T10:20:00.000Z'
 });
 assert.throws(()=>verifyReleasePermit(permit,{
  publicKeyPem:f.publicKeyPem,now:'2026-11-16T10:20:00.000Z'
 }),/RELEASE_PERMIT_EXPIRED/);
});


test('R77 Permit 拒绝 Acoustic subject 指向不同 Commit',()=>{
 const f=fixture();
 const changed=structuredClone(f.runtime);
 changed.subjects.acoustic.commit_sha='e'.repeat(40);
 const c=candidate(changed,f.ci);
 const ledger=ledgerFor(c);
 assert.throws(()=>createReleasePermit({
  candidate:c,approvalLedger:ledger,runtimeGate:changed,ciEvidence:f.ci,
  privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1'
 }),/RELEASE_PERMIT_ACOUSTIC_COMMIT_MISMATCH/);
});


test('R79 Permit 拒绝 Full Voice Turn subject 指向不同 Commit',()=>{
 const f=fixture();
 const changed=structuredClone(f.runtime);
 changed.subjects.full_voice_turn.commit_sha='f'.repeat(40);
 const c=candidate(changed,f.ci);
 const ledger=ledgerFor(c);
 assert.throws(()=>createReleasePermit({
  candidate:c,approvalLedger:ledger,runtimeGate:changed,ciEvidence:f.ci,
  privateKeyPem:f.privateKeyPem,keyId:'local-release-key-v1'
 }),/RELEASE_PERMIT_FULL_VOICE_TURN_COMMIT_MISMATCH/);
});
