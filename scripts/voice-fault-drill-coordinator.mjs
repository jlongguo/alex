// R81：故障演练协调器。只调度明确声明的 adapter，不直接断网/拔设备/更改系统状态。
export const VOICE_FAULT_DRILL_SCHEMA='alex.dev/voice-fault-drill/v1';
const SCENARIOS=Object.freeze({
 'provider-503':{expectedFaultCode:'CHAT_PROVIDER_HTTP_503',recoveryDeadlineMs:30000},
 'provider-timeout':{expectedFaultCode:'CHAT_PROVIDER_UNAVAILABLE',recoveryDeadlineMs:45000},
 'capture-device-unavailable':{expectedFaultCode:'FULL_VOICE_CAPTURE_FAILED',recoveryDeadlineMs:15000},
 'playback-device-unavailable':{expectedFaultCode:'FULL_VOICE_PLAYBACK_FAILED',recoveryDeadlineMs:15000}
});
const fail=code=>{throw Error(code);};
const RUN=/^[1-9][0-9]{0,19}$/;
const SHA=/^[0-9a-f]{40}$/;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function bounded(promise,ms,code){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),ms);})]);}
 finally{clearTimeout(timer);}
}
function validateContext(env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
  env.RUNNER_ENVIRONMENT!=='self-hosted'||env.GITHUB_JOB!=='voice-fault-drill'||
  env.ALEX_VOICE_FAULT_DRILL_APPROVED!=='true'||!RUN.test(env.GITHUB_RUN_ID??'')||
  !SHA.test(env.GITHUB_SHA??''))fail('VOICE_FAULT_DRILL_APPROVAL_REQUIRED');
 return {runId:env.GITHUB_RUN_ID,commitSha:env.GITHUB_SHA,job:env.GITHUB_JOB};
}
export function listVoiceFaultDrills(){return Object.entries(SCENARIOS).map(([id,v])=>({id,...v}));}
export async function runVoiceFaultDrill({scenarioId,adapter,env=process.env,now=()=>Date.now(),sleepFn=sleep}={}){
 const spec=SCENARIOS[scenarioId];if(!spec)fail('VOICE_FAULT_DRILL_SCENARIO_INVALID');
 if(!adapter||typeof adapter.prepare!=='function'||typeof adapter.inject!=='function'||
  typeof adapter.observeFault!=='function'||typeof adapter.recover!=='function'||
  typeof adapter.verifyHealthyTurn!=='function'||typeof adapter.cleanup!=='function')
  fail('VOICE_FAULT_DRILL_ADAPTER_INVALID');
 const testMode=env.ALEX_VOICE_FAULT_DRILL_TEST_MODE==='1';
 const context=testMode?{runId:'test',commitSha:'0'.repeat(40),job:'test'}:validateContext(env);
 const startedAt=now(),events=[];let prepared=false,injected=false,recovered=false;
 let observedFault=null,healthyTurn=false,cleanupError=null;
 try{
  await bounded(adapter.prepare({scenarioId}),10000,'VOICE_FAULT_DRILL_PREPARE_TIMEOUT');prepared=true;
  await bounded(adapter.inject({scenarioId}),10000,'VOICE_FAULT_DRILL_INJECT_TIMEOUT');injected=true;
  observedFault=await bounded(adapter.observeFault({scenarioId,expectedFaultCode:spec.expectedFaultCode}),
   15000,'VOICE_FAULT_DRILL_OBSERVE_TIMEOUT');
  if(observedFault?.code!==spec.expectedFaultCode)fail('VOICE_FAULT_DRILL_UNEXPECTED_FAULT');
  events.push({phase:'fault-observed',code:observedFault.code,elapsedMs:Math.max(0,now()-startedAt)});
  await bounded(adapter.recover({scenarioId,deadlineMs:spec.recoveryDeadlineMs}),spec.recoveryDeadlineMs,
   'VOICE_FAULT_DRILL_RECOVERY_TIMEOUT');recovered=true;
  healthyTurn=await bounded(adapter.verifyHealthyTurn({scenarioId}),30000,'VOICE_FAULT_DRILL_HEALTH_TIMEOUT');
  if(healthyTurn!==true)fail('VOICE_FAULT_DRILL_POST_RECOVERY_UNHEALTHY');
  events.push({phase:'healthy-turn',elapsedMs:Math.max(0,now()-startedAt)});
  return {schema:VOICE_FAULT_DRILL_SCHEMA,status:'passed',scenarioId,context,
   expectedFaultCode:spec.expectedFaultCode,observedFaultCode:observedFault.code,
   recovered,healthyTurn,elapsedMs:Math.max(0,now()-startedAt),events,
   privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,credentialsStored:false}};
 }finally{
  if(prepared){
   try{await bounded(adapter.cleanup({scenarioId,injected,recovered}),10000,'VOICE_FAULT_DRILL_CLEANUP_TIMEOUT');}
   catch(error){cleanupError=error;}
  }
  if(cleanupError)throw Object.assign(Error('VOICE_FAULT_DRILL_CLEANUP_FAILED'),{cause:cleanupError});
 }
}
