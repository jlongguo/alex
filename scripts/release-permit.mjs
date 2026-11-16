#!/usr/bin/env node
// R73 签名发布许可：把 R72 候选、人工批准事件和 CI/Voice/ROS 证据主体冻结为不可执行的签名清单。
// 本模块只生成/验证 permit；不会部署、发布、升级、回滚，也不会修改 releaseApproved。
import {
 createHash,createPrivateKey,createPublicKey,sign as cryptoSign,verify as cryptoVerify
} from 'node:crypto';
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyCiEvidence} from './ci-evidence.mjs';
import {sha256,verifyReleaseCandidate} from './release-candidate-manifest.mjs';
import {
 latestReleaseApprovalEvent,verifyReleaseApprovalState
} from './release-approval-ledger.mjs';

export const RELEASE_PERMIT_SCHEMA='alex.dev/release-permit/v1';
const RUNTIME_SCHEMA='alex.dev/runtime-acceptance-gate/v1';
const HASH=/^[0-9a-f]{64}$/;
const SHA=/^[0-9a-f]{40}$/;
const RUN=/^[1-9][0-9]{0,19}$/;
const KEY_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>
  JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const exactArray=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((value,index)=>value===b[index]);

function validateSubject(subject,commitSha,label){
 if(!object(subject)||!RUN.test(subject.run_id??'')||
  !Number.isInteger(subject.attempt)||subject.attempt<1||subject.attempt>10000||
  !SHA.test(subject.commit_sha??''))
  fail('RELEASE_PERMIT_'+label+'_SUBJECT_INVALID');
 if(subject.commit_sha!==commitSha)
  fail('RELEASE_PERMIT_'+label+'_COMMIT_MISMATCH');
 return {
  runId:subject.run_id,attempt:subject.attempt,commitSha:subject.commit_sha
 };
}

function validateRuntimeGate(runtime,commitSha){
 if(!object(runtime)||runtime.schema!==RUNTIME_SCHEMA||runtime.read_only!==true||
  runtime.release_approved!==false||runtime.physical_safety_certified!==false||
  !object(runtime.subjects))
  fail('RELEASE_PERMIT_RUNTIME_INVALID');
 if(runtime.voice_real_provider!=='verified-by-set'||
  runtime.voice_workflow_evidence!=='verified-by-set'||
  runtime.voice_artifact_attestation!=='verified-by-set'||
  runtime.voice_evidence_set!=='verified-coherent'||
  runtime.voice_github_readback!=='verified-by-set')
  fail('RELEASE_PERMIT_VOICE_EVIDENCE_INCOMPLETE');
 const rosFields=[
  'ros_runtime','ros_cancel_runtime','ros_recovery_runtime','ros_bridge_runtime',
  'ros_workflow_bundle','ros_artifact_attestation','ros_github_readback',
  'ros_runner_provenance'
 ];
 if(rosFields.some(name=>runtime[name]!=='verified-by-set')||
  runtime.ros_evidence_set!=='verified-coherent')
  fail('RELEASE_PERMIT_ROS_EVIDENCE_INCOMPLETE');
 return {
  voice:validateSubject(runtime.subjects.voice,commitSha,'VOICE'),
  ros:validateSubject(runtime.subjects.ros,commitSha,'ROS')
 };
}

function approvedEvent(candidate,ledger){
 verifyReleaseApprovalState(ledger);
 const event=latestReleaseApprovalEvent(ledger,candidate);
 if(!event||event.action!=='approved')
  fail('RELEASE_PERMIT_CURRENT_APPROVAL_REQUIRED');
 const required=[...candidate.requiredHumanChecks].sort();
 const acknowledged=[...event.acknowledgements].sort();
 if(!exactArray(required,acknowledged))
  fail('RELEASE_PERMIT_APPROVAL_ACKNOWLEDGEMENTS_MISMATCH');
 if(event.commitSha!==candidate.commitSha)
  fail('RELEASE_PERMIT_APPROVAL_COMMIT_MISMATCH');
 return event;
}

function signaturePayload(unsigned){
 return Buffer.from(canonical(unsigned),'utf8');
}

