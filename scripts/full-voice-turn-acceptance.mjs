#!/usr/bin/env node
// R78：同一轮真实物理语音 E2E。
// Provider PCM seed → ALSA 扬声器 → ALSA 麦克风 → ASR → streamed LLM → PCM TTS → ALSA 扬声器 → 麦克风回采。
// 报告只保存阶段/时延/长度/设备指纹，不保存原始音频、转录文本、回复文本或凭据。
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,rename,rm,writeFile,lstat,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CompatibleAudioProvider} from './audio-provider.mjs';
import {CompatibleCompanionProvider} from './companion-provider.mjs';
import {StreamingPcmSpeechProvider,SPEECH_PCM_RATE} from './streaming-speech-provider.mjs';

export const FULL_VOICE_TURN_SCHEMA='alex.dev/full-voice-turn-acceptance/v1';
export const FULL_VOICE_SEED_TEXT='Alex physical voice turn acceptance.';
const SHA=/^[0-9a-f]{40}$/;
const DIGITS=/^[1-9][0-9]{0,19}$/;
const HASH=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27,}$/;
const REQUIRED_ENV=[
 'ALEX_VOICE_PROVIDER_BASE_URL','ALEX_VOICE_PROVIDER_API_KEY',
 'ALEX_VOICE_ASR_MODEL','ALEX_VOICE_TTS_MODEL',
 'ALEX_CHAT_PROVIDER_BASE_URL','ALEX_CHAT_PROVIDER_API_KEY','ALEX_CHAT_MODEL'
];
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');
const round=value=>Math.round(value*1000)/1000;
const elapsed=(now,start)=>Math.max(0,Math.round(now()-start));

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
const digest=value=>sha(canonical(value));
const normalize=text=>String(text??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const safeError=error=>{
 const value=String(error?.message??'');
 return /^[A-Z][A-Z0-9_]{2,119}$/.test(value)?value:'FULL_VOICE_TURN_FAILED';
};

function actionContext(env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
  env.RUNNER_ENVIRONMENT!=='self-hosted'||!['full-voice-turn','voice-soak'].includes(env.GITHUB_JOB)||
  !DIGITS.test(env.GITHUB_RUN_ID??'')||
  !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))||Number(env.GITHUB_RUN_ATTEMPT)<1||
  !SHA.test(env.GITHUB_SHA??'')||env.ALEX_FULL_VOICE_TURN_APPROVED!=='true')
  fail('FULL_VOICE_SELF_HOSTED_CONTEXT_REQUIRED');
 if(process.platform!=='linux'||process.arch!=='x64')fail('FULL_VOICE_LINUX_X64_REQUIRED');
 const runner=String(env.RUNNER_NAME??'').trim();
 if(!runner)fail('FULL_VOICE_RUNNER_NAME_REQUIRED');
 return {
  source:'github-actions-self-hosted',runId:env.GITHUB_RUN_ID,
  attempt:Number(env.GITHUB_RUN_ATTEMPT),commitSha:env.GITHUB_SHA,
  job:env.GITHUB_JOB,
  runnerFingerprintSha256:sha(runner+'|'+String(env.RUNNER_OS??'')+'|'+String(env.RUNNER_ARCH??''))
 };
}

