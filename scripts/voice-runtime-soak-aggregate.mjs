#!/usr/bin/env node
// R81：R80 segmented Soak campaign 汇总与完整性校验。
import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyVoiceRuntimeSoakReport} from './voice-runtime-soak.mjs';

export const VOICE_SOAK_CAMPAIGN_SCHEMA='alex.dev/voice-runtime-soak-campaign/v1';
const SHA=/^[0-9a-f]{40}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export const voiceSoakDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');
async function readBounded(path,max=512*1024){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>max)fail('VOICE_SOAK_CAMPAIGN_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}
async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temp,path);}
 finally{try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}}
}
function aggregateSegments(segments){
 return segments.reduce((a,s)=>{
  a.hours+=s.hours;a.started+=s.turns.started;a.completed+=s.turns.completed;
  a.failed+=s.turns.failed;a.cancelled+=s.turns.cancelled;
  a.recoveryAttempts+=s.recovery.attempts;a.recoverySuccess+=s.recovery.success;
  return a;
 },{hours:0,started:0,completed:0,failed:0,cancelled:0,recoveryAttempts:0,recoverySuccess:0});
}
export function createVoiceSoakCampaign(reports,{targetHours,createdAt=new Date().toISOString()}={}){
 if(![8,24,72].includes(targetHours))fail('VOICE_SOAK_CAMPAIGN_TARGET_INVALID');
 if(!Array.isArray(reports)||!reports.length||reports.length>64)fail('VOICE_SOAK_CAMPAIGN_SEGMENTS_INVALID');
 if(typeof createdAt!=='string'||Number.isNaN(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt)
  fail('VOICE_SOAK_CAMPAIGN_CREATED_AT_INVALID');
 const runIds=new Set(),digests=new Set();let commit=null;const segments=[];
 for(const report of reports){
  verifyVoiceRuntimeSoakReport(report,{minHours:1});
  if(report.requestedHours>4)fail('VOICE_SOAK_CAMPAIGN_SEGMENT_TOO_LONG');
  if(commit===null)commit=report.context.commitSha;
  if(report.context.commitSha!==commit)fail('VOICE_SOAK_CAMPAIGN_COMMIT_MISMATCH');
  if(runIds.has(report.context.runId))fail('VOICE_SOAK_CAMPAIGN_RUN_REUSED');
  const reportDigestSha256=voiceSoakDigest(report);
  if(digests.has(reportDigestSha256))fail('VOICE_SOAK_CAMPAIGN_SEGMENT_REUSED');
  runIds.add(report.context.runId);digests.add(reportDigestSha256);
  segments.push({runId:report.context.runId,attempt:report.context.attempt,commitSha:report.context.commitSha,
   hours:report.requestedHours,durationObservedMs:report.durationObservedMs,reportDigestSha256,
   turns:{started:report.turns.started,completed:report.turns.completed,failed:report.turns.failed,cancelled:report.turns.cancelled},
   recovery:{attempts:report.recovery.attempts,success:report.recovery.success}});
 }
 const totals=aggregateSegments(segments);
 if(totals.hours<targetHours)fail('VOICE_SOAK_CAMPAIGN_DURATION_INSUFFICIENT');
 const successRate=totals.started?Math.round(totals.completed/totals.started*100000)/1000:0;
 if(successRate<95)fail('VOICE_SOAK_CAMPAIGN_SUCCESS_RATE_TOO_LOW');
 const base={schema:VOICE_SOAK_CAMPAIGN_SCHEMA,status:'verified-segmented',targetHours,
  accumulatedHours:totals.hours,commitSha:commit,createdAt,
  semantics:'segmented-self-hosted-runs-not-single-process-continuity',segments,
  turns:{started:totals.started,completed:totals.completed,failed:totals.failed,cancelled:totals.cancelled,successRate},
  recovery:{attempts:totals.recoveryAttempts,success:totals.recoverySuccess},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,credentialsStored:false},
  releaseApproved:false,physicalSafetyCertified:false};
 return {...base,campaignDigestSha256:voiceSoakDigest(base)};
}
export function verifyVoiceSoakCampaign(campaign,{expectedCommit=null,minTargetHours=null}={}){
 if(!object(campaign)||campaign.schema!==VOICE_SOAK_CAMPAIGN_SCHEMA||campaign.status!=='verified-segmented'||
  ![8,24,72].includes(campaign.targetHours)||!Number.isFinite(campaign.accumulatedHours)||
  !SHA.test(campaign.commitSha??'')||typeof campaign.createdAt!=='string'||
  Number.isNaN(Date.parse(campaign.createdAt))||new Date(campaign.createdAt).toISOString()!==campaign.createdAt||
  campaign.semantics!=='segmented-self-hosted-runs-not-single-process-continuity'||
  !Array.isArray(campaign.segments)||!campaign.segments.length||!object(campaign.turns)||
  campaign.privacy?.rawAudioStored!==false||campaign.privacy?.transcriptStored!==false||
  campaign.privacy?.responseTextStored!==false||campaign.privacy?.credentialsStored!==false||
  campaign.releaseApproved!==false||campaign.physicalSafetyCertified!==false||!HASH.test(campaign.campaignDigestSha256??''))
  fail('VOICE_SOAK_CAMPAIGN_INVALID');
 if(expectedCommit!==null&&campaign.commitSha!==expectedCommit)fail('VOICE_SOAK_CAMPAIGN_COMMIT_MISMATCH');
 if(minTargetHours!==null&&campaign.targetHours<minTargetHours)fail('VOICE_SOAK_CAMPAIGN_TARGET_TOO_SMALL');
 const ids=new Set(),hashes=new Set();
 for(const s of campaign.segments){
  if(!object(s)||typeof s.runId!=='string'||!s.runId||!Number.isInteger(s.attempt)||s.attempt<1||
   s.commitSha!==campaign.commitSha||!Number.isFinite(s.hours)||s.hours<=0||s.hours>4||
   !Number.isFinite(s.durationObservedMs)||s.durationObservedMs<s.hours*3600000||
   !HASH.test(s.reportDigestSha256??'')||!object(s.turns)||!object(s.recovery)||
   !Number.isInteger(s.turns.started)||s.turns.started<1||
   !Number.isInteger(s.turns.completed)||s.turns.completed<0||
   !Number.isInteger(s.turns.failed)||s.turns.failed<0||
   !Number.isInteger(s.turns.cancelled)||s.turns.cancelled<0||
   s.turns.started!==s.turns.completed+s.turns.failed+s.turns.cancelled||
   !Number.isInteger(s.recovery.attempts)||s.recovery.attempts<0||
   !Number.isInteger(s.recovery.success)||s.recovery.success<0||s.recovery.success>s.recovery.attempts)
   fail('VOICE_SOAK_CAMPAIGN_SEGMENT_INVALID');
  if(ids.has(s.runId)||hashes.has(s.reportDigestSha256))fail('VOICE_SOAK_CAMPAIGN_SEGMENT_REUSED');
  ids.add(s.runId);hashes.add(s.reportDigestSha256);
 }
 const totals=aggregateSegments(campaign.segments);
 const successRate=totals.started?Math.round(totals.completed/totals.started*100000)/1000:0;
 if(Math.abs(totals.hours-campaign.accumulatedHours)>1e-9||totals.hours<campaign.targetHours||
  campaign.turns.started!==totals.started||campaign.turns.completed!==totals.completed||
  campaign.turns.failed!==totals.failed||campaign.turns.cancelled!==totals.cancelled||
  campaign.turns.successRate!==successRate||successRate<95||
  campaign.recovery?.attempts!==totals.recoveryAttempts||campaign.recovery?.success!==totals.recoverySuccess)
  fail('VOICE_SOAK_CAMPAIGN_TOTALS_MISMATCH');
 const {campaignDigestSha256,...base}=campaign;
 if(voiceSoakDigest(base)!==campaignDigestSha256)fail('VOICE_SOAK_CAMPAIGN_DIGEST_MISMATCH');
 return true;
}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='create'){
  let target=null,out=null;const files=[];
  for(let i=0;i<args.length;){if(args[i]==='--target-hours'){target=Number(args[i+1]);i+=2;}
   else if(args[i]==='--out'){out=args[i+1];i+=2;}else{files.push(args[i]);i++;}}
  if(!out||!files.length)fail('VOICE_SOAK_CAMPAIGN_USAGE');
  const reports=await Promise.all(files.map(x=>readBounded(resolve(x))));
  const campaign=createVoiceSoakCampaign(reports,{targetHours:target});verifyVoiceSoakCampaign(campaign);
  await atomicWrite(resolve(out),campaign);console.log('VOICE_SOAK_CAMPAIGN_WRITTEN:'+campaign.targetHours+':'+campaign.segments.length);return;
 }
 if(mode==='verify'){
  let path=null,commit=null,min=null;
  for(let i=0;i<args.length;i+=2){if(args[i]==='--report')path=args[i+1];else if(args[i]==='--commit')commit=args[i+1];
   else if(args[i]==='--min-target-hours')min=Number(args[i+1]);else fail('VOICE_SOAK_CAMPAIGN_USAGE');}
  if(!path)fail('VOICE_SOAK_CAMPAIGN_USAGE');
  const campaign=await readBounded(resolve(path));verifyVoiceSoakCampaign(campaign,{expectedCommit:commit,minTargetHours:min});
  console.log('VOICE_SOAK_CAMPAIGN_VERIFIED:'+campaign.targetHours+':'+campaign.segments.length);return;
 }
 fail('VOICE_SOAK_CAMPAIGN_USAGE');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
