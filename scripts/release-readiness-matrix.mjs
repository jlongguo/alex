#!/usr/bin/env node
// R71 发布就绪矩阵：把 R42 静态条件、R55+ Runtime Gate 与 R70 CI 证据投影到同一状态模型。
// 该层不重新验证 ROS/Voice 原始证据，也绝不授予发布许可；原始 verifier 仍是事实来源。
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyCiEvidence} from './ci-evidence.mjs';

export const MATRIX_SCHEMA='alex.dev/release-readiness-matrix/v1';
const STATIC_SCHEMA='alex.dev/release-readiness/v1';
const RUNTIME_SCHEMA='alex.dev/runtime-acceptance-gate/v1';
const SHA=/^[0-9a-f]{40}$/;
const DIGITS=/^[1-9][0-9]{0,19}$/;

const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const domain=(status,evidenceLevel,detail)=>({status,evidenceLevel,detail});

function verifyStatic(report){
 if(!object(report))fail('READINESS_MATRIX_STATIC_OBJECT_INVALID');
 if(report.schemaVersion!==STATIC_SCHEMA)
  fail('READINESS_MATRIX_STATIC_SCHEMA_INVALID');
 if(!['blocked','manual-validation-required','checks-complete'].includes(report.status))
  fail('READINESS_MATRIX_STATIC_STATUS_INVALID');
 if(!Array.isArray(report.blockers)||!Array.isArray(report.manual)||
  !Array.isArray(report.checks))
  fail('READINESS_MATRIX_STATIC_LISTS_INVALID');
 if(report.readOnly!==true)fail('READINESS_MATRIX_STATIC_READ_ONLY_INVALID');
 if(report.executable!==false)fail('READINESS_MATRIX_STATIC_EXECUTABLE_INVALID');
 if(report.releaseApproved!==false)fail('READINESS_MATRIX_STATIC_APPROVAL_INVALID');
 if(!object(report.robotCandidate))
  fail('READINESS_MATRIX_STATIC_ROBOT_CANDIDATE_INVALID');
 if(report.robotCandidate.physicalSafetyCertified!==false)
  fail('READINESS_MATRIX_STATIC_PHYSICAL_SAFETY_INVALID');
 return report;
}
const runtimeStatus=value=>['not_run','verified','verified-by-set','verified-coherent',
 'verified-injected','verified-metadata','invalid'].includes(value);
