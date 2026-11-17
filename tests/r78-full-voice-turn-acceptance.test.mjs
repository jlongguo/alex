import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
 runFullVoiceTurnAcceptance,verifyFullVoiceTurnReport,
 FULL_VOICE_SEED_TEXT,FULL_VOICE_TURN_SCHEMA
} from '../scripts/full-voice-turn-acceptance.mjs';

const TURN='11111111-1111-4111-8111-111111111111';
const SHA='0123456789abcdef0123456789abcdef01234567';
const canonical=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
};
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const stream=chunks=>new ReadableStream({start(controller){
 for(const chunk of chunks)controller.enqueue(chunk);controller.close();
}});
const sse=text=>new TextEncoder().encode(
 'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n'+
 'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'+
 'data: [DONE]\n\n'
);
const env=()=>({
 ALEX_FULL_VOICE_TURN_TEST_MODE:'1',
 ALEX_VOICE_PROVIDER_BASE_URL:'https://voice.example.test/v1',
 ALEX_VOICE_PROVIDER_API_KEY:'r78-voice-secret-never-store',
 ALEX_VOICE_ASR_MODEL:'asr-test',ALEX_VOICE_TTS_MODEL:'tts-test',
 ALEX_CHAT_PROVIDER_BASE_URL:'https://chat.example.test/v1',
 ALEX_CHAT_PROVIDER_API_KEY:'r78-chat-secret-never-store',
 ALEX_CHAT_MODEL:'chat-test'
});
function fetches(){
 let speech=0;
 return {
  audio:async url=>{
   if(url.pathname.endsWith('/audio/transcriptions'))
    return new Response(JSON.stringify({text:FULL_VOICE_SEED_TEXT}),{
     headers:{'Content-Type':'application/json'}});
   throw Error('UNEXPECTED_AUDIO_URL');
  },
  chat:async()=>new Response(stream([sse('Safe physical voice reply.')]),{
   headers:{'Content-Type':'text/event-stream'}}),
  speech:async()=>{
   speech++;
   return new Response(stream([
    new Uint8Array(4800).fill(speech),new Uint8Array(4800).fill(speech)
   ]),{headers:{'Content-Type':'audio/pcm'}});
  }
 };
}
function fakeWav(){
 const samples=24000,pcm=Buffer.alloc(samples*2);
 for(let i=0;i<samples;i++)pcm.writeInt16LE(Math.round(Math.sin(i/8)*4000),i*2);
 const out=Buffer.alloc(44+pcm.length);
 out.write('RIFF',0);out.writeUInt32LE(36+pcm.length,4);out.write('WAVE',8);
 out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);
 out.writeUInt16LE(1,22);out.writeUInt32LE(24000,24);out.writeUInt32LE(48000,28);
 out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);
 out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);return out;
}
const physicalLoop=async()=>({
 wav:fakeWav(),analysis:{sampleRate:24000,channels:1,bitsPerSample:16,
  durationMs:1000,rms:0.08,peak:0.3,clippingRatio:0,audible:true}
});
function validReal(){
 const base={
  schema:FULL_VOICE_TURN_SCHEMA,status:'passed',mode:'real-physical-provider-e2e',
  turnId:TURN,
  context:{source:'github-actions-self-hosted',runId:'44000000001',attempt:1,
   commitSha:SHA,job:'full-voice-turn',runnerFingerprintSha256:'d'.repeat(64)},
  devices:{captureFingerprintSha256:'b'.repeat(64),playbackFingerprintSha256:'c'.repeat(64),
   rawIdentifiersStored:false,physicalPathApproved:true},
  input:{source:'provider-seed-through-physical-speaker-mic',
   seedTextStored:false,seedTextSha256:createHash('sha256').update(FULL_VOICE_SEED_TEXT).digest('hex')},
  checks:['provider_seed_pcm_tts','physical_speaker_to_microphone_input',
   'provider_asr_from_physical_capture','provider_llm_stream','provider_reply_pcm_tts',
   'physical_reply_speaker_to_microphone_proof'],
  stages:{
   seed_tts:{status:'pass',pcmBytes:9600,frames:2},
   physical_input:{status:'pass',captureDurationMs:1000,rms:0.08,peak:0.3},
   asr:{status:'pass',transcriptChars:36,seedMatch:true},
   llm:{status:'pass',replyChars:24,streamedChars:24},
   reply_tts:{status:'pass',pcmBytes:9600,frames:2},
   physical_output:{status:'pass',captureDurationMs:1000,rms:0.07,peak:0.25}
  },
  latency:{seedTtsFirstPcmMs:10,seedTtsCompleteMs:20,physicalInputLoopMs:1000,
   asrMs:30,llmFirstTokenMs:40,llmCompleteMs:80,ttsFirstPcmMs:15,ttsCompleteMs:25,
   speakerPlaybackProofMs:1000,totalTurnMs:2200},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,
   deviceIdentifiersStored:false,credentialsStored:false},
  temporaryAudioDeleted:true,releaseApproved:false,physicalSafetyCertified:false
 };
 return {...base,evidenceDigestSha256:digest(base)};
}

