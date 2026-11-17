// R80：浏览器语音半双工守卫。
// WebRTC echoCancellation 不是物理回声证明；这里额外禁止播放与录音重叠，并在播放停止后保留短冷却窗。
// 显式 barge-in 可缩短冷却，但仍不会做到 0ms，避免扬声器尾音被当成儿童开口。
class AlexVoiceDuplexGuard {
 #phase='idle';#cooldownUntil=0;#lastPlaybackEnd=null;#stats;
 constructor({clock=()=>performance.now(),cooldownMs=260,bargeInCooldownMs=120}={}){
  if(typeof clock!=='function'||!Number.isFinite(cooldownMs)||cooldownMs<80||cooldownMs>2000
    ||!Number.isFinite(bargeInCooldownMs)||bargeInCooldownMs<40
    ||bargeInCooldownMs>cooldownMs)
   throw Error('INVALID_VOICE_DUPLEX_CONFIG');
  this.clock=clock;this.cooldownMs=cooldownMs;this.bargeInCooldownMs=bargeInCooldownMs;
  this.#stats={playbackStarts:0,captureStarts:0,bargeIns:0,
   blockedOverlaps:0,cooldownWaits:0,cooldownWaitMs:0};
 }
 snapshot(){
  const now=this.clock();
  return Object.freeze({
   phase:this.#phase,
   cooldownRemainingMs:Math.max(0,Math.ceil(this.#cooldownUntil-now)),
   lastPlaybackEnd:this.#lastPlaybackEnd,
   ...this.#stats
  });
 }
 playbackStarted(){
  if(this.#phase==='capture'){
   this.#stats.blockedOverlaps++;
   throw Error('VOICE_DUPLEX_CAPTURE_ACTIVE');
  }
  if(this.#phase!=='playback')this.#stats.playbackStarts++;
  this.#phase='playback';this.#cooldownUntil=0;
  return this.snapshot();
 }
 playbackStopped({bargeIn=false}={}){
  const now=this.clock();
  if(this.#phase==='playback'||bargeIn){
   this.#lastPlaybackEnd=now;
   this.#cooldownUntil=now+(bargeIn?this.bargeInCooldownMs:this.cooldownMs);
  }
  if(bargeIn)this.#stats.bargeIns++;
  this.#phase='idle';
  return this.snapshot();
 }
 captureStopped(){
  if(this.#phase==='capture')this.#phase='idle';
  return this.snapshot();
 }
 async beforeCapture({bargeIn=false,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(typeof sleep!=='function')throw Error('INVALID_VOICE_DUPLEX_SLEEP');
  if(this.#phase==='playback'){
   if(!bargeIn){
    this.#stats.blockedOverlaps++;
    throw Error('VOICE_DUPLEX_PLAYBACK_ACTIVE');
   }
   this.playbackStopped({bargeIn:true});
  }
  if(this.#phase==='capture')throw Error('VOICE_DUPLEX_CAPTURE_ACTIVE');
  const wait=Math.max(0,Math.ceil(this.#cooldownUntil-this.clock()));
  if(wait>0){
   this.#stats.cooldownWaits++;this.#stats.cooldownWaitMs+=wait;
   await sleep(wait);
  }
  if(this.#phase==='playback'){
   this.#stats.blockedOverlaps++;
   throw Error('VOICE_DUPLEX_PLAYBACK_RESTARTED');
  }
  this.#phase='capture';this.#stats.captureStarts++;
  return this.snapshot();
 }
 reset(){
  this.#phase='idle';this.#cooldownUntil=0;this.#lastPlaybackEnd=null;
  return this.snapshot();
 }
}
globalThis.AlexVoiceDuplexGuard=AlexVoiceDuplexGuard;
