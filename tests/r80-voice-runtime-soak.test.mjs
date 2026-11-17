import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {classifyVoiceRuntimeFault} from '../scripts/voice-runtime-fault-policy.mjs';
import {runVoiceRuntimeSoak,verifyVoiceRuntimeSoakReport} from '../scripts/voice-runtime-soak.mjs';

const env={ALEX_VOICE_SOAK_TEST_MODE:'1'};
const resource=(rss=100,heap=50,fd=10)=>async()=>({rssBytes:rss,heapUsedBytes:heap,fdCount:fd});

test('R80 故障策略区分 transient/device/cancel/contract，未知错误 fail closed',()=>{
 assert.deepEqual(classifyVoiceRuntimeFault(Error('CHAT_PROVIDER_HTTP_503')).category,'provider-transient');
 assert.deepEqual(classifyVoiceRuntimeFault(Error('FULL_VOICE_CAPTURE_FAILED')).category,'device');
 assert.deepEqual(classifyVoiceRuntimeFault(Error('VOICE_TURN_CANCELLED')).category,'cancelled');
 assert.equal(classifyVoiceRuntimeFault(Error('INVALID_REALTIME_SEQUENCE')).continueSoak,false);
 assert.equal(classifyVoiceRuntimeFault(Error('some vendor secret details')).code,'VOICE_RUNTIME_UNKNOWN_FAILURE');
});

test('R80 加速 Soak 能记录失败后恢复、分位时延且不保存内容',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r80-soak-'));
 let now=0,calls=0;
 try{
  const reportPath=join(dir,'report.json');
  const report=await runVoiceRuntimeSoak({
   env,hours:8,intervalMs:1200000,maxTurns:40,reportPath,
   now:()=>now,sleepFn:async ms=>{now+=ms;},
   resourceFn:resource(1024,512,12),
   turnRunner:async()=>{
    calls++;now+=100;
    if(calls===3)throw Error('CHAT_PROVIDER_HTTP_503');
    return {latency:{totalTurnMs:100}};
   }
  });
  assert.equal(report.status,'passed');
  assert.equal(report.turns.failed,1);
  assert.ok(report.turns.started>=24&&report.turns.started<=25);
  assert.equal(report.turns.completed,report.turns.started-1);
  assert.equal(report.recovery.attempts,1);
  assert.equal(report.recovery.success,1);
  assert.equal(report.faults.byCode.CHAT_PROVIDER_HTTP_503,1);
  assert.equal(report.latency.totalTurn.p95Ms,100);
  const raw=await readFile(reportPath,'utf8');
  assert.equal(raw.includes('transcript'),true); // 仅隐私布尔字段名，不能出现内容。
  assert.equal(raw.includes('provider secret'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R80 contract fault 立即停止，不能靠后续成功掩盖',async()=>{
 let now=0;
 await assert.rejects(runVoiceRuntimeSoak({
  env,hours:8,intervalMs:0,maxTurns:10,now:()=>now++,
  sleepFn:async()=>{},resourceFn:resource(),
  reportPath:join(tmpdir(),'alex-r80-contract-'+process.pid+'.json'),
  turnRunner:async()=>{throw Error('INVALID_REALTIME_SEQUENCE');}
 }),/VOICE_SOAK_STOPPED_NON_RECOVERABLE_FAULT/);
});

test('R80 verifier 要求真实 self-hosted context、>=95% 成功率和有界资源增长',()=>{
 const base={
  schema:'alex.dev/voice-runtime-soak/v1',status:'passed',
  context:{source:'github-actions-self-hosted',job:'voice-soak',runId:'12345',attempt:1,
   commitSha:'a'.repeat(40)},requestedHours:8,durationObservedMs:28800000,
  stopReason:'duration-complete',
  turns:{started:100,completed:96,failed:4,cancelled:0,successRate:96,recent:[]},
  recovery:{attempts:4,success:4,consecutiveFailuresAtEnd:0},
  faults:{byCode:{CHAT_PROVIDER_HTTP_503:4},byCategory:{'provider-transient':4}},
  latency:{totalTurn:{count:96,p50Ms:100,p95Ms:120,p99Ms:150,maxMs:180}},
  resources:{start:{rssBytes:1000,heapUsedBytes:500,fdCount:10},
   peak:{rssBytes:2000,heapUsedBytes:800,fdCount:20},
   end:{rssBytes:1200,heapUsedBytes:600,fdCount:11},
   rssGrowthBytes:200,heapGrowthBytes:100,fdGrowth:1},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,credentialsStored:false},
  releaseApproved:false,physicalSafetyCertified:false
 };
 assert.equal(verifyVoiceRuntimeSoakReport(base,{expectedRunId:'12345',expectedCommit:'a'.repeat(40)}),true);
 const low=structuredClone(base);low.turns.successRate=94.9;
 assert.throws(()=>verifyVoiceRuntimeSoakReport(low),/VOICE_SOAK_SUCCESS_RATE_TOO_LOW/);
 const leak=structuredClone(base);leak.resources.fdGrowth=33;
 assert.throws(()=>verifyVoiceRuntimeSoakReport(leak),/VOICE_SOAK_RESOURCE_GROWTH_EXCEEDED/);
});