test('R78 注入模式能跑完整同一 Turn，但不能冒充真实物理/供应商证据',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r78-full-voice-'));
 try{
  const reportPath=join(dir,'report.json');
  const result=await runFullVoiceTurnAcceptance({
   env:env(),reportPath,fetchFns:fetches(),physicalLoop,makeTurnId:()=>TURN
  });
  assert.equal(result.status,'passed');
  assert.equal(result.mode,'injected-test');
  assert.equal(result.stages.asr.seedMatch,true);
  assert.equal(result.checks.length,6);
  const raw=await readFile(reportPath,'utf8');
  assert.equal(raw.includes('r78-voice-secret-never-store'),false);
  assert.equal(raw.includes('r78-chat-secret-never-store'),false);
  assert.equal(raw.includes(FULL_VOICE_SEED_TEXT),false);
  assert.equal(raw.includes('Safe physical voice reply.'),false);
  assert.throws(()=>verifyFullVoiceTurnReport(result),/FULL_VOICE_REPORT_INVALID/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R78 真实报告必须绑定同一 Run/Commit/Turn 且完整覆盖物理输入和物理输出',()=>{
 const report=validReal();
 assert.equal(verifyFullVoiceTurnReport(report,{
  expectedRunId:'44000000001',expectedCommit:SHA
 }),true);
 const cross=structuredClone(report);cross.context.commitSha='f'.repeat(40);
 const {evidenceDigestSha256,...base}=cross;cross.evidenceDigestSha256=digest(base);
 assert.throws(()=>verifyFullVoiceTurnReport(cross,{expectedCommit:SHA}),
  /FULL_VOICE_COMMIT_MISMATCH/);
 const noOutput=structuredClone(report);noOutput.stages.physical_output.rms=0;
 const stripped=structuredClone(noOutput);delete stripped.evidenceDigestSha256;
 noOutput.evidenceDigestSha256=digest(stripped);
 assert.throws(()=>verifyFullVoiceTurnReport(noOutput),/FULL_VOICE_PHYSICAL_PROOF_INVALID/);
});

test('R78 报告改写、隐私过度声明或缺任一同轮阶段都必须 fail closed',()=>{
 let report=validReal();report.stages.llm.replyChars=99;
 assert.throws(()=>verifyFullVoiceTurnReport(report),/FULL_VOICE_REPORT_DIGEST_MISMATCH/);
 report=validReal();report.privacy.rawAudioStored=true;
 const a=structuredClone(report);delete a.evidenceDigestSha256;report.evidenceDigestSha256=digest(a);
 assert.throws(()=>verifyFullVoiceTurnReport(report),/FULL_VOICE_REPORT_INVALID/);
 report=validReal();report.checks.pop();
 const b=structuredClone(report);delete b.evidenceDigestSha256;report.evidenceDigestSha256=digest(b);
 assert.throws(()=>verifyFullVoiceTurnReport(report),/FULL_VOICE_REPORT_INVALID/);
});

test('R78 workflow 只能手动在 alex-acoustic self-hosted runner 运行且不上传原始音频',async()=>{
 const source=await readFile(resolve('.github/workflows/full-voice-turn-acceptance.yml'),'utf8');
 assert.match(source,/workflow_dispatch/);
 assert.match(source,/runs-on: \[self-hosted, linux, x64, alex-acoustic\]/);
 assert.match(source,/ALEX_FULL_VOICE_TURN_RUNNER_APPROVED/);
 assert.match(source,/voice:full-turn -- run/);
 assert.match(source,/voice:full-turn -- verify/);
 assert.match(source,/alex-full-voice-turn-physical-e2e/);
 assert.doesNotMatch(source,/\.wav\s*$/m);
 assert.doesNotMatch(source,/\.pcm\s*$/m);
});


test('R78 Runtime Gate 可记录真实同轮 Full Voice Turn，但仍不把它当发布许可',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r78-gate-'));
 try{
  const path=join(dir,'full-turn.json');
  await (await import('node:fs/promises')).writeFile(path,JSON.stringify(validReal())+'\n');
  const gate=resolve('scripts/runtime-acceptance-gate.py');
  const checked=spawnSync('python3',[
   gate,'--full-voice-turn-report',path,'--full-voice-turn-run-id','44000000001'
  ],{encoding:'utf8',timeout:12000});
  assert.equal(checked.status,0,checked.stderr);
  const report=JSON.parse(checked.stdout);
  assert.equal(report.full_voice_turn,'verified-self-hosted');
  assert.ok(!report.remaining.includes('FULL_VOICE_TURN_PHYSICAL_E2E'));
  assert.equal(report.release_approved,false);
  assert.equal(report.physical_safety_certified,false);

  const bad=spawnSync('python3',[
   gate,'--full-voice-turn-report',path,'--full-voice-turn-run-id','44000000002'
  ],{encoding:'utf8',timeout:12000});
  assert.equal(bad.status,1,bad.stderr);
  assert.equal(JSON.parse(bad.stdout).full_voice_turn,'invalid');
 }finally{await rm(dir,{recursive:true,force:true});}
});