export function createReleasePermit({
 candidate,approvalLedger,runtimeGate,ciEvidence,privateKeyPem,keyId,
 createdAt=new Date().toISOString(),expiresAt=null
}={}){
 verifyReleaseCandidate(candidate);
 verifyCiEvidence(ciEvidence);
 if(ciEvidence.status!=='verified')
  fail('RELEASE_PERMIT_CI_NOT_VERIFIED');
 if(ciEvidence.context.commitSha!==candidate.commitSha)
  fail('RELEASE_PERMIT_CI_COMMIT_MISMATCH');
 if(sha256(ciEvidence)!==candidate.sourceEvidence.ciDigestSha256)
  fail('RELEASE_PERMIT_CI_DIGEST_MISMATCH');
 if(sha256(runtimeGate)!==candidate.sourceEvidence.runtimeDigestSha256)
  fail('RELEASE_PERMIT_RUNTIME_DIGEST_MISMATCH');
 const subjects=validateRuntimeGate(runtimeGate,candidate.commitSha);
 const event=approvedEvent(candidate,approvalLedger);
 if(typeof createdAt!=='string'||Number.isNaN(Date.parse(createdAt))||
  new Date(createdAt).toISOString()!==createdAt)
  fail('RELEASE_PERMIT_CREATED_AT_INVALID');
 if(expiresAt!==null&&(typeof expiresAt!=='string'||Number.isNaN(Date.parse(expiresAt))||
  new Date(expiresAt).toISOString()!==expiresAt||Date.parse(expiresAt)<=Date.parse(createdAt)))
  fail('RELEASE_PERMIT_EXPIRY_INVALID');
 if(typeof privateKeyPem!=='string'||!privateKeyPem.trim()||!KEY_ID.test(keyId??''))
  fail('RELEASE_PERMIT_SIGNING_KEY_REQUIRED');
 const privateKey=createPrivateKey(privateKeyPem);
 if(privateKey.asymmetricKeyType!=='ed25519')
  fail('RELEASE_PERMIT_SIGNING_KEY_TYPE_INVALID');

 const base={
  schema:RELEASE_PERMIT_SCHEMA,
  target:candidate.target,
  candidate:{
   id:candidate.candidateId,
   digestSha256:candidate.candidateDigestSha256,
   commitSha:candidate.commitSha,
   createdAt:candidate.createdAt
  },
  approval:{
   ledgerSchema:approvalLedger.schema,
   eventSeq:event.seq,
   eventHash:event.hash,
   decidedAt:event.at,
   reviewerRole:event.reviewerRole,
   acknowledgements:[...event.acknowledgements]
  },
  subjects:{
   ci:{
    runId:ciEvidence.context.runId,
    attempt:ciEvidence.context.runAttempt,
    commitSha:ciEvidence.context.commitSha
   },
   voice:subjects.voice,
   ros:subjects.ros
  },
  evidenceBundle:{
   candidateSha256:sha256(candidate),
   approvalLedgerSha256:digest(approvalLedger),
   runtimeGateSha256:sha256(runtimeGate),
   ciEvidenceSha256:sha256(ciEvidence),
   sourceEvidence:{
    staticDigestSha256:candidate.sourceEvidence.staticDigestSha256,
    runtimeDigestSha256:candidate.sourceEvidence.runtimeDigestSha256,
    ciDigestSha256:candidate.sourceEvidence.ciDigestSha256,
    matrixDigestSha256:candidate.matrix.digestSha256
   }
  },
  issuedAt:createdAt,
  expiresAt,
  releaseApproved:true,
  deployAuthorized:false,
  deployExecuted:false,
  rollbackExecuted:false,
  physicalSafetyCertified:false,
  note:'该许可只证明指定候选已由人工批准且证据主体一致；部署授权与实体硬件安全认证仍是独立门槛'
 };
 const permitId='rp-'+digest(base).slice(0,24);
 const unsigned={...base,permitId};
 const signature=cryptoSign(null,signaturePayload(unsigned),privateKey).toString('base64');
 return {
  ...unsigned,
  signature:{algorithm:'Ed25519',keyId,valueBase64:signature},
  permitDigestSha256:digest(unsigned)
 };
}

