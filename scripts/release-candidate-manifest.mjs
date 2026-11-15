#!/usr/bin/env node
// R72 发布候选清单：冻结已验证 Matrix 的软件候选版本，但不执行部署、不授予发布批准。
// 候选文件可由管理员/CI 在本机生成，浏览器端不能上传或改写候选证据。
import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
 MATRIX_SCHEMA,composeReleaseReadinessMatrix,verifyReleaseReadinessMatrix
} from './release-readiness-matrix.mjs';

export const RELEASE_CANDIDATE_SCHEMA='alex.dev/release-candidate/v1';
const SHA=/^[0-9a-f]{40}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const CHECK=/^[A-Za-z][A-Za-z0-9_-]{1,79}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>
  JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
export const sha256=value=>createHash('sha256').update(
 typeof value==='string'?value:canonical(value)).digest('hex');

function matrixDigest(matrix){
 verifyReleaseReadinessMatrix(matrix);
 return sha256(matrix);
}
function normalizedChecks(value){
 if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!CHECK.test(item)))
  fail('RELEASE_CANDIDATE_HUMAN_CHECKS_INVALID');
 const checks=[...new Set(value)].sort();
 if(checks.length!==value.length||checks.length===0||checks.length>20)
  fail('RELEASE_CANDIDATE_HUMAN_CHECKS_INVALID');
 return checks;
}

export function createReleaseCandidate(matrix,{
 createdAt=new Date().toISOString(),sourceEvidence
}={}){
 verifyReleaseReadinessMatrix(matrix);
 const target=matrix.targets?.softwarePilot;
 if(!object(target)||target.status!=='manual-release-review'||
  target.blockers.length||target.evidenceRequired.length)
  fail('RELEASE_CANDIDATE_SOFTWARE_NOT_READY_FOR_HUMAN_REVIEW');
 const commitSha=matrix.inputs?.subjects?.ciCommit;
 if(typeof commitSha!=='string'||!SHA.test(commitSha))
  fail('RELEASE_CANDIDATE_COMMIT_REQUIRED');
 if(matrix.domains?.ci?.status!=='pass'||
  matrix.domains?.browserJourney?.status!=='pass'||
  matrix.domains?.voiceProvider?.status!=='pass')
  fail('RELEASE_CANDIDATE_AUTOMATED_EVIDENCE_INCOMPLETE');
 const requiredHumanChecks=normalizedChecks(target.manual);
 if(typeof createdAt!=='string'||Number.isNaN(Date.parse(createdAt))||
  new Date(createdAt).toISOString()!==createdAt)
  fail('RELEASE_CANDIDATE_CREATED_AT_INVALID');
 if(!object(sourceEvidence)||
  !DIGEST.test(sourceEvidence.staticDigestSha256??'')||
  !DIGEST.test(sourceEvidence.runtimeDigestSha256??'')||
  !DIGEST.test(sourceEvidence.ciDigestSha256??''))
  fail('RELEASE_CANDIDATE_SOURCE_EVIDENCE_INVALID');

 const base={
  schema:RELEASE_CANDIDATE_SCHEMA,
  target:'software-pilot',
  commitSha,
  createdAt,
  matrix:{
   schema:MATRIX_SCHEMA,
   digestSha256:matrixDigest(matrix),
   status:matrix.status,
   softwareStatus:target.status
  },
  automatedEvidence:{
   ci:matrix.domains.ci.status,
   browserJourney:matrix.domains.browserJourney.status,
   voiceProvider:matrix.domains.voiceProvider.status
  },
  sourceEvidence:structuredClone(sourceEvidence),
  requiredHumanChecks,
  releaseApproved:false,
  deployExecuted:false,
  rollbackExecuted:false,
  physicalSafetyCertified:false,
  note:'候选清单只冻结软件证据；人工确认与发布批准必须在独立审批账本完成，实体机器人安全不在本候选范围'
 };
 const identity=sha256(base);
 const candidateId='rc-'+identity.slice(0,24);
 const withoutDigest={...base,candidateId};
 return {...withoutDigest,candidateDigestSha256:sha256(withoutDigest)};
}

