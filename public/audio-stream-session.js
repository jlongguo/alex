// R7 browser incremental *ingress* bridge. Chunk upload happens while
// recording, after an explicit user click + browser permission. The server
// only calls its batch ASR provider after /finish; NEVER sends chat itself.
class AlexStreamingAudioBridge {
  #epoch=0;#state='idle';#turnId=null;#recorder=null;
  #stream=null;#monitor=null;#controller=null;#timer=null;
  #pending=Promise.resolve();#seq=0;#bytes=0;#mime=null;#language='zh';
  constructor({fetchFn=fetch,mediaDevices=navigator.mediaDevices,
    recorderFactory=(stream,options)=>new MediaRecorder(stream,options),
    supports=type=>MediaRecorder.isTypeSupported(type),
    monitorFactory=()=>new globalThis.AlexEnergyAudioMonitor(),
    onTranscript=()=>{},onStatus=()=>{}}={}){
    Object.assign(this,{fetchFn,mediaDevices,recorderFactory,
      supports,monitorFactory,onTranscript,onStatus});
  }
  snapshot(){return Object.freeze({state:this.#state,epoch:this.#epoch,
    recording:this.#state==='recording',turnId:this.#turnId,
    sentChunks:this.#seq,sentBytes:this.#bytes});}
  #set(state,message){
    this.#state=state;this.onStatus({state,message,
      sentChunks:this.#seq,sentBytes:this.#bytes});
  }
  #dropMic(){
    if(this.#timer!==null){clearTimeout(this.#timer);this.#timer=null;}
    try{this.#monitor?.stop?.();}catch{}
    this.#monitor=null;
    try{for(const track of this.#stream?.getTracks?.()??[])track.stop();}catch{}
    this.#stream=null;
  }
  #cancelServer(id){
    if(!id)return;
    void this.fetchFn('/api/audio/turn/cancel',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id})
    }).catch(()=>{});
  }
  interrupt(reason='user-cancel'){
    const id=this.#turnId;
    this.#epoch++;
    this.#controller?.abort();this.#controller=null;
    const recorder=this.#recorder;this.#recorder=null;
    try{if(recorder?.state==='recording')recorder.stop();}catch{}
    this.#dropMic();this.#turnId=null;
    this.#seq=0;this.#bytes=0;this.#pending=Promise.resolve();
    this.#cancelServer(id);
    this.#set('idle',reason);
    return this.snapshot();
  }
  async startCapture({language='zh',autoStopOnSilence=false}={}){
    if(!['zh','en'].includes(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    if(!this.mediaDevices?.getUserMedia||typeof this.recorderFactory!=='function'
      ||typeof this.supports!=='function')
      throw new Error('BROWSER_RECORDER_UNSUPPORTED');
    this.interrupt('start-incremental-capture');
    const epoch=++this.#epoch;
    const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg']
      .find(type=>this.supports(type));
    if(!mime)throw new Error('BROWSER_RECORDER_UNSUPPORTED');
    this.#mime=mime.split(';')[0];this.#language=language;
    this.#set('requesting','请在浏览器确认麦克风权限；此模式会在录音期间持续传输短片段给 Alex。');
    let stream;
    try{stream=await this.mediaDevices.getUserMedia({
      audio:{channelCount:1,noiseSuppression:true,echoCancellation:true},video:false
    });}catch{
      if(epoch===this.#epoch)this.#set('error','MICROPHONE_PERMISSION_DENIED');
      throw new Error('MICROPHONE_PERMISSION_DENIED');
    }
    if(epoch!==this.#epoch){
      for(const track of stream.getTracks())track.stop();
      throw new Error('AUDIO_REQUEST_CANCELLED');
    }
    this.#stream=stream;
    let recorder;
    try{recorder=this.recorderFactory(stream,{mimeType:mime});}
    catch{this.#dropMic();throw new Error('BROWSER_RECORDER_UNSUPPORTED');}
    const controller=new AbortController();this.#controller=controller;
    let opened;
    try{
      const response=await this.fetchFn('/api/audio/turn/start',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({mime:this.#mime,language}),signal:controller.signal
      });
      if(!response.ok){
        const problem=await response.json().catch(()=>({}));
        throw new Error(problem.error??'AUDIO_TURN_START_FAILED');
      }
      opened=(await response.json()).turn;
      if(typeof opened?.id!=='string'||!opened.id)
        throw new Error('AUDIO_TURN_START_FAILED');
    }catch(error){
      if(epoch===this.#epoch){
        this.#dropMic();this.#set('error',error.message??'AUDIO_TURN_START_FAILED');
      }
      throw error;
    }
    if(epoch!==this.#epoch){
      this.#cancelServer(opened.id);
      throw new Error('AUDIO_REQUEST_CANCELLED');
    }
    const id=opened.id;
    this.#turnId=id;this.#recorder=recorder;this.#seq=0;this.#bytes=0;
    this.#pending=Promise.resolve();
    recorder.ondataavailable=event=>{
      if(epoch!==this.#epoch||!event.data?.size)return;
      const data=event.data;
      this.#pending=this.#pending.then(async()=>{
        for(let offset=0;offset<data.size;offset+=64*1024){
          if(epoch!==this.#epoch)throw new Error('AUDIO_REQUEST_CANCELLED');
          const part=data.slice(offset,Math.min(offset+64*1024,data.size));
          if(this.#bytes+part.size>1_500_000)
            throw new Error('INVALID_AUDIO_BYTES');
          const response=await this.fetchFn('/api/audio/turn/chunk',{
            method:'POST',headers:{
              'Content-Type':this.#mime,'X-Alex-Turn-Id':id,
              'X-Alex-Chunk-Seq':String(this.#seq)
            },body:part,signal:controller.signal
          });
          if(!response.ok){
            const problem=await response.json().catch(()=>({}));
            throw new Error(problem.error??'AUDIO_CHUNK_UPLOAD_FAILED');
          }
          const receipt=await response.json();
          if(receipt.nextSeq!==this.#seq+1)
            throw new Error('INVALID_AUDIO_CHUNK_ACK');
          this.#seq++;this.#bytes+=part.size;
        }
      }).catch(error=>{
        if(epoch===this.#epoch){
          this.interrupt('chunk-upload-failed');
          this.#set('error',error.message??'AUDIO_CHUNK_UPLOAD_FAILED');
        }
        throw error;
      });
      // This promise is awaited when the recorder stops. Attach a rejection
      // handler now so upload failure never becomes an unhandled rejection.
      void this.#pending.catch(()=>{});
    };
    recorder.onerror=()=>{
      if(epoch!==this.#epoch)return;
      this.interrupt('recorder-error');
      this.#set('error','BROWSER_RECORDING_FAILED');
    };
    recorder.onstop=async()=>{
      if(epoch!==this.#epoch)return;
      this.#recorder=null;this.#dropMic();
      this.#set('finishing','已停止录音，正在等待剩余片段上传。');
      try{
        await this.#pending;
        if(epoch!==this.#epoch)return;
        if(this.#seq===0)throw new Error('INVALID_AUDIO_BYTES');
        this.#set('transcribing','片段到达 Alex；供应商仍在进行批量语音转写。');
        const response=await this.fetchFn('/api/audio/turn/finish',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({id}),signal:controller.signal
        });
        if(!response.ok){
          const problem=await response.json().catch(()=>({}));
          throw new Error(problem.error??'AUDIO_TURN_FINISH_FAILED');
        }
        const result=await response.json();
        if(typeof result.text!=='string'||!result.text.trim()||result.text.length>500
          ||result.requiresManualSubmit!==true)
          throw new Error('AUDIO_TURN_INVALID_TRANSCRIPT');
        if(epoch!==this.#epoch)return;
        this.#turnId=null;this.#controller=null;
        this.onTranscript({text:result.text,requiresManualSubmit:true,
          metrics:result.metrics});
        this.#set('idle','转写结果仅填入文字框，需要再次点击发送。');
      }catch(error){
        if(epoch===this.#epoch){
          this.interrupt('stream-finish-error');
          this.#set('error',error.message??'AUDIO_TURN_FINISH_FAILED');
        }
      }
    };
    try{recorder.start(250);}
    catch{
      this.interrupt('recorder-start-failed');
      throw new Error('BROWSER_RECORDING_FAILED');
    }
    this.#set('recording','增量上传已开始；音频片段会在录音期间持续发送给 Alex。');
    const duration=Math.min(14900,opened.maxDurationMs??14900);
    this.#timer=setTimeout(()=>{
      if(epoch===this.#epoch&&this.#recorder===recorder)this.stopCapture();
    },duration);
    if(autoStopOnSilence){
      try{
        const monitor=this.monitorFactory();
        this.#monitor=monitor;
        void monitor.start(stream,{
          onEnd:({voiceDetected})=>{
            if(epoch!==this.#epoch)return;
            if(!voiceDetected){
              this.interrupt('no-voice-detected');
              this.#set('error','没有检测到明显声音；未继续提交 ASR。');
            }else this.stopCapture();
          }
        }).catch(()=>{});
      }catch{/* No AudioContext: manual stop remains available. */}
    }
    return this.snapshot();
  }
  stopCapture(){
    if(this.#state!=='recording'||this.#recorder?.state!=='recording')return false;
    try{this.#recorder.stop();}
    catch{
      this.interrupt('recorder-stop-failed');
      throw new Error('BROWSER_RECORDING_FAILED');
    }
    this.#set('finishing','结束录音，正在上传最后片段。');
    return true;
  }
}
globalThis.AlexStreamingAudioBridge=AlexStreamingAudioBridge;
