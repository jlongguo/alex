// R81：可恢复 Campaign checkpoint。checkpoint 只保存报告摘要，不保存音频、转录或 provider 凭据。
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyVoiceRuntimeSoakReport} from './voice-runtime-soak.mjs';
import {voiceSoakDigest} from './voice-runtime-soak-aggregate.mjs';

export const VOICE_SOAK_CHECKPOINT_SCHEMA='alex.dev/voice-runtime-soak-checkpoint/v1';
const SHA=/^[0-9a-f]{40}$/;
const fail=code=>{throw Error(code);};
async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temp,path);}
 finally{try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}}
}
async function read(path){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>256*1024)fail('VOICE_SOAK_CHECKPOINT_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}
function baseManifest({campaignId,targetHours,commitSha,createdAt}){
 if(typeof campaignId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(campaignId)||
  ![8,24,72].includes(targetHours)||!SHA.test(commitSha??'')||
  typeof createdAt!=='string'||Number.isNaN(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt)
  fail('VOICE_SOAK_CHECKPOINT_CONFIG_INVALID');
 return {schema:VOICE_SOAK_CHECKPOINT_SCHEMA,campaignId,targetHours,commitSha,createdAt,
  status:'in-progress',segments:[],accumulatedHours:0,turns:{started:0,completed:0,failed:0,cancelled:0},
  chainDigestSha256:voiceSoakDigest({campaignId,targetHours,commitSha,createdAt,segments:[]})};
}
export function verifyVoiceSoakCheckpoint(value){
 if(!value||value.schema!==VOICE_SOAK_CHECKPOINT_SCHEMA||!Array.isArray(value.segments)||
  !['in-progress','ready-to-aggregate'].includes(value.status))fail('VOICE_SOAK_CHECKPOINT_INVALID');
 const rebuilt=baseManifest({campaignId:value.campaignId,targetHours:value.targetHours,
  commitSha:value.commitSha,createdAt:value.createdAt});
 const seen=new Set();let hours=0,started=0,completed=0,failed=0,cancelled=0,chain=rebuilt.chainDigestSha256;
 for(const s of value.segments){
  if(!s||typeof s.runId!=='string'||!/^[1-9][0-9]{0,19}$/.test(s.runId)||
   !Number.isInteger(s.attempt)||s.attempt<1||s.commitSha!==value.commitSha||
   !Number.isFinite(s.hours)||s.hours<=0||s.hours>4||!SHA.test(s.reportDigestSha256??'')||
   !s.turns||!Number.isInteger(s.turns.started)||s.turns.started<1||
   !Number.isInteger(s.turns.completed)||s.turns.completed<0||
   !Number.isInteger(s.turns.failed)||s.turns.failed<0||
   !Number.isInteger(s.turns.cancelled)||s.turns.cancelled<0||
   s.turns.started!==s.turns.completed+s.turns.failed+s.turns.cancelled||seen.has(s.runId))fail('VOICE_SOAK_CHECKPOINT_SEGMENT_INVALID');
  seen.add(s.runId);hours+=s.hours;started+=s.turns.started;completed+=s.turns.completed;
  failed+=s.turns.failed;cancelled+=s.turns.cancelled;
  chain=voiceSoakDigest({previous:chain,segment:s});
 }
 if(Math.abs(hours-value.accumulatedHours)>1e-9||started!==value.turns.started||
  completed!==value.turns.completed||failed!==value.turns.failed||cancelled!==value.turns.cancelled||
  chain!==value.chainDigestSha256)fail('VOICE_SOAK_CHECKPOINT_TOTALS_MISMATCH');
 if(value.status==='ready-to-aggregate'&&hours<value.targetHours)fail('VOICE_SOAK_CHECKPOINT_NOT_READY');
 return true;
}
export async function createVoiceSoakCheckpoint(path,options){
 const manifest=baseManifest({...options,createdAt:options.createdAt??new Date().toISOString()});
 await atomicWrite(resolve(path),manifest);return manifest;
}
export async function appendVoiceSoakSegment(path,report){
 verifyVoiceRuntimeSoakReport(report,{minHours:1});
 if(report.requestedHours>4)fail('VOICE_SOAK_CHECKPOINT_SEGMENT_TOO_LONG');
 const manifest=await read(resolve(path));verifyVoiceSoakCheckpoint(manifest);
 if(report.context.commitSha!==manifest.commitSha)fail('VOICE_SOAK_CHECKPOINT_COMMIT_MISMATCH');
 if(manifest.segments.some(s=>s.runId===report.context.runId))fail('VOICE_SOAK_CHECKPOINT_RUN_REUSED');
 const segment={runId:report.context.runId,attempt:report.context.attempt,commitSha:report.context.commitSha,
  hours:report.requestedHours,reportDigestSha256:voiceSoakDigest(report),
  turns:{started:report.turns.started,completed:report.turns.completed,failed:report.turns.failed,cancelled:report.turns.cancelled}};
 const next={...manifest,segments:[...manifest.segments,segment],
  accumulatedHours:manifest.accumulatedHours+segment.hours,
  turns:{started:manifest.turns.started+segment.turns.started,completed:manifest.turns.completed+segment.turns.completed,
   failed:manifest.turns.failed+segment.turns.failed,cancelled:manifest.turns.cancelled+segment.turns.cancelled}};
 const chain=voiceSoakDigest({previous:manifest.chainDigestSha256,segment});
 next.chainDigestSha256=chain;
 if(next.accumulatedHours>=next.targetHours)next.status='ready-to-aggregate';
 verifyVoiceSoakCheckpoint(next);await atomicWrite(resolve(path),next);return next;
}
export async function loadVoiceSoakCheckpoint(path){const value=await read(resolve(path));verifyVoiceSoakCheckpoint(value);return value;}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='create'){
  if(args.length!==8||args[0]!=='--file'||args[2]!=='--campaign'||args[4]!=='--hours'||args[6]!=='--commit')
   fail('VOICE_SOAK_CHECKPOINT_USAGE');
  const value=await createVoiceSoakCheckpoint(args[1],{campaignId:args[3],targetHours:Number(args[5]),commitSha:args[7]});
  console.log('VOICE_SOAK_CHECKPOINT_CREATED:'+value.campaignId);return;
 }
 if(mode==='append'){
  if(args.length!==4||args[0]!=='--file'||args[2]!=='--report')fail('VOICE_SOAK_CHECKPOINT_USAGE');
  const report=await read(args[3]);
  const value=await appendVoiceSoakSegment(args[1],report);
  console.log('VOICE_SOAK_CHECKPOINT_APPENDED:'+value.status+':'+value.accumulatedHours);return;
 }
 if(mode==='verify'){
  if(args.length!==2||args[0]!=='--file')fail('VOICE_SOAK_CHECKPOINT_USAGE');
  const value=await loadVoiceSoakCheckpoint(args[1]);
  console.log('VOICE_SOAK_CHECKPOINT_VERIFIED:'+value.status+':'+value.accumulatedHours);return;
 }
 fail('VOICE_SOAK_CHECKPOINT_USAGE');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
