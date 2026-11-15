#!/usr/bin/env node
// R71 标准 CI 证据汇总：只记录当前 GitHub Actions Run 的三个独立验证域结论。
// 不读取测试日志、仓库 Secret、用户数据，也不把静态/浏览器 CI 冒充 ROS/Voice 真实运行时验收。
import {mkdir,readFile,rename,writeFile,lstat,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const CI_EVIDENCE_SCHEMA='alex.dev/ci-evidence/v1';
const REPO='jlongguo/alex';
const JOB='evidence-summary';
const RESULT=new Set(['success','failure','cancelled','skipped']);
const SHA=/^[0-9a-f]{40}$/;
const DIGITS=/^[1-9][0-9]{0,19}$/;

const fail=code=>{throw Error(code);};
const validResult=value=>RESULT.has(value);
const contextFromEnv=env=>{
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
  env.GITHUB_JOB!==JOB||env.RUNNER_ENVIRONMENT!=='github-hosted')
  fail('CI_EVIDENCE_UNAPPROVED_CONTEXT');
 if(!['pull_request','push'].includes(env.GITHUB_EVENT_NAME))
  fail('CI_EVIDENCE_EVENT_INVALID');
 if(!DIGITS.test(env.GITHUB_RUN_ID??''))
  fail('CI_EVIDENCE_RUN_ID_INVALID');
 if(!/^[1-9][0-9]{0,4}$/.test(env.GITHUB_RUN_ATTEMPT??''))
  fail('CI_EVIDENCE_ATTEMPT_INVALID');
 if(!SHA.test(env.GITHUB_SHA??''))
  fail('CI_EVIDENCE_COMMIT_INVALID');
 if(env.RUNNER_OS!=='Linux'||env.RUNNER_ARCH!=='X64')
  fail('CI_EVIDENCE_RUNNER_INVALID');
 const jobs={
  test:env.ALEX_CI_TEST_RESULT,
  browser:env.ALEX_CI_BROWSER_RESULT,
  simStatic:env.ALEX_CI_SIM_STATIC_RESULT
 };
 if(!Object.values(jobs).every(validResult))
  fail('CI_EVIDENCE_JOB_RESULT_INVALID');
 return {
  repository:REPO,event:env.GITHUB_EVENT_NAME,
  workflow:'.github/workflows/ci.yml',
  job:JOB,runnerEnvironment:'github-hosted',
  runnerOs:'Linux',runnerArch:'X64',
  runId:env.GITHUB_RUN_ID,runAttempt:Number(env.GITHUB_RUN_ATTEMPT),
  commitSha:env.GITHUB_SHA,jobs
 };
};
export function createCiEvidence(env=process.env){
 const context=contextFromEnv(env);
 const allPassed=Object.values(context.jobs).every(value=>value==='success');
 return {
  schema:CI_EVIDENCE_SCHEMA,
  status:allPassed?'verified':'blocked',
  source:'github-actions-needs-results',
  readOnly:true,
  releaseApproved:false,
  runtimeAcceptance:false,
  physicalSafetyCertified:false,
  context,
  domains:{
   unit:{status:context.jobs.test==='success'?'pass':'blocked'},
   browser:{status:context.jobs.browser==='success'?'pass':'blocked',
    realEngine:true,productionDataUsed:false},
   rosStatic:{status:context.jobs.simStatic==='success'?'pass':'blocked',
    runtimeVerified:false}
  },
  note:'CI 结果只证明当前 Commit 的单元、真实 Chromium 和 ROS 静态检查，不证明 Gazebo/Voice/实体硬件运行时验收'
 };
}
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
export function verifyCiEvidence(value){
 if(!exactKeys(value,['schema','status','source','readOnly','releaseApproved',
  'runtimeAcceptance','physicalSafetyCertified','context','domains','note']))
  fail('CI_EVIDENCE_REPORT_SHAPE_INVALID');
 if(value.schema!==CI_EVIDENCE_SCHEMA||
  !['verified','blocked'].includes(value.status)||
  value.source!=='github-actions-needs-results'||value.readOnly!==true||
  value.releaseApproved!==false||value.runtimeAcceptance!==false||
  value.physicalSafetyCertified!==false)
  fail('CI_EVIDENCE_REPORT_INVALID');
 const c=value.context;
 if(!exactKeys(c,['repository','event','workflow','job','runnerEnvironment',
  'runnerOs','runnerArch','runId','runAttempt','commitSha','jobs'])||
  c.repository!==REPO||!['pull_request','push'].includes(c.event)||
  c.workflow!=='.github/workflows/ci.yml'||c.job!==JOB||
  c.runnerEnvironment!=='github-hosted'||c.runnerOs!=='Linux'||
  c.runnerArch!=='X64'||!DIGITS.test(c.runId??'')||
  !Number.isInteger(c.runAttempt)||c.runAttempt<1||c.runAttempt>99999||
  !SHA.test(c.commitSha??'')||
  !exactKeys(c.jobs,['test','browser','simStatic'])||
  !Object.values(c.jobs).every(validResult))
  fail('CI_EVIDENCE_CONTEXT_INVALID');
 const expected=Object.values(c.jobs).every(result=>result==='success')?'verified':'blocked';
 if(value.status!==expected)fail('CI_EVIDENCE_STATUS_MISMATCH');
 if(!exactKeys(value.domains,['unit','browser','rosStatic'])||
  value.domains.unit?.status!==(c.jobs.test==='success'?'pass':'blocked')||
  value.domains.browser?.status!==(c.jobs.browser==='success'?'pass':'blocked')||
  value.domains.browser?.realEngine!==true||
  value.domains.browser?.productionDataUsed!==false||
  value.domains.rosStatic?.status!==(c.jobs.simStatic==='success'?'pass':'blocked')||
  value.domains.rosStatic?.runtimeVerified!==false)
  fail('CI_EVIDENCE_DOMAINS_INVALID');
 return true;
}
async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});
  await rename(temp,path);
 }finally{try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}}
}
async function readBounded(path){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>64*1024)
  fail('CI_EVIDENCE_FILE_INVALID');
 const value=JSON.parse(await readFile(path,'utf8'));
 verifyCiEvidence(value);
 return value;
}
async function main(){
 const [mode,pathArg]=process.argv.slice(2);
 if(!['write','verify'].includes(mode)||!pathArg)
  fail('CI_EVIDENCE_USAGE: write|verify <path>');
 const path=resolve(pathArg);
 if(mode==='write'){
  const report=createCiEvidence();
  verifyCiEvidence(report);
  await atomicWrite(path,report);
  console.log('CI_EVIDENCE_WRITTEN:'+report.status+':'+report.context.runId);
 }else{
  const report=await readBounded(path);
  console.log('CI_EVIDENCE_VERIFIED:'+report.status+':'+report.context.runId);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