function device(value,name){
 if(typeof value!=='string'||!value.trim()||value.length>160||value.includes('\0'))
  fail('FULL_VOICE_'+name+'_DEVICE_REQUIRED');
 return value.trim();
}
function commandAvailable(name){
 const result=spawnSync(name,['--version'],{encoding:'utf8',timeout:3000});
 return result.status===0||result.status===1;
}
async function waitChild(child,label,timeoutMs){
 const result=await Promise.race([
  once(child,'exit').then(([code,signal])=>({code,signal})),
  delay(timeoutMs).then(()=>({timeout:true}))
 ]);
 if(result.timeout){
  child.kill('SIGTERM');await delay(250);if(child.exitCode===null)child.kill('SIGKILL');
  fail('FULL_VOICE_'+label+'_TIMEOUT');
 }
 if(result.code!==0)fail('FULL_VOICE_'+label+'_FAILED');
}
function encodePcmWav(pcm,sampleRate=SPEECH_PCM_RATE){
 if(!Buffer.isBuffer(pcm)||pcm.length<2||pcm.length%2)fail('FULL_VOICE_PCM_INVALID');
 const out=Buffer.alloc(44+pcm.length);
 out.write('RIFF',0);out.writeUInt32LE(36+pcm.length,4);out.write('WAVE',8);
 out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);
 out.writeUInt16LE(1,22);out.writeUInt32LE(sampleRate,24);
 out.writeUInt32LE(sampleRate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
 out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);
 return out;
}
function analyzeWav(bytes){
 const data=Buffer.from(bytes);
 if(data.length<44||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')
  fail('FULL_VOICE_CAPTURE_WAV_INVALID');
 let offset=12,format=null,pcm=null;
 while(offset+8<=data.length){
  const id=data.toString('ascii',offset,offset+4),size=data.readUInt32LE(offset+4);
  const start=offset+8,end=start+size;
  if(end>data.length)fail('FULL_VOICE_CAPTURE_WAV_INVALID');
  if(id==='fmt '){
   if(size<16)fail('FULL_VOICE_CAPTURE_WAV_INVALID');
   format={encoding:data.readUInt16LE(start),channels:data.readUInt16LE(start+2),
    sampleRate:data.readUInt32LE(start+4),bits:data.readUInt16LE(start+14)};
  }else if(id==='data')pcm=data.subarray(start,end);
  offset=end+(size%2);
 }
 if(!format||!pcm||format.encoding!==1||format.channels!==1||
  format.sampleRate!==SPEECH_PCM_RATE||format.bits!==16||pcm.length<9600||pcm.length%2)
  fail('FULL_VOICE_CAPTURE_FORMAT_INVALID');
 let sum=0,peak=0,clipped=0;
 for(let i=0;i<pcm.length;i+=2){
  const x=pcm.readInt16LE(i)/32768;sum+=x*x;peak=Math.max(peak,Math.abs(x));
  if(Math.abs(x)>=0.995)clipped++;
 }
 const samples=pcm.length/2,rms=Math.sqrt(sum/samples),clippingRatio=clipped/samples;
 return {
  sampleRate:SPEECH_PCM_RATE,channels:1,bitsPerSample:16,
  durationMs:Math.round(samples/SPEECH_PCM_RATE*1000),
  rms:round(rms),peak:round(peak),clippingRatio:round(clippingRatio),
  audible:rms>=0.003&&peak>=0.015&&clippingRatio<=0.03
 };
}

async function realPhysicalLoop({pcm,captureDevice,playbackDevice,workspace,label}){
 const rawPath=join(workspace,label+'.pcm'),capturePath=join(workspace,label+'.wav');
 await writeFile(rawPath,pcm,{mode:0o600});
 let capture=spawn('arecord',[
  '-q','-D',captureDevice,'-f','S16_LE','-c','1','-r',String(SPEECH_PCM_RATE),
  '-d','5',capturePath
 ],{stdio:['ignore','ignore','pipe']});
 try{
  await delay(450);
  if(capture.exitCode!==null)fail('FULL_VOICE_CAPTURE_START_FAILED');
  const playback=spawn('aplay',[
   '-q','-D',playbackDevice,'-f','S16_LE','-c','1','-r',String(SPEECH_PCM_RATE),rawPath
  ],{stdio:['ignore','ignore','pipe']});
  await waitChild(playback,'PLAYBACK',10000);
  await waitChild(capture,'CAPTURE',10000);capture=null;
  const wav=await readFile(capturePath);
  const analysis=analyzeWav(wav);
  if(!analysis.audible)fail('FULL_VOICE_PHYSICAL_AUDIO_NOT_DETECTED');
  return {wav,analysis};
 }finally{
  if(capture&&capture.exitCode===null){capture.kill('SIGTERM');await delay(100);}
 }
}

async function collectPcm(provider,text,{now=()=>Date.now()}={}){
 const started=now();
 const source=await provider.open({text});
 let firstPcmMs=null,frames=0,total=0;
 const chunks=[];
 try{
  while(true){
   const block=await source.read();
   if(block.done)break;
   if(!Buffer.isBuffer(block.pcm)||block.pcm.length<2||block.pcm.length%2)
    fail('FULL_VOICE_TTS_PCM_INVALID');
   if(firstPcmMs===null)firstPcmMs=elapsed(now,started);
   total+=block.pcm.length;frames++;
   if(total>1_920_000)fail('FULL_VOICE_TTS_PCM_TOO_LARGE');
   chunks.push(Buffer.from(block.pcm));
  }
 }finally{await source.close();}
 if(total<2||frames<1||firstPcmMs===null)fail('FULL_VOICE_TTS_EMPTY');
 return {pcm:Buffer.concat(chunks,total),frames,bytes:total,
  firstPcmMs,elapsedMs:elapsed(now,started)};
}

function providerConfig(env){
 for(const name of REQUIRED_ENV)
  if(typeof env[name]!=='string'||!env[name])fail('FULL_VOICE_PROVIDER_CONFIG_REQUIRED');
 return {
  voiceBaseUrl:env.ALEX_VOICE_PROVIDER_BASE_URL,voiceKey:env.ALEX_VOICE_PROVIDER_API_KEY,
  asrModel:env.ALEX_VOICE_ASR_MODEL,ttsModel:env.ALEX_VOICE_TTS_MODEL,
  chatBaseUrl:env.ALEX_CHAT_PROVIDER_BASE_URL,chatKey:env.ALEX_CHAT_PROVIDER_API_KEY,
  chatModel:env.ALEX_CHAT_MODEL,voice:env.ALEX_VOICE_NAME||'alloy'
 };
}
async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  await rename(temp,path);
 }finally{try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}}
}

