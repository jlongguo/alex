#!/usr/bin/env node
// R80：真实 Full Voice Turn 长时 Soak / 故障恢复验收。
// 每轮复用 R78 的真实物理语音链；只保存计数、错误码、时延与进程资源，不保存音频/转录/回复。
import {readdir,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runFullVoiceTurnAcceptance} from './full-voice-turn-acceptance.mjs';
import {classifyVoiceRuntimeFault} from './voice-runtime-fault-policy.mjs';

export const VOICE_SOAK_SCHEMA='alex.dev/voice-runtime-soak/v1';
const SHA=/^[0-9a-f]{40}$/;
const RUN=/^[1-9][0-9]{0,19}$/;
const fail=code=>{throw Error(code);};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const q=(arr,p)=>arr.length?[...arr].sort((a,b)=>a-b)[Math.max(0,Math.ceil(arr.length*p)-1)]:null;
const safeInt=(v,min,max,code)=>{
 const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)fail(code);return n;
};

function actionContext(env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'
  ||env.RUNNER_ENVIRONMENT!=='self-hosted'||env.GITHUB_JOB!=='voice-soak'
  ||env.ALEX_VOICE_SOAK_APPROVED!=='true'||!RUN.test(env.GITHUB_RUN_ID??'')
  ||!SHA.test(env.GITHUB_SHA??''))fail('VOICE_SOAK_SELF_HOSTED_CONTEXT_REQUIRED');
 return {source:'github-actions-self-hosted',job:'voice-soak',
  runId:env.GITHUB_RUN_ID,attempt:safeInt(env.GITHUB_RUN_ATTEMPT,1,10000,'VOICE_SOAK_ATTEMPT_INVALID'),
  commitSha:env.GITHUB_SHA};
}
async function fdCount(){
 if(process.platform!=='linux')return null;
 try{return (await readdir('/proc/self/fd')).length;}catch{return null;}
}
async function resources(){
 const m=process.memoryUsage();
 return {rssBytes:m.rss,heapUsedBytes:m.heapUsed,fdCount:await fdCount()};
}
function peaks(current,point){
 for(const key of ['rssBytes','heapUsedBytes','fdCount']){
  if(point[key]===null)continue;
  current[key]=Math.max(current[key]??0,point[key]);
 }
}
function summarizeLatency(values){
 return {count:values.length,p50Ms:q(values,0.50),p95Ms:q(values,0.95),p99Ms:q(values,0.99),
  maxMs:values.length?Math.max(...values):null};
}
async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  await rename(temp,path);}
 finally{try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}}
}

export async function runVoiceRuntimeSoak({
 env=process.env,hours=8,intervalMs=15000,maxTurns=20000,maxConsecutiveFailures=5,
 reportPath='.local/voice/soak/report.json',turnRunner=null,
 now=()=>Date.now(),sleepFn=sleep,resourceFn=resources
}={}){
 const injected=turnRunner!==null;
 if(injected&&env.ALEX_VOICE_SOAK_TEST_MODE!=='1')fail('VOICE_SOAK_TEST_MODE_REQUIRED');
 if(!Number.isFinite(hours)||hours<=0||hours>72)fail('VOICE_SOAK_HOURS_INVALID');
 intervalMs=safeInt(intervalMs,0,300000,'VOICE_SOAK_INTERVAL_INVALID');
 maxTurns=safeInt(maxTurns,1,20000,'VOICE_SOAK_MAX_TURNS_INVALID');
 maxConsecutiveFailures=safeInt(maxConsecutiveFailures,1,50,'VOICE_SOAK_FAILURE_LIMIT_INVALID');
 const context=injected?{source:'injected-test',job:'voice-soak',runId:'1',attempt:1,commitSha:'0'.repeat(40)}
  :actionContext(env);
 const durationMs=Math.round(hours*3600000),startedAt=now(),deadline=startedAt+durationMs;
 const startResource=await resourceFn(),peak={...startResource};
 const latency=[],errors={},categories={},turns=[];
 let started=0,completed=0,failed=0,cancelled=0,recoveryAttempts=0,recoverySuccess=0;
 let consecutiveFailures=0,previousFailure=false,stopReason='duration-complete';
 const runner=turnRunner??(async({index})=>{
   const path=resolve('.local/voice/soak/turn-'+String(index).padStart(6,'0')+'.json');
   return runFullVoiceTurnAcceptance({env,reportPath:path});
 });
 while(now()<deadline&&started<maxTurns){
  const index=started++;const turnStart=now();let outcome='passed',fault=null;
  try{
   const result=await runner({index,signal:null});
   const total=Number(result?.latency?.totalTurnMs??Math.max(0,now()-turnStart));
   if(!Number.isFinite(total)||total<0||total>180000)fail('VOICE_SOAK_TURN_LATENCY_INVALID');
   latency.push(Math.round(total));completed++;consecutiveFailures=0;
   if(previousFailure){recoverySuccess++;previousFailure=false;}
  }catch(error){
   fault=classifyVoiceRuntimeFault(error);
   outcome=fault.category==='cancelled'?'cancelled':'failed';
   if(outcome==='cancelled')cancelled++;else failed++;
   errors[fault.code]=(errors[fault.code]??0)+1;
   categories[fault.category]=(categories[fault.category]??0)+1;
   previousFailure=true;recoveryAttempts++;
   consecutiveFailures++;
   if(!fault.continueSoak){stopReason='non-recoverable-fault';}
   else if(consecutiveFailures>=maxConsecutiveFailures)stopReason='consecutive-failure-limit';
  }
  const point=await resourceFn();peaks(peak,point);
  turns.push({index,outcome,elapsedMs:Math.max(0,now()-turnStart),
   ...(fault?{faultCode:fault.code,faultCategory:fault.category}:{})});
  if(turns.length>256)turns.shift();
  if(stopReason!=='duration-complete')break;
  const remaining=deadline-now();
  if(remaining>0&&intervalMs>0)await sleepFn(Math.min(intervalMs,remaining));
 }
 if(started>=maxTurns&&now()<deadline)stopReason='max-turns-reached';
 const endResource=await resourceFn();
 const report={
  schema:VOICE_SOAK_SCHEMA,status:stopReason==='duration-complete'?'passed':'stopped',
  context,requestedHours:hours,durationObservedMs:Math.max(0,now()-startedAt),
  stopReason,turns:{started,completed,failed,cancelled,
   successRate:started?Math.round(completed/started*100000)/1000:0,
   recent:turns},
  recovery:{attempts:recoveryAttempts,success:recoverySuccess,
   consecutiveFailuresAtEnd:consecutiveFailures},
  faults:{byCode:errors,byCategory:categories},
  latency:{totalTurn:summarizeLatency(latency)},
  resources:{start:startResource,peak,end:endResource,
   rssGrowthBytes:endResource.rssBytes-startResource.rssBytes,
   heapGrowthBytes:endResource.heapUsedBytes-startResource.heapUsedBytes,
   fdGrowth:endResource.fdCount===null||startResource.fdCount===null?null:
    endResource.fdCount-startResource.fdCount},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,
   credentialsStored:false},
  releaseApproved:false,physicalSafetyCertified:false
 };
 await atomicWrite(resolve(reportPath),report);
 if(report.status!=='passed')throw Object.assign(Error('VOICE_SOAK_STOPPED_'+stopReason.toUpperCase().replaceAll('-','_')),{report});
 return report;
}

