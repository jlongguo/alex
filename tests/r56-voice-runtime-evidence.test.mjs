import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
 runVoiceRuntimeAcceptance,VOICE_ACCEPTANCE_SEED_TEXT
} from '../scripts/voice-runtime-acceptance.mjs';
import {verifyVoiceRuntimeReport} from '../scripts/verify-voice-runtime-report.mjs';

const RUN='66666666-6666-4666-8666-666666666666';
const env=()=>({
 ALEX_RUN_VOICE_PROVIDER_ACCEPTANCE:'1',
 ALEX_VOICE_ACCEPTANCE_TEST_MODE:'1',
 ALEX_VOICE_PROVIDER_BASE_URL:'https://voice.example.test/v1',
 ALEX_VOICE_PROVIDER_API_KEY:'r56-audio-secret-never-store',
 ALEX_VOICE_ASR_MODEL:'asr-test',
 ALEX_VOICE_TTS_MODEL:'tts-test',
 ALEX_CHAT_PROVIDER_BASE_URL:'https://chat.example.test/v1',
 ALEX_CHAT_PROVIDER_API_KEY:'r56-chat-secret-never-store',
 ALEX_CHAT_MODEL:'chat-test'
});
const stream=chunks=>new ReadableStream({
 start(controller){
  for(const chunk of chunks)controller.enqueue(chunk);
  controller.close();
 }
});
const sse=text=>new TextEncoder().encode(
 'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n'+
 'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'+
 'data: [DONE]\n\n'
);
function fetches(){
 let audioCalls=0,speechCalls=0;
 return {
  audio:async(url)=>{
   audioCalls++;
   if(url.pathname.endsWith('/audio/speech'))
    return new Response(new Uint8Array(256).fill(1),{
     headers:{'Content-Type':'audio/mpeg'}
    });
   if(url.pathname.endsWith('/audio/transcriptions'))
    return new Response(JSON.stringify({text:VOICE_ACCEPTANCE_SEED_TEXT}),{
     headers:{'Content-Type':'application/json'}
    });
   throw Error('UNEXPECTED_AUDIO_URL');
  },
  chat:async()=>new Response(stream([sse('Safe runtime reply.')]),{
   headers:{'Content-Type':'text/event-stream'}
  }),
  speech:async()=>{
   speechCalls++;
   return new Response(stream([
    new Uint8Array(4800).fill(speechCalls),
    new Uint8Array(2400).fill(speechCalls)
   ]),{headers:{'Content-Type':'audio/pcm'}});
  },
  counts:()=>({audioCalls,speechCalls})
 };
}
const validReal=()=>({
 schema:'alex.dev/voice-runtime-acceptance/v1',
 run_id:RUN,status:'passed',provider_mode:'real',
 input:{source:'synthetic-provider-tts',acoustic_capture_verified:false},
 checks:[
  'real_https_seed_tts','real_https_asr','real_https_llm_stream',
  'real_https_pcm_tts','real_provider_revocation','provider_usage_aggregate'
 ],
 stages:{
  seed_tts:{status:'pass',elapsed_ms:10,audio_bytes:256},
  asr:{status:'pass',elapsed_ms:20,transcript_chars:30,seed_match:true},
  llm:{status:'pass',elapsed_ms:30,reply_chars:20,streamed_chars:20},
  tts:{status:'pass',elapsed_ms:40,response_bytes:7200,frames:2},
  revocation:{status:'pass',elapsed_ms:50,provider_session_cancelled:true,
   stale_session_blocked:true}
 },
 usage:{requests:2,completed:1,cancelled:1,failed:0,inflight:0,
  response_bytes:7200,response_samples:3600,frames:2,
  measurement:'provider-response-pcm-not-invoice'},
 provider_calls:{seed_tts:1,asr:1,llm_stream:1,streaming_tts:2},
 privacy:{raw_audio_stored:false,transcript_stored:false,
  response_text_stored:false,credentials_stored:false},
 release_approved:false,physical_safety_certified:false
});

test('R56 注入供应商可跑完整 ASR→流式 LLM→PCM TTS→撤销链路，但证据明确不能冒充真实供应商',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r56-test-'));
 const report=join(dir,'voice.json');
 try{
  const f=fetches();
  const result=await runVoiceRuntimeAcceptance({
   env:env(),reportPath:report,fetchFns:f,makeRunId:()=>RUN
  });
  assert.equal(result.status,'passed');
  assert.equal(result.provider_mode,'injected-test');
  assert.equal(result.usage.completed,1);
  assert.equal(result.usage.cancelled,1);
  assert.equal(result.stages.tts.response_bytes,7200);
  assert.equal(result.stages.revocation.stale_session_blocked,true);
  assert.deepEqual(f.counts(),{audioCalls:2,speechCalls:2});
  const raw=await readFile(report,'utf8');
  assert.ok(!raw.includes('r56-audio-secret-never-store'));
  assert.ok(!raw.includes('r56-chat-secret-never-store'));
  assert.ok(!raw.includes(VOICE_ACCEPTANCE_SEED_TEXT));
  assert.ok(!raw.includes('Safe runtime reply.'));
  assert.throws(()=>verifyVoiceRuntimeReport(result,RUN),/PROVIDER_MODE_NOT_REAL/);
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});

test('R56 真实证据验证器要求同次 run_id、完整阶段、撤销与供应商用量一致',()=>{
 const report=validReal();
 assert.equal(verifyVoiceRuntimeReport(report,RUN),true);
 assert.throws(()=>verifyVoiceRuntimeReport(
  report,'77777777-7777-4777-8777-777777777777'
 ),/VOICE_RUN_ID_MISMATCH/);
 const missing=structuredClone(report);
 missing.checks.pop();
 assert.throws(()=>verifyVoiceRuntimeReport(missing,RUN),/INVALID_VOICE_CHECKS/);
 const overclaim=structuredClone(report);
 overclaim.release_approved=true;
 assert.throws(()=>verifyVoiceRuntimeReport(overclaim,RUN),/VOICE_REPORT_OVERCLAIMS_RELEASE/);
});

test('R56 runtime gate 只在真实语音报告结构和 run_id 均有效时移除语音缺口',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r56-gate-'));
 const file=join(dir,'voice.json');
 const gate=resolve(import.meta.dirname,'../scripts/runtime-acceptance-gate.py');
 try{
  await writeFile(file,JSON.stringify(validReal()));
  const ok=spawnSync('python3',[
   gate,'--voice-report',file,'--voice-run-id',RUN
  ],{encoding:'utf8',timeout:12000});
  assert.equal(ok.status,0,ok.stderr);
  const passed=JSON.parse(ok.stdout);
  assert.equal(passed.voice_real_provider,'verified');
  assert.ok(!passed.remaining.includes('REAL_ASR_LLM_TTS_PROVIDER_E2E'));
  assert.ok(passed.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
  assert.equal(passed.release_approved,false);

  const bad=spawnSync('python3',[
   gate,'--voice-report',file,'--voice-run-id',
   '77777777-7777-4777-8777-777777777777'
  ],{encoding:'utf8',timeout:12000});
  assert.equal(bad.status,1,bad.stderr);
  assert.equal(JSON.parse(bad.stdout).voice_real_provider,'invalid');
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});
