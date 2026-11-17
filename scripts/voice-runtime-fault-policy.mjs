// R80：统一语音运行时故障分类。只决定“是否继续下一轮/是否需要设备恢复”，不吞异常、不伪造成功。
const TRANSIENT=new Set([
 'AUDIO_REALTIME_CONNECT_FAILED','AUDIO_REALTIME_CONNECTION_CLOSED',
 'AUDIO_REALTIME_UPSTREAM_ERROR','AUDIO_REALTIME_READY_TIMEOUT','AUDIO_REALTIME_FINAL_TIMEOUT',
 'CHAT_PROVIDER_UNAVAILABLE','CHAT_PROVIDER_HTTP_429','CHAT_PROVIDER_HTTP_500',
 'CHAT_PROVIDER_HTTP_502','CHAT_PROVIDER_HTTP_503','CHAT_PROVIDER_HTTP_504',
 'SPEECH_PROVIDER_UNAVAILABLE','SPEECH_PROVIDER_HTTP_429','SPEECH_PROVIDER_HTTP_500',
 'SPEECH_PROVIDER_HTTP_502','SPEECH_PROVIDER_HTTP_503','SPEECH_PROVIDER_HTTP_504'
]);
const DEVICE=new Set([
 'MICROPHONE_PERMISSION_DENIED','BROWSER_MICROPHONE_UNSUPPORTED',
 'FULL_VOICE_CAPTURE_START_FAILED','FULL_VOICE_CAPTURE_FAILED',
 'FULL_VOICE_PLAYBACK_FAILED','FULL_VOICE_ALSA_TOOLS_REQUIRED',
 'FULL_VOICE_PHYSICAL_AUDIO_NOT_DETECTED'
]);
const CANCELLATION=new Set(['AUDIO_REQUEST_CANCELLED','VOICE_TURN_CANCELLED','COMPANION_TURN_CANCELLED']);
const SAFE=/^[A-Z][A-Z0-9_]{2,119}$/;

export function classifyVoiceRuntimeFault(error){
 const code=typeof error==='string'?error:String(error?.message??'VOICE_RUNTIME_UNKNOWN_FAILURE');
 const normalized=SAFE.test(code)?code:'VOICE_RUNTIME_UNKNOWN_FAILURE';
 if(CANCELLATION.has(normalized))
  return Object.freeze({code:normalized,category:'cancelled',continueSoak:true,recovery:'none'});
 if(DEVICE.has(normalized))
  return Object.freeze({code:normalized,category:'device',continueSoak:true,recovery:'device-reopen'});
 if(TRANSIENT.has(normalized)||/_HTTP_(?:429|5\d\d)$/.test(normalized))
  return Object.freeze({code:normalized,category:'provider-transient',continueSoak:true,recovery:'bounded-cooldown'});
 if(/INVALID_|_MISMATCH$|_TOO_LARGE$|_FORBIDDEN$/.test(normalized))
  return Object.freeze({code:normalized,category:'contract',continueSoak:false,recovery:'stop'});
 return Object.freeze({code:normalized,category:'unknown',continueSoak:false,recovery:'stop'});
}
