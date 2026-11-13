// R56 只读验证真实语音运行时证据；不读取供应商密钥，也不信任报告中的正文数据。
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const REQUIRED_CHECKS=new Set([
  'https_seed_tts','https_asr','https_llm_stream',
  'https_pcm_tts','provider_revocation','provider_usage_aggregate'
]);
const RUN_ID=/^[0-9a-f-]{36}$/;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const fail=code=>{throw Error(code);};
const exactKeys=(value,keys,code)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
  const actual=Object.keys(value).sort().join(',');
  const expected=[...keys].sort().join(',');
  if(actual!==expected)fail(code);
};
const passStage=(value,keys)=>{
  exactKeys(value,['status',...keys],'INVALID_VOICE_STAGE');
  if(value.status!=='pass')fail('VOICE_STAGE_NOT_PASSED');
  if(!integer(value.elapsed_ms,0,120000))fail('INVALID_VOICE_STAGE_LATENCY');
};

export function verifyVoiceRuntimeReport(report,expectedRunId=null){
  exactKeys(report,[
    'schema','run_id','status','provider_mode','input','checks','stages',
    'usage','provider_calls','privacy','release_approved','physical_safety_certified'
  ],'INVALID_VOICE_REPORT_SHAPE');
  if(report.schema!=='alex.dev/voice-runtime-acceptance/v1')
    fail('INVALID_VOICE_REPORT_SCHEMA');
  if(report.status!=='passed')fail('VOICE_RUNTIME_NOT_PASSED');
  if(report.provider_mode!=='real')fail('PROVIDER_MODE_NOT_REAL');
  if(!RUN_ID.test(report.run_id))fail('INVALID_VOICE_RUN_ID');
  if(expectedRunId!==null&&report.run_id!==expectedRunId)
    fail('VOICE_RUN_ID_MISMATCH');

  exactKeys(report.input,['source','acoustic_capture_verified'],'INVALID_VOICE_INPUT');
  if(report.input.source!=='synthetic-provider-tts'
    ||report.input.acoustic_capture_verified!==false)
    fail('INVALID_VOICE_INPUT');

  if(!Array.isArray(report.checks)||report.checks.length!==REQUIRED_CHECKS.size
    ||report.checks.some(value=>!REQUIRED_CHECKS.has(value))
    ||new Set(report.checks).size!==report.checks.length)
    fail('INVALID_VOICE_CHECKS');

  exactKeys(report.stages,['seed_tts','asr','llm','tts','revocation'],
    'INVALID_VOICE_STAGES');

  passStage(report.stages.seed_tts,['elapsed_ms','audio_bytes']);
  if(!integer(report.stages.seed_tts.audio_bytes,128,2_000_000))
    fail('INVALID_SEED_AUDIO_BYTES');

  passStage(report.stages.asr,['elapsed_ms','transcript_chars','seed_match']);
  if(!integer(report.stages.asr.transcript_chars,1,500)
    ||report.stages.asr.seed_match!==true)
    fail('INVALID_ASR_EVIDENCE');

  passStage(report.stages.llm,['elapsed_ms','reply_chars','streamed_chars']);
  if(!integer(report.stages.llm.reply_chars,1,1200)
    ||!integer(report.stages.llm.streamed_chars,1,1200))
    fail('INVALID_LLM_EVIDENCE');

  passStage(report.stages.tts,['elapsed_ms','response_bytes','frames']);
  if(!integer(report.stages.tts.response_bytes,2,1_920_000)
    ||report.stages.tts.response_bytes%2
    ||!integer(report.stages.tts.frames,1,10000))
    fail('INVALID_TTS_EVIDENCE');

  passStage(report.stages.revocation,[
    'elapsed_ms','provider_session_cancelled','stale_session_blocked'
  ]);
  if(report.stages.revocation.provider_session_cancelled!==true
    ||report.stages.revocation.stale_session_blocked!==true)
    fail('INVALID_REVOCATION_EVIDENCE');

  exactKeys(report.usage,[
    'requests','completed','cancelled','failed','inflight','response_bytes',
    'response_samples','frames','measurement'
  ],'INVALID_VOICE_USAGE');
  if(report.usage.requests!==2||report.usage.completed!==1
    ||report.usage.cancelled!==1||report.usage.failed!==0||report.usage.inflight!==0
    ||report.usage.response_bytes!==report.stages.tts.response_bytes
    ||report.usage.response_samples!==report.usage.response_bytes/2
    ||report.usage.frames!==report.stages.tts.frames
    ||report.usage.measurement!=='provider-response-pcm-not-invoice')
    fail('INVALID_VOICE_USAGE');

  exactKeys(report.provider_calls,[
    'seed_tts','asr','llm_stream','streaming_tts'
  ],'INVALID_PROVIDER_CALL_COUNTS');
  if(report.provider_calls.seed_tts!==1||report.provider_calls.asr!==1
    ||report.provider_calls.llm_stream!==1||report.provider_calls.streaming_tts!==2)
    fail('INVALID_PROVIDER_CALL_COUNTS');

  exactKeys(report.privacy,[
    'raw_audio_stored','transcript_stored','response_text_stored','credentials_stored'
  ],'INVALID_VOICE_PRIVACY_EVIDENCE');
  if(Object.values(report.privacy).some(value=>value!==false))
    fail('INVALID_VOICE_PRIVACY_EVIDENCE');

  if(report.release_approved!==false||report.physical_safety_certified!==false)
    fail('VOICE_REPORT_OVERCLAIMS_RELEASE');
  return true;
}

function parseArgs(args){
  let report=null,runId=null;
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!value)fail('VOICE_REPORT_INVALID_ARGS');
    if(key==='--report'&&!report)report=value;
    else if(key==='--run-id'&&runId===null)runId=value;
    else fail('VOICE_REPORT_INVALID_ARGS');
  }
  if(!report)fail('VOICE_REPORT_INVALID_ARGS');
  return {report,runId};
}

async function main(){
  let args;
  try{args=parseArgs(process.argv.slice(2));}
  catch(error){
    console.error('VOICE_RUNTIME_REPORT_INVALID:'+error.message);
    return 2;
  }
  try{
    const info=await stat(args.report);
    if(!info.isFile()||info.size<2||info.size>64*1024)
      fail('VOICE_REPORT_FILE_INVALID');
    const report=JSON.parse(await readFile(args.report,'utf8'));
    verifyVoiceRuntimeReport(report,args.runId);
  }catch(error){
    console.error('VOICE_RUNTIME_REPORT_INVALID:'+
      (/^[A-Z0-9_]{3,120}$/.test(error?.message??'')
        ?error.message:'VOICE_REPORT_PARSE_FAILED'));
    return 1;
  }
  console.log('Voice runtime report validated: real ASR -> streamed LLM -> PCM TTS, revocation and aggregate usage');
  return 0;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode=await main();