export function verifyReleaseCandidate(candidate,{expectedCommit=null}={}){
 if(!object(candidate)||candidate.schema!==RELEASE_CANDIDATE_SCHEMA||
  candidate.target!=='software-pilot'||typeof candidate.candidateId!=='string'||
  !/^rc-[0-9a-f]{24}$/.test(candidate.candidateId)||
  !SHA.test(candidate.commitSha??'')||
  typeof candidate.createdAt!=='string'||Number.isNaN(Date.parse(candidate.createdAt))||
  new Date(candidate.createdAt).toISOString()!==candidate.createdAt||
  !object(candidate.matrix)||candidate.matrix.schema!==MATRIX_SCHEMA||
  !DIGEST.test(candidate.matrix.digestSha256??'')||
  candidate.matrix.softwareStatus!=='manual-release-review'||
  !object(candidate.automatedEvidence)||
  candidate.automatedEvidence.ci!=='pass'||
  candidate.automatedEvidence.browserJourney!=='pass'||
  candidate.automatedEvidence.voiceProvider!=='pass'||
  !object(candidate.sourceEvidence)||
  !DIGEST.test(candidate.sourceEvidence.staticDigestSha256??'')||
  !DIGEST.test(candidate.sourceEvidence.runtimeDigestSha256??'')||
  !DIGEST.test(candidate.sourceEvidence.ciDigestSha256??'')||
  candidate.releaseApproved!==false||candidate.deployExecuted!==false||
  candidate.rollbackExecuted!==false||candidate.physicalSafetyCertified!==false||
  !DIGEST.test(candidate.candidateDigestSha256??''))
  fail('RELEASE_CANDIDATE_INVALID');
 const checks=normalizedChecks(candidate.requiredHumanChecks);
 if(JSON.stringify(checks)!==JSON.stringify(candidate.requiredHumanChecks))
  fail('RELEASE_CANDIDATE_HUMAN_CHECK_ORDER_INVALID');
 const {candidateDigestSha256,...withoutDigest}=candidate;
 const {candidateId,...base}=withoutDigest;
 const expectedId='rc-'+sha256(base).slice(0,24);
 if(candidateId!==expectedId)
  fail('RELEASE_CANDIDATE_ID_MISMATCH');
 if(sha256(withoutDigest)!==candidateDigestSha256)
  fail('RELEASE_CANDIDATE_DIGEST_MISMATCH');
 if(expectedCommit!==null&&candidate.commitSha!==expectedCommit)
  fail('RELEASE_CANDIDATE_COMMIT_MISMATCH');
 return true;
}

async function readBounded(path,max=512*1024){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>max)
  fail('RELEASE_CANDIDATE_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
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
 if(mode==='create'){
  if(args.length!==4)
   fail('RELEASE_CANDIDATE_USAGE: create <static.json> <runtime.json> <ci.json> <candidate.json>');
  const [staticReadiness,runtimeGate,ciEvidence]=await Promise.all([
   readBounded(resolve(args[0])),readBounded(resolve(args[1])),
   readBounded(resolve(args[2]))
  ]);
  const matrix=composeReleaseReadinessMatrix({
   staticReadiness,runtimeGate,ciEvidence
  });
  const candidate=createReleaseCandidate(matrix,{
   sourceEvidence:{
    staticDigestSha256:sha256(staticReadiness),
    runtimeDigestSha256:sha256(runtimeGate),
    ciDigestSha256:sha256(ciEvidence)
   }
  });
  verifyReleaseCandidate(candidate);
  await atomicWrite(resolve(args[3]),candidate);
  console.log('RELEASE_CANDIDATE_WRITTEN:'+candidate.candidateId+':'+candidate.commitSha);
  return;
 }
 if(mode==='verify'){
  if(args.length<1||args.length>2)
   fail('RELEASE_CANDIDATE_USAGE: verify <candidate.json> [commit-sha]');
  const candidate=await readBounded(resolve(args[0]));
  verifyReleaseCandidate(candidate,{expectedCommit:args[1]??null});
  console.log('RELEASE_CANDIDATE_VERIFIED:'+candidate.candidateId+':'+candidate.commitSha);
  return;
 }
 fail('RELEASE_CANDIDATE_USAGE: create|verify');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