export function verifyVoiceRuntimeSoakReport(report,{expectedRunId=null,expectedCommit=null,minHours=8}={}){
 if(!report||report.schema!==VOICE_SOAK_SCHEMA||report.status!=='passed'
  ||report.context?.source!=='github-actions-self-hosted'||report.context?.job!=='voice-soak'
  ||!RUN.test(report.context.runId??'')||!SHA.test(report.context.commitSha??'')
  ||!Number.isInteger(report.context.attempt)||report.context.attempt<1
  ||!Number.isFinite(report.requestedHours)||report.requestedHours<minHours||report.requestedHours>72
  ||report.stopReason!=='duration-complete'||!report.turns||report.turns.started<1
  ||report.turns.completed<1||report.turns.failed<0||report.turns.cancelled<0
  ||report.turns.started!==report.turns.completed+report.turns.failed+report.turns.cancelled
  ||report.recovery?.consecutiveFailuresAtEnd!==0
  ||report.privacy?.rawAudioStored!==false||report.privacy?.transcriptStored!==false
  ||report.privacy?.responseTextStored!==false||report.privacy?.credentialsStored!==false
  ||report.releaseApproved!==false||report.physicalSafetyCertified!==false)
  fail('VOICE_SOAK_REPORT_INVALID');
 if(expectedRunId!==null&&report.context.runId!==expectedRunId)fail('VOICE_SOAK_RUN_MISMATCH');
 if(expectedCommit!==null&&report.context.commitSha!==expectedCommit)fail('VOICE_SOAK_COMMIT_MISMATCH');
 const r=report.resources;
 if(!r||r.rssGrowthBytes>256*1024*1024||r.heapGrowthBytes>128*1024*1024
  ||(r.fdGrowth!==null&&r.fdGrowth>32))fail('VOICE_SOAK_RESOURCE_GROWTH_EXCEEDED');
 if(report.turns.successRate<95)fail('VOICE_SOAK_SUCCESS_RATE_TOO_LOW');
 return true;
}

async function readJson(path){
 const raw=await readFile(path,'utf8');if(raw.length>512*1024)fail('VOICE_SOAK_REPORT_FILE_INVALID');
 return JSON.parse(raw);
}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='run'){
  const opts={};
  for(let i=0;i<args.length;i+=2){
   const k=args[i],v=args[i+1];
   if(k==='--hours')opts.hours=Number(v);
   else if(k==='--interval-ms')opts.intervalMs=Number(v);
   else if(k==='--report')opts.reportPath=v;
   else fail('VOICE_SOAK_USAGE');
  }
  const report=await runVoiceRuntimeSoak(opts);
  console.log('VOICE_SOAK_VERIFIED:'+report.context.runId+':'+report.turns.completed);
  return;
 }
 if(mode==='verify'){
  let path=null,runId=null,commit=null,minHours=8;
  for(let i=0;i<args.length;i+=2){
   if(args[i]==='--report')path=args[i+1];
   else if(args[i]==='--run-id')runId=args[i+1];
   else if(args[i]==='--commit')commit=args[i+1];
   else if(args[i]==='--min-hours')minHours=Number(args[i+1]);
   else fail('VOICE_SOAK_USAGE');
  }
  if(!path)fail('VOICE_SOAK_USAGE');
  verifyVoiceRuntimeSoakReport(await readJson(resolve(path)),{expectedRunId:runId,expectedCommit:commit,minHours});
  console.log('VOICE_SOAK_REPORT_VERIFIED:'+runId);
  return;
 }
 fail('VOICE_SOAK_USAGE');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
