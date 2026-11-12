// R56 真实供应商语音链路验收：仅使用固定合成短句，不读取儿童录音或真实对话。
// CLI 默认只允许真实 HTTPS 供应商；测试注入模式的报告会明确标记为 injected-test，不能进入发布门槛。
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CompatibleAudioProvider} from './audio-provider.mjs';
import {CompatibleCompanionProvider} from './companion-provider.mjs';
import {StreamingPcmSpeechProvider} from './streaming-speech-provider.mjs';
import {StreamingSpeechSessions} from './streaming-speech-sessions.mjs';
import {ProviderUsageJournal, MeteredStreamingSpeechProvider} from './provider-usage-journal.mjs';
import {revokeLearnerRuntime} from './learner-session-revocation.mjs';

export const VOICE_ACCEPTANCE_SEED_TEXT='Alex runtime acceptance phrase.';
const REVOCATION_TEXT='Alex runtime cancellation probe.';
const PROFILE_ID='profile-55555555-5555-4555-8555-555555555555';
const PRINCIPAL='learner:'+PROFILE_ID;
const REQUIRED_ENV=[
  'ALEX_VOICE_PROVIDER_BASE_URL','ALEX_VOICE_PROVIDER_API_KEY',
  'ALEX_VOICE_ASR_MODEL','ALEX_VOICE_TTS_MODEL',
  'ALEX_CHAT_PROVIDER_BASE_URL','ALEX_CHAT_PROVIDER_API_KEY','ALEX_CHAT_MODEL'
];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const elapsed=(now,start)=>Math.max(0,Math.round(now()-start));
const normalize=text=>String(text??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const safeError=error=>{
  const value=String(error?.message??'');
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(value)
    ?value:'VOICE_RUNTIME_ACCEPTANCE_FAILED';
};
const stage=(status,extra={})=>({status,...extra});

async function atomicWrite(path,value){
  const target=resolve(path);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temp=target+'.tmp';
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});
  await rename(temp,target);
}
function parseArgs(args){
  if(args.length===0)return {report:'.local/voice/runtime-report.json'};
  if(args.length===2&&args[0]==='--report'&&args[1])
    return {report:args[1]};
  throw Error('VOICE_RUNTIME_INVALID_ARGS');
}
function requiredConfig(env){
  if(env.ALEX_RUN_VOICE_PROVIDER_ACCEPTANCE!=='1')
    throw Error('VOICE_RUNTIME_OPT_IN_REQUIRED');
  for(const name of REQUIRED_ENV)
    if(typeof env[name]!=='string'||!env[name])
      throw Error('VOICE_RUNTIME_PROVIDER_CONFIG_REQUIRED');
  return {
    voiceBaseUrl:env.ALEX_VOICE_PROVIDER_BASE_URL,
    voiceKey:env.ALEX_VOICE_PROVIDER_API_KEY,
    asrModel:env.ALEX_VOICE_ASR_MODEL,
    ttsModel:env.ALEX_VOICE_TTS_MODEL,
    chatBaseUrl:env.ALEX_CHAT_PROVIDER_BASE_URL,
    chatKey:env.ALEX_CHAT_PROVIDER_API_KEY,
    chatModel:env.ALEX_CHAT_MODEL,
    voice:env.ALEX_VOICE_NAME||'alloy'
  };
}