export async function runFullVoiceTurnAcceptance({
 env=process.env,reportPath='.local/voice/full-turn-report.json',
 fetchFns=null,physicalLoop=null,makeTurnId=randomUUID,now=()=>Date.now()
}={}){
 const injected=fetchFns!==null||physicalLoop!==null;
 if(injected&&env.ALEX_FULL_VOICE_TURN_TEST_MODE!=='1')
  fail('FULL_VOICE_TEST_MODE_REQUIRED');
 const context=injected?{
  source:'injected-test',runId:'1',attempt:1,commitSha:'0'.repeat(40),
  job:'full-voice-turn',runnerFingerprintSha256:'0'.repeat(64)
 }:actionContext(env);
 const captureDevice=injected?'test-capture':device(env.ALEX_FULL_VOICE_CAPTURE_DEVICE,'CAPTURE');
 const playbackDevice=injected?'test-playback':device(env.ALEX_FULL_VOICE_PLAYBACK_DEVICE,'PLAYBACK');
 if(!injected&&(!commandAvailable('arecord')||!commandAvailable('aplay')))
  fail('FULL_VOICE_ALSA_TOOLS_REQUIRED');
 const turnId=makeTurnId();
 if(typeof turnId!=='string'||!UUID.test(turnId))fail('FULL_VOICE_TURN_ID_INVALID');
 const report={
  schema:FULL_VOICE_TURN_SCHEMA,status:'running',
  mode:injected?'injected-test':'real-physical-provider-e2e',
  turnId,context,
  devices:{
   captureFingerprintSha256:sha(captureDevice),
   playbackFingerprintSha256:sha(playbackDevice),
   rawIdentifiersStored:false,physicalPathApproved:!injected
  },
  input:{source:'provider-seed-through-physical-speaker-mic',
   seedTextStored:false,seedTextSha256:sha(FULL_VOICE_SEED_TEXT)},
  checks:[],stages:{},latency:{},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,
   deviceIdentifiersStored:false,credentialsStored:false},
  temporaryAudioDeleted:true,releaseApproved:false,physicalSafetyCertified:false
 };
 let workspace=null;
 try{
  const cfg=providerConfig(env);
  const audio=new CompatibleAudioProvider({
   baseUrl:cfg.voiceBaseUrl,apiKey:cfg.voiceKey,
   transcriptionModel:cfg.asrModel,speechModel:cfg.ttsModel,
   voice:cfg.voice,fetchFn:fetchFns?.audio??fetch
  });
  const chat=new CompatibleCompanionProvider({
   baseUrl:cfg.chatBaseUrl,apiKey:cfg.chatKey,model:cfg.chatModel,
   fetchFn:fetchFns?.chat??fetch
  });
  const speech=new StreamingPcmSpeechProvider({
   baseUrl:cfg.voiceBaseUrl,apiKey:cfg.voiceKey,model:cfg.ttsModel,
   voice:cfg.voice,fetchFn:fetchFns?.speech??fetch
  });
  const loop=physicalLoop??realPhysicalLoop;
  workspace=await mkdtemp(join(tmpdir(),'alex-r78-full-voice-'));
  const turnStarted=now();

  let started=now();
  const seed=await collectPcm(speech,FULL_VOICE_SEED_TEXT,{now});
  report.stages.seed_tts={status:'pass',pcmBytes:seed.bytes,frames:seed.frames};
  report.latency.seedTtsFirstPcmMs=seed.firstPcmMs;
  report.latency.seedTtsCompleteMs=elapsed(now,started);
  report.checks.push('provider_seed_pcm_tts');

  started=now();
  const inputLoop=await loop({
   pcm:seed.pcm,captureDevice,playbackDevice,workspace,label:'input-loop'
  });
  report.stages.physical_input={
   status:'pass',captureDurationMs:inputLoop.analysis.durationMs,
   rms:inputLoop.analysis.rms,peak:inputLoop.analysis.peak
  };
  report.latency.physicalInputLoopMs=elapsed(now,started);
  report.checks.push('physical_speaker_to_microphone_input');

  started=now();
  const transcript=await audio.transcribe({
   audio:inputLoop.wav,mime:'audio/wav',language:'en'
  });
  if(normalize(transcript.text)!==normalize(FULL_VOICE_SEED_TEXT))
   fail('FULL_VOICE_ASR_SEED_MISMATCH');
  report.stages.asr={status:'pass',transcriptChars:transcript.text.length,seedMatch:true};
  report.latency.asrMs=elapsed(now,started);
  report.checks.push('provider_asr_from_physical_capture');

  started=now();let firstDeltaMs=null,streamedChars=0;
  const reply=await chat.streamReply({
   mode:'chat',actor:'child',messages:[{role:'user',text:transcript.text}],context:null,
   onDelta:delta=>{
    if(firstDeltaMs===null)firstDeltaMs=elapsed(now,started);
    streamedChars+=delta.length;
   }
  });
  if(firstDeltaMs===null||streamedChars<1||!reply.trim())fail('FULL_VOICE_LLM_EMPTY');
  report.stages.llm={status:'pass',replyChars:reply.length,streamedChars};
  report.latency.llmFirstTokenMs=firstDeltaMs;
  report.latency.llmCompleteMs=elapsed(now,started);
  report.checks.push('provider_llm_stream');

  started=now();
  const spoken=await collectPcm(speech,reply,{now});
  report.stages.reply_tts={status:'pass',pcmBytes:spoken.bytes,frames:spoken.frames};
  report.latency.ttsFirstPcmMs=spoken.firstPcmMs;
  report.latency.ttsCompleteMs=elapsed(now,started);
  report.checks.push('provider_reply_pcm_tts');

  started=now();
  const outputLoop=await loop({
   pcm:spoken.pcm,captureDevice,playbackDevice,workspace,label:'output-loop'
  });
  report.stages.physical_output={
   status:'pass',captureDurationMs:outputLoop.analysis.durationMs,
   rms:outputLoop.analysis.rms,peak:outputLoop.analysis.peak
  };
  report.latency.speakerPlaybackProofMs=elapsed(now,started);
  report.checks.push('physical_reply_speaker_to_microphone_proof');

  report.latency.totalTurnMs=elapsed(now,turnStarted);
  report.status='passed';
  const base=structuredClone(report);
  report.evidenceDigestSha256=digest(base);
  await atomicWrite(resolve(reportPath),report);
  seed.pcm.fill(0);spoken.pcm.fill(0);
  return structuredClone(report);
 }catch(error){
  report.status='failed';report.errorCode=safeError(error);
  const base=structuredClone(report);report.evidenceDigestSha256=digest(base);
  await atomicWrite(resolve(reportPath),report);
  throw Object.assign(Error(report.errorCode),{report:structuredClone(report)});
 }finally{
  if(workspace)await rm(workspace,{recursive:true,force:true});
 }
}