export function verifyReleasePermit(permit,{publicKeyPem,expectedCommit=null,now=null}={}){
 if(!object(permit)||permit.schema!==RELEASE_PERMIT_SCHEMA||
  permit.target!=='software-pilot'||!/^rp-[0-9a-f]{24}$/.test(permit.permitId??'')||
  !object(permit.candidate)||!/^rc-[0-9a-f]{24}$/.test(permit.candidate.id??'')||
  !HASH.test(permit.candidate.digestSha256??'')||!SHA.test(permit.candidate.commitSha??'')||
  !object(permit.approval)||!HASH.test(permit.approval.eventHash??'')||
  !Number.isSafeInteger(permit.approval.eventSeq)||permit.approval.eventSeq<1||
  permit.approval.reviewerRole!=='parent'||!Array.isArray(permit.approval.acknowledgements)||
  !object(permit.subjects)||!object(permit.evidenceBundle)||
  permit.releaseApproved!==true||permit.deployAuthorized!==false||
  permit.deployExecuted!==false||permit.rollbackExecuted!==false||
  permit.physicalSafetyCertified!==false||
  !object(permit.signature)||permit.signature.algorithm!=='Ed25519'||
  !KEY_ID.test(permit.signature.keyId??'')||
  typeof permit.signature.valueBase64!=='string'||!HASH.test(permit.permitDigestSha256??''))
  fail('RELEASE_PERMIT_INVALID');
 if(expectedCommit!==null&&permit.candidate.commitSha!==expectedCommit)
  fail('RELEASE_PERMIT_COMMIT_MISMATCH');
 validateSubject({
  run_id:permit.subjects.ci?.runId,
  attempt:permit.subjects.ci?.attempt,
  commit_sha:permit.subjects.ci?.commitSha
 },permit.candidate.commitSha,'CI');
 validateSubject({
  run_id:permit.subjects.voice?.runId,
  attempt:permit.subjects.voice?.attempt,
  commit_sha:permit.subjects.voice?.commitSha
 },permit.candidate.commitSha,'VOICE');
 validateSubject({
  run_id:permit.subjects.ros?.runId,
  attempt:permit.subjects.ros?.attempt,
  commit_sha:permit.subjects.ros?.commitSha
 },permit.candidate.commitSha,'ROS');
 const {signature,permitDigestSha256,...unsigned}=permit;
 if(digest(unsigned)!==permitDigestSha256)
  fail('RELEASE_PERMIT_DIGEST_MISMATCH');
 if(permit.permitId!=='rp-'+digest((({permitId,...rest})=>rest)(unsigned)).slice(0,24))
  fail('RELEASE_PERMIT_ID_MISMATCH');
 if(typeof publicKeyPem!=='string'||!publicKeyPem.trim())
  fail('RELEASE_PERMIT_PUBLIC_KEY_REQUIRED');
 const publicKey=createPublicKey(publicKeyPem);
 if(publicKey.asymmetricKeyType!=='ed25519')
  fail('RELEASE_PERMIT_PUBLIC_KEY_TYPE_INVALID');
 let signatureBytes;
 try{signatureBytes=Buffer.from(signature.valueBase64,'base64');}
 catch{fail('RELEASE_PERMIT_SIGNATURE_INVALID');}
 if(!cryptoVerify(null,signaturePayload(unsigned),publicKey,signatureBytes))
  fail('RELEASE_PERMIT_SIGNATURE_INVALID');
 if(now!==null&&permit.expiresAt!==null&&Date.parse(now)>=Date.parse(permit.expiresAt))
  fail('RELEASE_PERMIT_EXPIRED');
 return true;
}

async function readBounded(path,max=1024*1024){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>max)
  fail('RELEASE_PERMIT_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}
async function readText(path,max=128*1024){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<16||stat.size>max)
  fail('RELEASE_PERMIT_KEY_FILE_INVALID');
 return readFile(path,'utf8');
}
async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',
   {encoding:'utf8',mode:0o600,flag:'wx'});
  await rename(temp,path);
 }finally{
  try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}
 }
}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='sign'){
  if(args.length<7||args.length>8)
   fail('RELEASE_PERMIT_USAGE: sign <candidate.json> <approval-ledger.json> <runtime.json> <ci.json> <private-key.pem> <key-id> <permit.json> [expires-at]');
  const [candidate,approvalLedger,runtimeGate,ciEvidence,privateKeyPem]=await Promise.all([
   readBounded(resolve(args[0])),readBounded(resolve(args[1])),
   readBounded(resolve(args[2])),readBounded(resolve(args[3])),
   readText(resolve(args[4]))
  ]);
  const permit=createReleasePermit({
   candidate,approvalLedger,runtimeGate,ciEvidence,privateKeyPem,
   keyId:args[5],expiresAt:args[7]??null
  });
  await atomicWrite(resolve(args[6]),permit);
  console.log('RELEASE_PERMIT_WRITTEN:'+permit.permitId+':'+permit.candidate.commitSha);
  return;
 }
 if(mode==='verify'){
  if(args.length<2||args.length>3)
   fail('RELEASE_PERMIT_USAGE: verify <permit.json> <public-key.pem> [commit-sha]');
  const [permit,publicKeyPem]=await Promise.all([
   readBounded(resolve(args[0])),readText(resolve(args[1]))
  ]);
  verifyReleasePermit(permit,{publicKeyPem,expectedCommit:args[2]??null});
  console.log('RELEASE_PERMIT_VERIFIED:'+permit.permitId+':'+permit.candidate.commitSha);
  return;
 }
 fail('RELEASE_PERMIT_USAGE: sign|verify');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