export async function runVoiceRuntimeAcceptance({
  env=process.env,reportPath='.local/voice/runtime-report.json',
  fetchFns=null,makeRunId=randomUUID,now=()=>Date.now()
}={}){
  const injected=fetchFns!==null;
  if(injected&&env.ALEX_VOICE_ACCEPTANCE_TEST_MODE!=='1')
    throw Error('VOICE_RUNTIME_TEST_MODE_REQUIRED');
  const runId=makeRunId();
  if(typeof runId!=='string'||!/^[0-9a-f-]{36}$/.test(runId))
    throw Error('VOICE_RUNTIME_INVALID_RUN_ID');
  const report={
    schema:'alex.dev/voice-runtime-acceptance/v1',
    run_id:runId,
    status:'running',
    provider_mode:injected?'injected-test':'real',
    input:{source:'synthetic-provider-tts',acoustic_capture_verified:false},
    checks:[],
    stages:{},
    usage:null,
    provider_calls:{seed_tts:0,asr:0,llm_stream:0,streaming_tts:0},
    privacy:{
      raw_audio_stored:false,
      transcript_stored:false,
      response_text_stored:false,
      credentials_stored:false
    },
    release_approved:false,
    physical_safety_certified:false
  };
  let workspace=null;
  try{
    const cfg=requiredConfig(env);
    const audio=new CompatibleAudioProvider({
      baseUrl:cfg.voiceBaseUrl,apiKey:cfg.voiceKey,
      transcriptionModel:cfg.asrModel,speechModel:cfg.ttsModel,
      voice:cfg.voice,fetchFn:fetchFns?.audio??fetch
    });
    const chat=new CompatibleCompanionProvider({
      baseUrl:cfg.chatBaseUrl,apiKey:cfg.chatKey,model:cfg.chatModel,
      fetchFn:fetchFns?.chat??fetch
    });
    const rawSpeech=new StreamingPcmSpeechProvider({
      baseUrl:cfg.voiceBaseUrl,apiKey:cfg.voiceKey,model:cfg.ttsModel,
      voice:cfg.voice,fetchFn:fetchFns?.speech??fetch
    });
    workspace=await mkdtemp(join(tmpdir(),'alex-r56-voice-'));
    const journal=new ProviderUsageJournal({file:join(workspace,'provider-usage.jsonl')});
    const speech=new MeteredStreamingSpeechProvider({provider:rawSpeech,journal});

    let started=now();
    report.provider_calls.seed_tts++;
    const seed=await audio.synthesize({text:VOICE_ACCEPTANCE_SEED_TEXT,language:'en'});
    report.stages.seed_tts=stage('pass',{
      elapsed_ms:elapsed(now,started),audio_bytes:seed.audio.byteLength
    });
    report.checks.push('real_https_seed_tts');

    started=now();
    report.provider_calls.asr++;
    const transcript=await audio.transcribe({
      audio:seed.audio,mime:seed.mime,language:'en'
    });
    const seedMatch=normalize(transcript.text)===normalize(VOICE_ACCEPTANCE_SEED_TEXT);
    if(!seedMatch)throw Error('VOICE_RUNTIME_ASR_SEED_MISMATCH');
    report.stages.asr=stage('pass',{
      elapsed_ms:elapsed(now,started),
      transcript_chars:transcript.text.length,
      seed_match:true
    });
    report.checks.push('real_https_asr');

    started=now();
    report.provider_calls.llm_stream++;
    let provisionalChars=0;
    const reply=await chat.streamReply({
      mode:'chat',actor:'child',
      messages:[{role:'user',text:transcript.text}],
      context:null,onDelta:delta=>{provisionalChars+=delta.length;}
    });
    if(provisionalChars<1||reply.length<1)throw Error('VOICE_RUNTIME_LLM_EMPTY');
    report.stages.llm=stage('pass',{
      elapsed_ms:elapsed(now,started),
      reply_chars:reply.length,
      streamed_chars:provisionalChars
    });
    report.checks.push('real_https_llm_stream');

    started=now();
    report.provider_calls.streaming_tts++;
    const rendered=await speech.open({text:reply});
    let responseBytes=0,frames=0;
    try{
      while(true){
        const block=await rendered.read();
        if(block.done)break;
        if(!Buffer.isBuffer(block.pcm))throw Error('VOICE_RUNTIME_TTS_INVALID_PCM');
        responseBytes+=block.pcm.length;frames++;
      }
    }finally{
      await rendered.close();
    }
    if(responseBytes<2||responseBytes%2||frames<1)
      throw Error('VOICE_RUNTIME_TTS_EMPTY');
    report.stages.tts=stage('pass',{
      elapsed_ms:elapsed(now,started),
      response_bytes:responseBytes,frames
    });
    report.checks.push('real_https_pcm_tts');

    started=now();
    report.provider_calls.streaming_tts++;
    const sessions=new StreamingSpeechSessions({provider:speech});
    const opened=await sessions.start(PRINCIPAL,{text:REVOCATION_TEXT});
    const stopped=revokeLearnerRuntime({
      profileId:PROFILE_ID,
      auth:{revokeLearner:()=>1},
      abortCompanion:()=>true,
      audioGate:{cancel:()=>({cancelled:true})},
      audioIngress:{erasePrincipal:()=>1},
      speechPlayback:sessions
    });
    if(stopped.revokedSessions!==1||stopped.principalStopped!==true
      ||sessions.activeCount()!==0)
      throw Error('VOICE_RUNTIME_REVOCATION_NOT_OBSERVED');
    let blocked=false;
    try{await sessions.next(PRINCIPAL,opened.id,0);}
    catch(error){blocked=/UNKNOWN_SPEECH_SESSION|AUDIO_REQUEST_CANCELLED/.test(error?.message??'');}
    if(!blocked)throw Error('VOICE_RUNTIME_REVOKED_SESSION_STILL_READABLE');
    for(let i=0;i<40&&journal.summary().cancelled<1;i++)await pause(25);
    report.stages.revocation=stage('pass',{
      elapsed_ms:elapsed(now,started),
      provider_session_cancelled:journal.summary().cancelled>=1,
      stale_session_blocked:true
    });
    if(!report.stages.revocation.provider_session_cancelled)
      throw Error('VOICE_RUNTIME_PROVIDER_CANCEL_NOT_RECORDED');
    report.checks.push('real_provider_revocation');

    const usage=journal.summary();
    if(usage.requests!==2||usage.completed!==1||usage.cancelled!==1
      ||usage.failed!==0||usage.inflight!==0
      ||usage.responseBytes!==responseBytes||usage.frames!==frames)
      throw Error('VOICE_RUNTIME_USAGE_MISMATCH');
    report.usage={
      requests:usage.requests,completed:usage.completed,cancelled:usage.cancelled,
      failed:usage.failed,inflight:usage.inflight,response_bytes:usage.responseBytes,
      response_samples:usage.responseSamples,frames:usage.frames,
      measurement:usage.measurement
    };
    report.checks.push('provider_usage_aggregate');
    report.status='passed';
    await atomicWrite(reportPath,report);
    return structuredClone(report);
  }catch(error){
    report.status='failed';
    report.error_code=safeError(error);
    await atomicWrite(reportPath,report);
    throw Object.assign(Error(report.error_code),{report:structuredClone(report)});
  }finally{
    if(workspace)await rm(workspace,{recursive:true,force:true});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let options;
  try{options=parseArgs(process.argv.slice(2));}
  catch(error){
    console.error(safeError(error));
    process.exitCode=2;
  }
  if(options){
    try{
      const result=await runVoiceRuntimeAcceptance({reportPath:options.report});
      console.log(JSON.stringify({
        schema:result.schema,run_id:result.run_id,status:result.status,
        provider_mode:result.provider_mode,report:resolve(options.report)
      }));
    }catch(error){
      console.error(safeError(error));
      process.exitCode=1;
    }
  }
}
