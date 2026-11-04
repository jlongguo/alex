// Browser-only short-clip audio transport. Does not run without an explicit
// click, server-granted consent and a browser microphone permission prompt.
// No implicit transcript send, no localStorage/IndexedDB and no audio logging.
class AlexCloudAudioBridge {
  #epoch=0;
  #recorder=null;
  #tracks=null;
  #controller=null;
  #player=null;
  #url=null;
  #timer=null;
  #started=0;
  #state='idle';
  constructor({fetchFn=fetch,mediaDevices=navigator.mediaDevices,
    recorderFactory=(stream,options)=>new MediaRecorder(stream,options),
    supports=type=>MediaRecorder.isTypeSupported(type),
    audioFactory=url=>new Audio(url),
    urlApi=URL,onTranscript=()=>{},onStatus=()=>{}}={}){
    this.fetchFn=fetchFn;this.mediaDevices=mediaDevices;
    this.recorderFactory=recorderFactory;this.supports=supports;
    this.audioFactory=audioFactory;this.urlApi=urlApi;
    this.onTranscript=onTranscript;this.onStatus=onStatus;
  }
  snapshot(){return {state:this.#state,recording:this.#state==='recording',
    epoch:this.#epoch};}
  #set(value,message){
    this.#state=value;this.onStatus({state:value,message});
  }
  #tracksOff(){
    for(const track of this.#tracks?.getTracks?.()??[])
      try{track.stop();}catch{}
    this.#tracks=null;
  }
  #dropPlayer(){
    if(this.#player){
      try{this.#player.pause();}catch{}
      this.#player=null;
    }
    if(this.#url){
      this.urlApi.revokeObjectURL(this.#url);this.#url=null;
    }
  }
  interrupt(reason='interrupted'){
    this.#epoch++;
    if(this.#timer!==null){clearTimeout(this.#timer);this.#timer=null;}
    this.#controller?.abort();this.#controller=null;
    const recorder=this.#recorder;this.#recorder=null;
    try{if(recorder?.state==='recording')recorder.stop();}catch{}
    this.#tracksOff();this.#dropPlayer();
    this.#set('idle',reason);
  }
  async startCapture({language='zh'}={}){
    if(!['zh','en'].includes(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    if(!this.mediaDevices?.getUserMedia||!this.recorderFactory||!this.supports)
      throw new Error('BROWSER_RECORDER_UNSUPPORTED');
    this.interrupt('new-capture');
    const epoch=++this.#epoch;
    const types=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'];
    const selected=types.find(type=>this.supports(type));
    if(!selected)throw new Error('BROWSER_RECORDER_UNSUPPORTED');
    let stream;
    try{stream=await this.mediaDevices.getUserMedia({audio:{
      echoCancellation:true,noiseSuppression:true,channelCount:1},video:false});}
    catch{throw new Error('MICROPHONE_PERMISSION_DENIED');}
    if(epoch!==this.#epoch){
      for(const track of stream.getTracks())track.stop();
      throw new Error('AUDIO_REQUEST_CANCELLED');
    }
    this.#tracks=stream;
    let recorder;
    try{recorder=this.recorderFactory(stream,{mimeType:selected});}
    catch{this.#tracksOff();throw new Error('BROWSER_RECORDER_UNSUPPORTED');}
    this.#recorder=recorder;
    const chunks=[];
    recorder.ondataavailable=event=>{
      if(epoch===this.#epoch&&event.data?.size)chunks.push(event.data);
    };
    recorder.onerror=()=>{
      if(epoch!==this.#epoch)return;
      this.interrupt('recorder-failed');
      this.#set('error','BROWSER_RECORDING_FAILED');
    };
    recorder.onstop=async()=>{
      if(epoch!==this.#epoch)return;
      if(this.#timer!==null){clearTimeout(this.#timer);this.#timer=null;}
      this.#recorder=null;this.#tracksOff();
      const elapsed=Math.max(300,Math.min(15000,Date.now()-this.#started));
      const clip=new Blob(chunks,{type:selected.split(';')[0]});
      chunks.length=0;
      if(clip.size<128||clip.size>1_500_000){
        this.#set('error','INVALID_AUDIO_BYTES');return;
      }
      this.#set('transcribing','录音结束，正在请求语音转写；将交由配置的服务商处理。');
      const controller=new AbortController();this.#controller=controller;
      try{
        const response=await this.fetchFn('/api/audio/transcribe',{
          method:'POST',headers:{
            'Content-Type':clip.type,'X-Alex-Audio-Duration-Ms':String(elapsed),
            'X-Alex-Language':language
          },body:clip,signal:controller.signal
        });
        if(!response.ok){
          const body=await response.json().catch(()=>({}));
          throw new Error(body.error??'AUDIO_TRANSCRIPTION_FAILED');
        }
        const result=await response.json();
        if(typeof result.text!=='string'||!result.text.trim()||result.text.length>500)
          throw new Error('INVALID_AUDIO_TRANSCRIPT');
        if(epoch!==this.#epoch)return;
        this.onTranscript({text:result.text,requiresManualSubmit:true});
        this.#set('idle','转写结果仅填入输入框，请检查后手动点击发送。');
      }catch(error){
        if(epoch===this.#epoch)this.#set('error',error.message??'AUDIO_TRANSCRIPTION_FAILED');
      }finally{if(this.#controller===controller)this.#controller=null;}
    };
    try{recorder.start(250);}
    catch{this.interrupt('recording-start-failed');throw new Error('BROWSER_RECORDING_FAILED');}
    this.#started=Date.now();
    this.#set('recording','录音中，再次点击结束，最长 15 秒；短音频上传给配置的服务商。');
    this.#timer=setTimeout(()=>{
      if(epoch===this.#epoch&&this.#recorder===recorder)this.stopCapture();
    },15000);
    return this.snapshot();
  }
  stopCapture(){
    if(this.#state!=='recording'||!this.#recorder)return false;
    try{this.#recorder.stop();}
    catch{this.interrupt('recording-stop-failed');throw new Error('BROWSER_RECORDING_FAILED');}
    this.#set('transcribing','正在结束录音...');
    return true;
  }
  async speak(text,{language='zh'}={}){
    if(typeof text!=='string'||!text.trim()||text.length>500)
      throw new Error('INVALID_AUDIO_TEXT');
    if(!['zh','en'].includes(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    this.interrupt('new-speech');
    const epoch=++this.#epoch;
    const controller=new AbortController();this.#controller=controller;
    this.#set('synthesizing','云端正在合成语音...');
    try{
      const response=await this.fetchFn('/api/audio/speak',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({text,language}),signal:controller.signal
      });
      if(!response.ok){
        const body=await response.json().catch(()=>({}));
        throw new Error(body.error??'AUDIO_SYNTHESIS_FAILED');
      }
      const raw=await response.arrayBuffer();
      if(raw.byteLength<128||raw.byteLength>2_000_000)
        throw new Error('INVALID_AUDIO_OUTPUT');
      if(epoch!==this.#epoch)return;
      this.#url=this.urlApi.createObjectURL(new Blob([raw],{type:'audio/mpeg'}));
      const audio=this.audioFactory(this.#url);
      this.#player=audio;
      audio.onended=()=>{if(epoch===this.#epoch)this.interrupt('playback-ended');};
      audio.onerror=()=>{if(epoch===this.#epoch)this.interrupt('playback-failed');};
      await audio.play();
      if(epoch===this.#epoch)this.#set('speaking','正在播放云端合成语音，可随时停止。');
    }catch(error){
      if(epoch===this.#epoch){
        this.interrupt('audio-error');
        this.#set('error',error.message??'AUDIO_SYNTHESIS_FAILED');
      }
    }finally{if(this.#controller===controller)this.#controller=null;}
  }
}
globalThis.AlexCloudAudioBridge=AlexCloudAudioBridge;
