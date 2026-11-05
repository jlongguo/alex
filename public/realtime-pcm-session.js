// R8 experimental full path: user-clicked AudioWorklet PCM16 -> Alex HTTP
// frames -> upstream transcription-only WSS Provider -> preview for manual
// send. No auto chat, realtime model voice output, robot tooling or storage.
class AlexRealtimePcmBridge {
  #epoch=0;#phase='idle';#turnId=null;#ctx=null;#source=null;
  #worklet=null;#gain=null;#stream=null;#timer=null;
  #poller=null;#flush=null;#controller=null;#pending=Promise.resolve();
  #queued=0;#seq=0;#bytes=0;#lastPartial='';
  constructor({fetchFn=fetch,mediaDevices=navigator.mediaDevices,
    contextFactory=()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)(),
    workletFactory=(ctx)=>new AudioWorkletNode(ctx,'alex-pcm16-capture'),
    onPartial=()=>{},onTranscript=()=>{},onStatus=()=>{}}={}){
    Object.assign(this,{fetchFn,mediaDevices,contextFactory,workletFactory,
      onPartial,onTranscript,onStatus});
  }
  snapshot(){return Object.freeze({
    phase:this.#phase,epoch:this.#epoch,recording:this.#phase==='recording',
    turnId:this.#turnId,frames:this.#seq,pcmBytes:this.#bytes,
    queued:this.#queued
  });}
  #set(phase,message){
    this.#phase=phase;
    this.onStatus({phase,message,frames:this.#seq,pcmBytes:this.#bytes});
  }
  #releaseMic(){
    if(this.#timer!==null){clearTimeout(this.#timer);this.#timer=null;}
    if(this.#poller!==null){clearInterval(this.#poller);this.#poller=null;}
    this.#flush?.();
    this.#flush=null;
    try{this.#worklet?.port?.postMessage({type:'stop'});}catch{}
    try{this.#worklet?.disconnect?.();}catch{}
    try{this.#gain?.disconnect?.();}catch{}
    try{this.#source?.disconnect?.();}catch{}
    this.#source=null;this.#worklet=null;this.#gain=null;
    try{void this.#ctx?.close?.();}catch{}
    this.#ctx=null;
    try{for(const track of this.#stream?.getTracks?.()??[])track.stop();}catch{}
    this.#stream=null;
  }
  #cancelServer(id){
    if(!id)return;
    void this.fetchFn('/api/audio/realtime/cancel',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id})
    }).catch(()=>{});
  }
  interrupt(reason='user-cancel'){
    const id=this.#turnId;
    this.#epoch++;
    this.#controller?.abort();this.#controller=null;
    this.#releaseMic();this.#turnId=null;
    this.#queued=0;this.#pending=Promise.resolve();this.#lastPartial='';
    this.#seq=0;this.#bytes=0;
    this.#cancelServer(id);
    this.#set('idle',reason);
    return this.snapshot();
  }
  async start({language='zh'}={}){
    if(!['zh','en'].includes(language))throw Error('INVALID_AUDIO_LANGUAGE');
    if(!this.mediaDevices?.getUserMedia)throw Error('BROWSER_MICROPHONE_UNSUPPORTED');
    this.interrupt('start-live-transcription');
    const epoch=++this.#epoch;
    this.#set('requesting','正在请求麦克风权限；开始后会向配置的第三方实时转写服务发送 PCM 音频。');
    let stream;
    try{stream=await this.mediaDevices.getUserMedia({
      audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false
    });}catch{
      if(epoch===this.#epoch)this.#set('error','MICROPHONE_PERMISSION_DENIED');
      throw Error('MICROPHONE_PERMISSION_DENIED');
    }
    if(epoch!==this.#epoch){
      for(const track of stream.getTracks())track.stop();
      throw Error('AUDIO_REQUEST_CANCELLED');
    }
    this.#stream=stream;
    const controller=new AbortController();this.#controller=controller;
    let id;
    try{
      const response=await this.fetchFn('/api/audio/realtime/start',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({language}),signal:controller.signal
      });
      if(!response.ok){
        const json=await response.json().catch(()=>({}));
        throw Error(json.error??'AUDIO_REALTIME_START_FAILED');
      }
      const result=await response.json();
      if(!result.session?.id)throw Error('AUDIO_REALTIME_INVALID_SESSION');
      id=result.session.id;
      if(epoch!==this.#epoch){
        this.#cancelServer(id);throw Error('AUDIO_REQUEST_CANCELLED');
      }
      this.#turnId=id;
      const ctx=this.contextFactory();
      if(!ctx?.audioWorklet?.addModule||!ctx.createMediaStreamSource)
        throw Error('BROWSER_AUDIO_WORKLET_UNSUPPORTED');
      this.#ctx=ctx;
      await ctx.audioWorklet.addModule('/pcm-capture-processor.js');
      if(epoch!==this.#epoch)throw Error('AUDIO_REQUEST_CANCELLED');
      const source=ctx.createMediaStreamSource(stream);
      const node=this.workletFactory(ctx);
      const mute=ctx.createGain();
      mute.gain.value=0; // essential: never loop microphone into speakers
      source.connect(node);node.connect(mute);mute.connect(ctx.destination);
      this.#source=source;this.#worklet=node;this.#gain=mute;
      node.port.onmessage=event=>{
        if(epoch!==this.#epoch)return;
        if(event.data?.type==='pcm'&&event.data.buffer instanceof ArrayBuffer)
          this.#frame(event.data.buffer,epoch,id);
        else if(event.data?.type==='flushed'){
          this.#flush?.();this.#flush=null;
        }
      };
      await ctx.resume?.();
      if(epoch!==this.#epoch)throw Error('AUDIO_REQUEST_CANCELLED');
      this.#set('recording','正在传输 PCM16/24k 音频帧；识别预览不会自动发送。');
      this.#poller=setInterval(()=>void this.#poll(epoch,id),400);
      this.#timer=setTimeout(()=>{
        if(epoch===this.#epoch&&this.#phase==='recording')
          void this.stop();
      },14900);
      return this.snapshot();
    }catch(error){
      if(epoch===this.#epoch){
        this.interrupt('realtime-start-failed');
        this.#set('error',error.message??'AUDIO_REALTIME_START_FAILED');
      }
      throw error;
    }
  }
  #frame(buffer,epoch,id){
    // Worklet flush can emit its final short PCM frame *after* stop()
    // moved the UI to flushing; accept it before the flushed ACK.
    if(!['recording','flushing'].includes(this.#phase))return;
    if(buffer.byteLength<2||buffer.byteLength>9600||buffer.byteLength%2
      ||this.#bytes+buffer.byteLength>720000||this.#queued>=5){
      this.interrupt('realtime-backpressure-or-invalid-frame');
      this.#set('error','AUDIO_REALTIME_BACKPRESSURE');
      return;
    }
    this.#queued++;
    const bytes=new Uint8Array(buffer);
    this.#pending=this.#pending.then(async()=>{
      if(epoch!==this.#epoch)throw Error('AUDIO_REQUEST_CANCELLED');
      const response=await this.fetchFn('/api/audio/realtime/frame',{
        method:'POST',
        headers:{'Content-Type':'application/octet-stream',
          'X-Alex-Realtime-Id':id,'X-Alex-Frame-Seq':String(this.#seq)},
        body:bytes,signal:this.#controller.signal
      });
      if(!response.ok){
        const body=await response.json().catch(()=>({}));
        throw Error(body.error??'AUDIO_REALTIME_FRAME_FAILED');
      }
      const receipt=await response.json();
      if(epoch!==this.#epoch)return;
      if(receipt.nextSeq!==this.#seq+1)
        throw Error('INVALID_REALTIME_FRAME_ACK');
      this.#seq++;this.#bytes+=bytes.byteLength;
    }).catch(error=>{
      if(epoch===this.#epoch){
        this.interrupt('realtime-transport-error');
        this.#set('error',error.message??'AUDIO_REALTIME_FRAME_FAILED');
      }
      throw error;
    }).finally(()=>{
      bytes.fill(0);
      if(epoch===this.#epoch)this.#queued--;
    });
    // Consume rejections here; stop() awaits the same chain.
    void this.#pending.catch(()=>{});
  }
  async #poll(epoch,id){
    if(epoch!==this.#epoch||!['recording','committing'].includes(this.#phase))
      return;
    try{
      const response=await this.fetchFn('/api/audio/realtime/status?id='+
        encodeURIComponent(id),{cache:'no-store',signal:this.#controller?.signal});
      if(!response.ok)return;
      const info=(await response.json()).session;
      if(epoch!==this.#epoch||typeof info?.partialTranscript!=='string')return;
      if(info.partialTranscript!==this.#lastPartial){
        this.#lastPartial=info.partialTranscript;
        this.onPartial({text:info.partialTranscript,final:false});
      }
    }catch{/* best effort: don't turn telemetry polling into data loss */}
  }
  async stop(){
    if(this.#phase!=='recording')return false;
    const epoch=this.#epoch,id=this.#turnId;
    this.#set('flushing','正在清理最后 PCM 帧、等待上游实时转写完成。');
    // Keep AudioWorklet running until it acknowledges the final short frame.
    let resolveFlush;
    const flushed=new Promise(resolve=>resolveFlush=resolve);
    this.#flush=resolveFlush;
    this.#worklet?.port?.postMessage({type:'flush'});
    await Promise.race([flushed,new Promise(resolve=>setTimeout(resolve,750))]);
    if(epoch!==this.#epoch)return false;
    this.#releaseMic();
    this.#set('committing','已停止录音，等待最终转写；仅预览文字。');
    try{
      await this.#pending;
      if(epoch!==this.#epoch)return false;
      if(this.#bytes<4800)throw Error('INVALID_REALTIME_AUDIO_TOO_SHORT');
      const response=await this.fetchFn('/api/audio/realtime/commit',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id}),signal:this.#controller.signal
      });
      if(!response.ok){
        const json=await response.json().catch(()=>({}));
        throw Error(json.error??'AUDIO_REALTIME_COMMIT_FAILED');
      }
      const result=await response.json();
      if(epoch!==this.#epoch)return false;
      if(typeof result.text!=='string'||!result.text.trim()
        ||result.text.length>500||result.requiresManualSubmit!==true)
        throw Error('AUDIO_REALTIME_INVALID_TRANSCRIPT');
      this.#turnId=null;this.#controller=null;
      this.onTranscript({text:result.text,metrics:result.metrics,
        requiresManualSubmit:true});
      this.#set('idle','实时转写完成。请检查文字，再手动点击发送。');
      return true;
    }catch(error){
      if(epoch===this.#epoch){
        this.interrupt('realtime-commit-failed');
        this.#set('error',error.message??'AUDIO_REALTIME_COMMIT_FAILED');
      }
      return false;
    }
  }
}
globalThis.AlexRealtimePcmBridge=AlexRealtimePcmBridge;
