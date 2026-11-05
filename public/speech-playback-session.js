// R9 playback-only Web Audio bridge. User explicitly requests streaming
// speech for a selected reply; it never invokes chat/Skill/device APIs.
// Only two ~100ms PCM frames may be scheduled ahead. Each real playback
// onended callback ACKs its frame. These remain client claims, not proof.
// No audio/voice sample is saved in localStorage, disk or IndexedDB.
class AlexStreamingSpeechBridge {
 #epoch=0;#phase='idle';#session=null;#ctx=null;
 #sources=new Set();#poller=null;#controller=null;#fetching=false;
 #seq=0;#nextTime=0;#drained=false;#pendingAck=0;
 #firstAudioAt=null;#starves=0;#playedSamples=0;
 constructor({fetchFn=fetch,
   contextFactory=()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)(),
   scheduler=setInterval,clearScheduler=clearInterval,
   clock=()=>Date.now(),onStatus=()=>{}}={}){
  Object.assign(this,{fetchFn,contextFactory,scheduler,clearScheduler,
    clock,onStatus});
 }
 snapshot(){return Object.freeze({phase:this.#phase,epoch:this.#epoch,
   playing:this.#phase==='playing'||this.#phase==='buffering',
   sessionId:this.#session,queued:this.#sources.size,
   nextSeq:this.#seq,playedMsClaimed:Math.round(this.#playedSamples/24),
   firstAudioMs:this.#firstAudioAt,underruns:this.#starves});}
 #set(phase,message){
  this.#phase=phase;
  this.onStatus({phase,message,...this.snapshot()});
 }
 #cancelRemote(id){
  if(!id)return;
  void this.fetchFn('/api/audio/playback/cancel',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({id})
  }).catch(()=>{});
 }
 interrupt(reason='user-barge-in'){
  const id=this.#session;
  this.#epoch++;
  this.#controller?.abort();this.#controller=null;
  if(this.#poller!==null){this.clearScheduler(this.#poller);this.#poller=null;}
  for(const source of this.#sources){
   source.onended=null;
   try{source.stop();}catch{}
   try{source.disconnect();}catch{}
  }
  this.#sources.clear();
  try{void this.#ctx?.close?.();}catch{}
  this.#ctx=null;this.#session=null;this.#fetching=false;
  this.#seq=0;this.#nextTime=0;this.#drained=false;
  this.#pendingAck=0;this.#firstAudioAt=null;
  this.#starves=0;this.#playedSamples=0;
  this.#cancelRemote(id);
  this.#set('idle',reason);
 }
 async play(text,{language='zh'}={}){
  if(typeof text!=='string'||!text.trim()||text.length>500)
   throw Error('INVALID_AUDIO_TEXT');
  if(!['zh','en'].includes(language))
   throw Error('INVALID_AUDIO_LANGUAGE');
  this.interrupt('new-speech');
  const epoch=++this.#epoch;
  const controller=new AbortController();this.#controller=controller;
  this.#set('requesting','正在请求播放许可和 Web Audio 输出；第三方将处理选定的回复文字。');
  let id;
  try{
   const ctx=this.contextFactory();
   if(!ctx?.createBuffer||!ctx?.createBufferSource||!ctx?.resume)
    throw Error('BROWSER_AUDIO_CONTEXT_UNSUPPORTED');
   this.#ctx=ctx;
   await ctx.resume(); // must be part of a user-initiated browser gesture
   if(epoch!==this.#epoch)throw Error('AUDIO_REQUEST_CANCELLED');
   const response=await this.fetchFn('/api/audio/playback/start',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:text.trim()}),signal:controller.signal
   });
   if(!response.ok){
    const detail=await response.json().catch(()=>({}));
    throw Error(detail.error??'SPEECH_PLAYBACK_START_FAILED');
   }
   const session=(await response.json()).session;
   if(typeof session?.id!=='string'||session.format!=='pcm16-mono-24khz'
     ||session.sampleRate!==24000||session.maxUnacknowledged!==3)
    throw Error('SPEECH_PLAYBACK_INVALID_SESSION');
   id=session.id;
   if(epoch!==this.#epoch){
    this.#cancelRemote(id);throw Error('AUDIO_REQUEST_CANCELLED');
   }
   this.#session=id;this.#seq=0;this.#drained=false;
   this.#nextTime=ctx.currentTime;
   this.#set('buffering','准备接收流式 PCM16 音频，最多预缓冲两片。');
   this.#poller=this.scheduler(()=>void this.#pump(epoch,id),50);
   void this.#pump(epoch,id);
   return this.snapshot();
  }catch(error){
   if(epoch===this.#epoch){
    this.interrupt('speech-start-failed');
    this.#set('error',error.message??'SPEECH_PLAYBACK_START_FAILED');
   }else if(id)this.#cancelRemote(id);
   throw error;
  }
 }
 async #pump(epoch,id){
  if(this.#fetching||epoch!==this.#epoch
    ||!['buffering','playing'].includes(this.#phase)||this.#drained)
   return;
  this.#fetching=true;
  try{
   while(epoch===this.#epoch&&!this.#drained
     &&this.#sources.size<2){
    const response=await this.fetchFn('/api/audio/playback/next',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({id,seq:this.#seq}),
     signal:this.#controller?.signal
    });
    if(epoch!==this.#epoch)return;
    if(response.status===204){
     this.#drained=true;
     this.#completeIfReady(epoch);break;
    }
    if(!response.ok){
     const detail=await response.json().catch(()=>({}));
     throw Error(detail.error??'SPEECH_PLAYBACK_CHUNK_FAILED');
    }
    const expectedSeq=Number(response.headers.get('x-alex-speech-seq'));
    const samples=Number(response.headers.get('x-alex-speech-samples'));
    const binary=await response.arrayBuffer();
    if(epoch!==this.#epoch)return;
    if(expectedSeq!==this.#seq||!Number.isSafeInteger(samples)
      ||samples<1||samples>2400||binary.byteLength!==samples*2)
     throw Error('SPEECH_PLAYBACK_INVALID_CHUNK');
    const ctx=this.#ctx;
    const buffer=ctx.createBuffer(1,samples,24000);
    const output=buffer.getChannelData(0);
    const raw=new DataView(binary);
    for(let i=0;i<samples;i++)
     output[i]=raw.getInt16(i*2,true)/32768;
    const source=ctx.createBufferSource();
    source.buffer=buffer;source.connect(ctx.destination);
    const now=ctx.currentTime;
    if(this.#seq>0&&this.#nextTime<now-0.03)this.#starves++;
    const when=Math.max(now+0.02,this.#nextTime);
    this.#nextTime=when+samples/24000;
    const seq=this.#seq++;
    this.#sources.add(source);
    source.onended=()=>{
     this.#sources.delete(source);
     try{source.disconnect();}catch{}
     if(epoch!==this.#epoch)return;
     this.#pendingAck++;
     void this.#ack(epoch,id,seq,samples);
     this.#completeIfReady(epoch);
    };
    source.start(when);
    if(this.#firstAudioAt===null){
     this.#firstAudioAt=this.clock();
     this.#set('playing','已开始逐片播放第三方生成的语音。点击停止或开始录音可以打断。');
    }
   }
  }catch(error){
   if(epoch===this.#epoch){
    this.interrupt('speech-stream-failed');
    this.#set('error',error.message??'SPEECH_PLAYBACK_STREAM_FAILED');
   }
  }finally{
   if(epoch===this.#epoch)this.#fetching=false;
  }
 }
 async #ack(epoch,id,seq,samples){
  try{
   const response=await this.fetchFn('/api/audio/playback/ack',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id,seq}),
    signal:this.#controller?.signal
   });
   if(!response.ok){
    const detail=await response.json().catch(()=>({}));
    throw Error(detail.error??'SPEECH_PLAYBACK_ACK_FAILED');
   }
   const data=await response.json();
   if(epoch!==this.#epoch)return;
   if(data.acknowledgedSeq!==seq)
    throw Error('SPEECH_PLAYBACK_ACK_MISMATCH');
   this.#playedSamples+=samples;
  }catch(error){
   if(epoch===this.#epoch){
    this.interrupt('speech-ack-failed');
    this.#set('error',error.message??'SPEECH_PLAYBACK_ACK_FAILED');
   }
  }finally{
   if(epoch===this.#epoch){
    this.#pendingAck--;
    this.#completeIfReady(epoch);
    void this.#pump(epoch,id);
   }
  }
 }
 #completeIfReady(epoch){
  if(epoch!==this.#epoch||!this.#drained||
    this.#sources.size||this.#pendingAck)return;
  if(this.#poller!==null){this.clearScheduler(this.#poller);this.#poller=null;}
  try{void this.#ctx?.close?.();}catch{}
  this.#ctx=null;this.#session=null;this.#controller=null;
  this.#set('complete','流式语音已播放完毕（仅按客户端播放事件统计）。');
 }
}
globalThis.AlexStreamingSpeechBridge=AlexStreamingSpeechBridge;
