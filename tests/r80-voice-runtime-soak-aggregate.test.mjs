import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceSoakCampaign,verifyVoiceSoakCampaign} from '../scripts/voice-runtime-soak-aggregate.mjs';

const SHA='a'.repeat(40);
function segment(runId,hours=4,{commit=SHA,completed=100,failed=0}={}){
 return {
  schema:'alex.dev/voice-runtime-soak/v1',status:'passed',
  context:{source:'github-actions-self-hosted',job:'voice-soak',runId,attempt:1,commitSha:commit},
  requestedHours:hours,durationObservedMs:hours*3600000,stopReason:'duration-complete',
  turns:{started:completed+failed,completed,failed,cancelled:0,
   successRate:Math.round(completed/(completed+failed)*100000)/1000,recent:[]},
  recovery:{attempts:failed,success:failed,consecutiveFailuresAtEnd:0},
  faults:{byCode:{},byCategory:{}},
  latency:{totalTurn:{count:completed,p50Ms:100,p95Ms:120,p99Ms:150,maxMs:200}},
  resources:{start:{rssBytes:1000,heapUsedBytes:500,fdCount:10},
   peak:{rssBytes:2000,heapUsedBytes:800,fdCount:12},
   end:{rssBytes:1200,heapUsedBytes:600,fdCount:11},
   rssGrowthBytes:200,heapGrowthBytes:100,fdGrowth:1},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,credentialsStored:false},
  releaseApproved:false,physicalSafetyCertified:false
 };
}

test('R80 8h campaign 必须由不同 Run、同一 Commit 的真实 segment 累加',()=>{
 const value=createVoiceSoakCampaign([segment('1001'),segment('1002')],{
  targetHours:8,createdAt:'2026-11-18T00:00:00.000Z'
 });
 assert.equal(value.status,'verified-segmented');
 assert.equal(value.accumulatedHours,8);
 assert.equal(value.segments.length,2);
 assert.equal(value.turns.successRate,100);
 assert.equal(verifyVoiceSoakCampaign(value,{expectedCommit:SHA,minTargetHours:8}),true);
});

test('R80 campaign 拒绝重复 Run、跨 Commit、时长不足和低成功率',()=>{
 assert.throws(()=>createVoiceSoakCampaign([segment('1001'),segment('1001')],{targetHours:8}),
  /VOICE_SOAK_CAMPAIGN_RUN_REUSED/);
 assert.throws(()=>createVoiceSoakCampaign([
  segment('1001'),segment('1002',4,{commit:'b'.repeat(40)})
 ],{targetHours:8}),/VOICE_SOAK_CAMPAIGN_COMMIT_MISMATCH/);
 assert.throws(()=>createVoiceSoakCampaign([segment('1001')],{targetHours:8}),
  /VOICE_SOAK_CAMPAIGN_DURATION_INSUFFICIENT/);
 assert.throws(()=>createVoiceSoakCampaign([
  segment('1001',4,{completed:94,failed:6}),segment('1002',4,{completed:94,failed:6})
 ],{targetHours:8}),/VOICE_SOAK_SUCCESS_RATE_TOO_LOW|VOICE_SOAK_CAMPAIGN_SUCCESS_RATE_TOO_LOW/);
});

test('R80 campaign 明确声明 segmented，不可伪装成单进程 72h 连续证据',()=>{
 const reports=Array.from({length:18},(_,i)=>segment(String(2000+i)));
 const value=createVoiceSoakCampaign(reports,{targetHours:72,createdAt:'2026-11-18T01:00:00.000Z'});
 assert.equal(value.accumulatedHours,72);
 assert.equal(value.semantics,'segmented-self-hosted-runs-not-single-process-continuity');
 const changed=structuredClone(value);changed.semantics='continuous-single-process';
 assert.throws(()=>verifyVoiceSoakCampaign(changed),/VOICE_SOAK_CAMPAIGN_INVALID/);
});