export function verifyFullVoiceTurnReport(report,{expectedRunId=null,expectedCommit=null}={}){
 const requiredChecks=[
  'provider_seed_pcm_tts','physical_speaker_to_microphone_input',
  'provider_asr_from_physical_capture','provider_llm_stream',
  'provider_reply_pcm_tts','physical_reply_speaker_to_microphone_proof'
 ];
 if(!object(report)||report.schema!==FULL_VOICE_TURN_SCHEMA||report.status!=='passed'||
  report.mode!=='real-physical-provider-e2e'||!UUID.test(report.turnId??'')||
  !object(report.context)||report.context.source!=='github-actions-self-hosted'||
  !DIGITS.test(report.context.runId??'')||!Number.isInteger(report.context.attempt)||
  report.context.attempt<1||!SHA.test(report.context.commitSha??'')||
  !['full-voice-turn','voice-soak'].includes(report.context.job)||!HASH.test(report.context.runnerFingerprintSha256??'')||
  !object(report.devices)||!HASH.test(report.devices.captureFingerprintSha256??'')||
  !HASH.test(report.devices.playbackFingerprintSha256??'')||
  report.devices.rawIdentifiersStored!==false||report.devices.physicalPathApproved!==true||
  !object(report.input)||report.input.source!=='provider-seed-through-physical-speaker-mic'||
  report.input.seedTextStored!==false||!HASH.test(report.input.seedTextSha256??'')||
  report.input.seedTextSha256!==sha(FULL_VOICE_SEED_TEXT)||
  !Array.isArray(report.checks)||requiredChecks.some(x=>!report.checks.includes(x))||
  !object(report.stages)||!object(report.latency)||!object(report.privacy)||
  Object.values(report.privacy).some(v=>v!==false)||report.temporaryAudioDeleted!==true||
  report.releaseApproved!==false||report.physicalSafetyCertified!==false||
  !HASH.test(report.evidenceDigestSha256??''))
  fail('FULL_VOICE_REPORT_INVALID');
 for(const name of ['seed_tts','physical_input','asr','llm','reply_tts','physical_output'])
  if(!object(report.stages[name])||report.stages[name].status!=='pass')
   fail('FULL_VOICE_STAGE_INVALID');
 if(report.stages.asr.seedMatch!==true||
  !Number.isInteger(report.stages.asr.transcriptChars)||report.stages.asr.transcriptChars<1||
  !Number.isInteger(report.stages.llm.replyChars)||report.stages.llm.replyChars<1||
  !Number.isInteger(report.stages.llm.streamedChars)||report.stages.llm.streamedChars<1)
  fail('FULL_VOICE_STAGE_INVALID');
 for(const name of [
  'seedTtsFirstPcmMs','seedTtsCompleteMs','physicalInputLoopMs','asrMs',
  'llmFirstTokenMs','llmCompleteMs','ttsFirstPcmMs','ttsCompleteMs',
  'speakerPlaybackProofMs','totalTurnMs'
 ]){
  const value=report.latency[name];
  if(!Number.isFinite(value)||value<0||value>180000)fail('FULL_VOICE_LATENCY_INVALID');
 }
 for(const stage of [report.stages.physical_input,report.stages.physical_output]){
  if(!Number.isFinite(stage.rms)||stage.rms<0.003||
   !Number.isFinite(stage.peak)||stage.peak<0.015||
   !Number.isInteger(stage.captureDurationMs)||stage.captureDurationMs<200)
   fail('FULL_VOICE_PHYSICAL_PROOF_INVALID');
 }
 if(expectedRunId!==null&&report.context.runId!==expectedRunId)fail('FULL_VOICE_RUN_ID_MISMATCH');
 if(expectedCommit!==null&&report.context.commitSha!==expectedCommit)fail('FULL_VOICE_COMMIT_MISMATCH');
 const {evidenceDigestSha256,...base}=report;
 if(digest(base)!==evidenceDigestSha256)fail('FULL_VOICE_REPORT_DIGEST_MISMATCH');
 return true;
}

async function loadReport(path){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>256*1024)
  fail('FULL_VOICE_REPORT_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='run'){
  if(args.length!==2||args[0]!=='--report')fail('FULL_VOICE_USAGE');
  const report=await runFullVoiceTurnAcceptance({reportPath:args[1]});
  console.log('FULL_VOICE_TURN_VERIFIED:'+report.context.runId+':'+report.turnId);
  return;
 }
 if(mode==='verify'){
  let report=null,runId=null,commit=null;
  for(let i=0;i<args.length;i+=2){
   if(args[i]==='--report')report=args[i+1];
   else if(args[i]==='--run-id')runId=args[i+1];
   else if(args[i]==='--commit')commit=args[i+1];
   else fail('FULL_VOICE_USAGE');
  }
  if(!report)fail('FULL_VOICE_USAGE');
  const value=await loadReport(resolve(report));
  verifyFullVoiceTurnReport(value,{expectedRunId:runId,expectedCommit:commit});
  console.log('FULL_VOICE_TURN_REPORT_VERIFIED:'+value.context.runId+':'+value.turnId);
  return;
 }
 fail('FULL_VOICE_USAGE');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(safeError(error));process.exitCode=1;}
}