function verifyRuntime(report){
 if(!object(report)||report.schema!==RUNTIME_SCHEMA||report.read_only!==true||
  report.release_approved!==false||report.physical_safety_certified!==false||
  !Array.isArray(report.remaining)||!object(report.subjects)||
  !Object.hasOwn(report.subjects,'ros')||!Object.hasOwn(report.subjects,'voice'))
  fail('READINESS_MATRIX_RUNTIME_INVALID');
 const fields=[
  'ros_runtime','voice_real_provider','voice_workflow_evidence',
  'voice_artifact_attestation','voice_evidence_set','voice_github_readback',
  'nav2_fault_contract','ros_cancel_runtime','ros_recovery_runtime',
  'ros_bridge_runtime','ros_workflow_bundle','ros_artifact_attestation',
  'ros_evidence_set','ros_github_readback','ros_runner_provenance'
 ];
 if(fields.some(name=>!runtimeStatus(report[name])))
  fail('READINESS_MATRIX_RUNTIME_STATUS_INVALID');
 if(report.remaining.some(item=>typeof item!=='string'||!item))
  fail('READINESS_MATRIX_RUNTIME_REMAINING_INVALID');
 const validSubject=value=>value===null||(object(value)&&
  DIGITS.test(value.run_id??'')&&Number.isInteger(value.attempt)&&
  value.attempt>=1&&value.attempt<=10000&&SHA.test(value.commit_sha??''));
 if(!validSubject(report.subjects.ros)||!validSubject(report.subjects.voice))
  fail('READINESS_MATRIX_RUNTIME_SUBJECT_INVALID');
 return report;
}
function voiceState(runtime){
 if(!runtime)return domain('evidence-required','not-provided',
  '尚未提供 Runtime Gate 的真实 Voice coherent evidence set');
 const values=[
  runtime.voice_real_provider,runtime.voice_workflow_evidence,
  runtime.voice_artifact_attestation,runtime.voice_evidence_set,
  runtime.voice_github_readback
 ];
 if(values.some(value=>value==='invalid'))
  return domain('blocked','invalid','Voice 运行时证据存在严格验证失败');
 const complete=
  runtime.voice_real_provider==='verified-by-set'&&
  runtime.voice_workflow_evidence==='verified-by-set'&&
  runtime.voice_artifact_attestation==='verified-by-set'&&
  runtime.voice_evidence_set==='verified-coherent'&&
  runtime.voice_github_readback==='verified-by-set';
 return complete
  ?domain('pass','runtime-coherent','真实 Provider、Workflow、Artifact 与 GitHub readback 已由 Runtime Gate coherent set 验证')
  :domain('evidence-required','runtime-incomplete','尚未形成完整真实 Voice coherent evidence set');
}
function rosState(runtime){
 if(!runtime)return domain('evidence-required','not-provided',
  '尚未提供 Runtime Gate 的 ROS/Gazebo coherent evidence set');
 const fields=[
  'ros_runtime','ros_cancel_runtime','ros_recovery_runtime',
  'ros_bridge_runtime','ros_workflow_bundle','ros_artifact_attestation',
  'ros_evidence_set','ros_github_readback','ros_runner_provenance'
 ];
 const values=fields.map(name=>runtime[name]);
 if(values.some(value=>value==='invalid'))
  return domain('blocked','invalid','ROS/Gazebo 运行时证据存在严格验证失败');
 const complete=
  runtime.ros_runtime==='verified-by-set'&&
  runtime.ros_cancel_runtime==='verified-by-set'&&
  runtime.ros_recovery_runtime==='verified-by-set'&&
  runtime.ros_bridge_runtime==='verified-by-set'&&
  runtime.ros_workflow_bundle==='verified-by-set'&&
  runtime.ros_artifact_attestation==='verified-by-set'&&
  runtime.ros_evidence_set==='verified-coherent'&&
  runtime.ros_github_readback==='verified-by-set'&&
  runtime.ros_runner_provenance==='verified-by-set';
 return complete
  ?domain('pass','runtime-coherent','Gazebo/Nav2 路线、取消、恢复、Node-Python bridge、Runner provenance 与 Artifact 已 coherent 验证')
  :domain('evidence-required','runtime-incomplete','尚未形成完整 ROS/Gazebo coherent evidence set');
}
function ciState(ci){
 if(!ci)return domain('evidence-required','not-provided',
  '尚未提供当前 Commit 的标准 CI evidence summary');
 return ci.status==='verified'
  ?domain('pass','ci-current-run','当前 Commit 的 unit/browser/sim-static 三个独立 CI 域均成功')
  :domain('blocked','ci-current-run','当前 Commit 至少一个标准 CI 域失败、取消或跳过');
}
export function composeReleaseReadinessMatrix({
 staticReadiness,runtimeGate=null,ciEvidence=null
}={}){
 const stat=verifyStatic(staticReadiness);
 const runtime=runtimeGate===null?null:verifyRuntime(runtimeGate);
 const ci=ciEvidence===null?null:(verifyCiEvidence(ciEvidence),ciEvidence);

 let voice=voiceState(runtime);
 let ros=rosState(runtime);
 const voiceSubject=runtime?.subjects?.voice??null;
 const rosSubject=runtime?.subjects?.ros??null;
 if(voice.status==='pass'&&voiceSubject===null)
  voice=domain('blocked','runtime-subject-missing',
   'Voice coherent set 已标记通过，但 Runtime Gate 未保留 Run/Attempt/SHA 主体');
 if(ros.status==='pass'&&rosSubject===null)
  ros=domain('blocked','runtime-subject-missing',
   'ROS coherent set 已标记通过，但 Runtime Gate 未保留 Run/Attempt/SHA 主体');
 const runtimePairMismatch=voice.status==='pass'&&ros.status==='pass'&&
  voiceSubject.commit_sha!==rosSubject.commit_sha;
 if(runtimePairMismatch){
  voice=domain('blocked','commit-mismatch',
   'Voice 与 ROS runtime evidence 不属于同一 Commit');
  ros=domain('blocked','commit-mismatch',
   'ROS 与 Voice runtime evidence 不属于同一 Commit');
 }else{
  if(ci&&voice.status==='pass'&&voiceSubject.commit_sha!==ci.context.commitSha)
   voice=domain('blocked','commit-mismatch',
    'Voice runtime evidence 与当前 CI 不属于同一 Commit');
  if(ci&&ros.status==='pass'&&rosSubject.commit_sha!==ci.context.commitSha)
   ros=domain('blocked','commit-mismatch',
    'ROS runtime evidence 与当前 CI 不属于同一 Commit');
 }

 const domains={
  staticConfiguration:stat.status==='blocked'
   ?domain('blocked','local-static','R42 静态发布条件存在阻断项')
   :domain('pass','local-static','R42 静态配置与本地存储硬阻断已清除；人工项单独列出'),
  ci:ciState(ci),
  browserJourney:ci?.domains?.browser?.status==='pass'
   ?domain('pass','real-browser-synthetic-family','真实 Chromium 家庭流程已在合成家庭数据上执行')
   :ci
    ?domain('blocked','ci-current-run','真实 Chromium 家庭流程当前 CI 未通过')
    :domain('evidence-required','not-provided','尚未提供当前 Commit 的 Browser CI 证据'),
  voiceProvider:voice,
  rosSimulation:ros,
  realAcousticIo:domain('manual-required','not-modeled',
   '现有 Voice Provider 验收使用 synthetic provider TTS 种子，不证明真实麦克风采集与扬声器播放'),
  realChildJourney:domain('manual-required','human-required',
   '真实儿童/家庭用户旅程不能由 CI 合成家庭数据自动替代'),
  recoveryDrill:domain(
   stat.manual.includes('DATA_RECOVERY_DRILL')?'manual-required':'pass',
   stat.manual.includes('DATA_RECOVERY_DRILL')?'human-required':'legacy-readiness-flag',
   stat.manual.includes('DATA_RECOVERY_DRILL')
    ?'真实备份恢复、异常退出与迁移演练仍需独立验收'
    :'R42 输入声明恢复演练已完成；矩阵本身不重新执行恢复'),
  physicalSafety:domain('manual-required','hardware-required',
   '实体机器人急停、限速、碰撞与儿童环境安全尚需真实硬件验收')
 };

 const blockers=Object.entries(domains)
  .filter(([,value])=>value.status==='blocked').map(([key])=>key);
 const evidenceRequired=Object.entries(domains)
  .filter(([,value])=>value.status==='evidence-required').map(([key])=>key);
 const manual=Object.entries(domains)
  .filter(([,value])=>value.status==='manual-required').map(([key])=>key);

 const softwareBlocking=new Set([
  'staticConfiguration','ci','browserJourney','voiceProvider'
 ]);
 const softwareBlockers=blockers.filter(id=>softwareBlocking.has(id));
 const softwareEvidence=evidenceRequired.filter(id=>softwareBlocking.has(id));
 const softwareManual=manual.filter(id=>
  ['realAcousticIo','realChildJourney','recoveryDrill'].includes(id));
 const softwareStatus=softwareBlockers.length?'blocked':
  softwareEvidence.length?'evidence-required':
  softwareManual.length?'manual-release-review':'checks-complete';

 const robotBlockers=[...softwareBlockers,
  ...blockers.filter(id=>id==='rosSimulation')];
 const robotEvidence=[...softwareEvidence,
  ...evidenceRequired.filter(id=>id==='rosSimulation')];
 const robotStatus=robotBlockers.length?'blocked':
  robotEvidence.length?'evidence-required':'manual-release-review';

 return {
  schema:MATRIX_SCHEMA,
  status:blockers.length?'blocked':
   evidenceRequired.length?'evidence-required':'manual-release-review',
  source:'readiness-projection',
  readOnly:true,
  executable:false,
  releaseApproved:false,
  physicalSafetyCertified:false,
  inputs:{
   staticSchema:stat.schemaVersion,
   runtimeSchema:runtime?.schema??null,
   ciSchema:ci?.schema??null,
   runtimeProvided:runtime!==null,
   ciProvided:ci!==null,
   subjects:{
    ciCommit:ci?.context?.commitSha??null,
    voice:voiceSubject,
    ros:rosSubject
   }
  },
  domains,blockers,evidenceRequired,manual,
  targets:{
   softwarePilot:{
    status:softwareStatus,
    blockers:softwareBlockers,
    evidenceRequired:softwareEvidence,
    manual:softwareManual,
    releaseApproved:false
   },
   robotCandidate:{
    status:robotStatus,
    blockers:robotBlockers,
    evidenceRequired:robotEvidence,
    manual:[...new Set([...softwareManual,'physicalSafety'])],
    physicalSafetyCertified:false,
    releaseApproved:false
   }
  },
  note:'矩阵只聚合既有验证器输出；CI/静态通过不能替代真实运行、人工验收、物理安全或发布审批'
 };
}
export function verifyReleaseReadinessMatrix(matrix){
 if(!object(matrix)||matrix.schema!==MATRIX_SCHEMA||
  matrix.source!=='readiness-projection'||matrix.readOnly!==true||
  matrix.executable!==false||matrix.releaseApproved!==false||
  matrix.physicalSafetyCertified!==false)
  fail('READINESS_MATRIX_REPORT_INVALID');
 if(!['blocked','evidence-required','manual-release-review'].includes(matrix.status)||
  !object(matrix.inputs)||!object(matrix.inputs.subjects)||
  !object(matrix.domains)||!object(matrix.targets)||
  !Array.isArray(matrix.blockers)||!Array.isArray(matrix.evidenceRequired)||
  !Array.isArray(matrix.manual))
  fail('READINESS_MATRIX_REPORT_SHAPE_INVALID');
 const names=[
  'staticConfiguration','ci','browserJourney','voiceProvider','rosSimulation',
  'realAcousticIo','realChildJourney','recoveryDrill','physicalSafety'
 ];
 if(Object.keys(matrix.domains).sort().join(',')!==[...names].sort().join(','))
  fail('READINESS_MATRIX_DOMAIN_SET_INVALID');
 for(const name of names){
  const item=matrix.domains[name];
  if(!object(item)||!['pass','blocked','evidence-required','manual-required'].includes(item.status)||
   typeof item.evidenceLevel!=='string'||!item.evidenceLevel||
   typeof item.detail!=='string'||!item.detail)
   fail('READINESS_MATRIX_DOMAIN_INVALID');
 }
 const derivedBlocked=names.filter(name=>matrix.domains[name].status==='blocked').sort();
 const derivedEvidence=names.filter(name=>matrix.domains[name].status==='evidence-required').sort();
 const derivedManual=names.filter(name=>matrix.domains[name].status==='manual-required').sort();
 if(JSON.stringify([...matrix.blockers].sort())!==JSON.stringify(derivedBlocked)||
  JSON.stringify([...matrix.evidenceRequired].sort())!==JSON.stringify(derivedEvidence)||
  JSON.stringify([...matrix.manual].sort())!==JSON.stringify(derivedManual))
  fail('READINESS_MATRIX_INDEX_INVALID');
 const overall=derivedBlocked.length?'blocked':
  derivedEvidence.length?'evidence-required':'manual-release-review';
 if(matrix.status!==overall)fail('READINESS_MATRIX_OVERALL_STATUS_INVALID');
 const subjects=matrix.inputs.subjects;
 const validCommit=value=>value===null||(typeof value==='string'&&SHA.test(value));
 if(!validCommit(subjects.ciCommit)||
  ![subjects.voice,subjects.ros].every(value=>value===null||
   (object(value)&&DIGITS.test(value.run_id??'')&&Number.isInteger(value.attempt)&&
    value.attempt>=1&&value.attempt<=10000&&SHA.test(value.commit_sha??''))))
  fail('READINESS_MATRIX_SUBJECTS_INVALID');
 if(matrix.domains.voiceProvider.status==='pass'&&!subjects.voice)
  fail('READINESS_MATRIX_VOICE_SUBJECT_REQUIRED');
 if(matrix.domains.rosSimulation.status==='pass'&&!subjects.ros)
  fail('READINESS_MATRIX_ROS_SUBJECT_REQUIRED');
 if(subjects.ciCommit&&subjects.voice&&matrix.domains.voiceProvider.status==='pass'&&
  subjects.voice.commit_sha!==subjects.ciCommit)
  fail('READINESS_MATRIX_VOICE_COMMIT_MISMATCH');
 if(subjects.ciCommit&&subjects.ros&&matrix.domains.rosSimulation.status==='pass'&&
  subjects.ros.commit_sha!==subjects.ciCommit)
  fail('READINESS_MATRIX_ROS_COMMIT_MISMATCH');
 const software=matrix.targets.softwarePilot,robot=matrix.targets.robotCandidate;
 if(!object(software)||!object(robot)||software.releaseApproved!==false||
  robot.releaseApproved!==false||robot.physicalSafetyCertified!==false||
  !Array.isArray(software.blockers)||!Array.isArray(software.evidenceRequired)||
  !Array.isArray(software.manual)||!Array.isArray(robot.blockers)||
  !Array.isArray(robot.evidenceRequired)||!Array.isArray(robot.manual))
  fail('READINESS_MATRIX_TARGET_INVALID');
 if(!['blocked','evidence-required','manual-release-review','checks-complete'].includes(software.status)||
  !['blocked','evidence-required','manual-release-review'].includes(robot.status))
  fail('READINESS_MATRIX_TARGET_STATUS_INVALID');
 return true;
}

async function readBounded(path,max=256*1024){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>max)
  fail('READINESS_MATRIX_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}
function parseArgs(args){
 const result={};
 for(let i=0;i<args.length;i+=2){
  const flag=args[i],value=args[i+1];
  if(!value||!['--static','--runtime','--ci'].includes(flag))
   fail('READINESS_MATRIX_USAGE: --static <json> [--runtime <json>] [--ci <json>]');
  result[flag.slice(2)]=value;
 }
 if(!result.static)fail('READINESS_MATRIX_STATIC_REQUIRED');
 return result;
}
async function main(){
 const args=parseArgs(process.argv.slice(2));
 const matrix=composeReleaseReadinessMatrix({
  staticReadiness:await readBounded(resolve(args.static)),
  runtimeGate:args.runtime?await readBounded(resolve(args.runtime)):null,
  ciEvidence:args.ci?await readBounded(resolve(args.ci)):null
 });
 console.log(JSON.stringify(matrix,null,2));
 if(matrix.status==='blocked')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=2;}
}
