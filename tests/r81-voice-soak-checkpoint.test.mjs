import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createVoiceSoakCheckpoint,appendVoiceSoakSegment,loadVoiceSoakCheckpoint} from '../scripts/voice-runtime-soak-checkpoint.mjs';
const SHA='a'.repeat(40);
function report(runId,hours=4){return {schema:'alex.dev/voice-runtime-soak/v1',status:'passed',
 context:{source:'github-actions-self-hosted',job:'voice-soak',runId,attempt:1,commitSha:SHA},
 requestedHours:hours,durationObservedMs:hours*3600000,stopReason:'duration-complete',
 turns:{started:100,completed:100,failed:0,cancelled:0,successRate:100,recent:[]},
 recovery:{attempts:0,success:0,consecutiveFailuresAtEnd:0},faults:{byCode:{},byCategory:{}},
 latency:{totalTurn:{count:100,p50Ms:10,p95Ms:20,p99Ms:30,maxMs:40}},
 resources:{start:{rssBytes:1000,heapUsedBytes:500,fdCount:10},peak:{rssBytes:1100,heapUsedBytes:600,fdCount:11},
 end:{rssBytes:1050,heapUsedBytes:550,fdCount:10},rssGrowthBytes:50,heapGrowthBytes:50,fdGrowth:0},
 privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,credentialsStored:false},
 releaseApproved:false,physicalSafetyCertified:false};}
test('R81 checkpoint 可追加 segment、重启读取并达到 campaign target',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r81-checkpoint-'));const path=join(dir,'campaign.json');
 try{
  await createVoiceSoakCheckpoint(path,{campaignId:'voice-soak-2026-11',targetHours:8,commitSha:SHA,createdAt:'2026-11-22T00:00:00.000Z'});
  let value=await appendVoiceSoakSegment(path,report('10001'));
  assert.equal(value.status,'in-progress');assert.equal(value.accumulatedHours,4);
  value=await appendVoiceSoakSegment(path,report('10002'));
  assert.equal(value.status,'ready-to-aggregate');assert.equal(value.accumulatedHours,8);
  const restored=await loadVoiceSoakCheckpoint(path);
  assert.equal(restored.segments.length,2);assert.equal(restored.turns.completed,200);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R81 checkpoint 拒绝重复 Run、错误 Commit 和伪造 totals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r81-checkpoint-'));const path=join(dir,'campaign.json');
 try{
  await createVoiceSoakCheckpoint(path,{campaignId:'voice-soak-2026-11',targetHours:8,commitSha:SHA,createdAt:'2026-11-22T00:00:00.000Z'});
  await appendVoiceSoakSegment(path,report('10001'));
  await assert.rejects(appendVoiceSoakSegment(path,report('10001')),/VOICE_SOAK_CHECKPOINT_RUN_REUSED/);
  await assert.rejects(appendVoiceSoakSegment(path,{...report('10002'),context:{...report('10002').context,commitSha:'b'.repeat(40)}}),/VOICE_SOAK_CHECKPOINT_COMMIT_MISMATCH/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R81 checkpoint rejects a tampered aggregate even when segment chain is stale',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r81-checkpoint-tamper-'));const path=join(dir,'campaign.json');
 try{
  await createVoiceSoakCheckpoint(path,{campaignId:'voice-soak-tamper',targetHours:8,commitSha:SHA,createdAt:'2026-11-22T00:00:00.000Z'});
  await appendVoiceSoakSegment(path,report('11001'));
  const {readFile,writeFile}=await import('node:fs/promises');
  const value=JSON.parse(await readFile(path,'utf8'));value.accumulatedHours=8;
  await writeFile(path,JSON.stringify(value));
  await assert.rejects(loadVoiceSoakCheckpoint(path),/VOICE_SOAK_CHECKPOINT_TOTALS_MISMATCH/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
