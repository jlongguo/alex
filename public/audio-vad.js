// Client-side energy-based endpoint detection only. This is not a trained
// VAD model, speaker identification, voice biometrics or speech recognition.
// Audio samples are never stored; only RMS/noise floor and timing are kept.
class AlexEnergyTurnDetector {
  constructor({frameMs=80,threshold=0.025,noiseRatio=3,
    minSpeechMs=240,hangoverMs=840,noSpeechTimeoutMs=4800,
    maxDurationMs=15000}={}){
    const values=[frameMs,threshold,noiseRatio,minSpeechMs,
      hangoverMs,noSpeechTimeoutMs,maxDurationMs];
    if(values.some(x=>!Number.isFinite(x)||x<=0)
      ||frameMs>500||threshold>=1||noiseRatio<1
      ||minSpeechMs>maxDurationMs||hangoverMs>maxDurationMs)
      throw new Error('INVALID_AUDIO_VAD_CONFIG');
    Object.assign(this,{frameMs,threshold,noiseRatio,minSpeechMs,
      hangoverMs,noSpeechTimeoutMs,maxDurationMs});
    this.reset();
  }
  reset(){
    this.state='waiting';this.noiseFloor=0.004;
    this.candidateMs=0;this.speechMs=0;this.silenceMs=0;
    this.elapsedMs=0;this.maxRms=0;this.voiceDetected=false;
    return this.snapshot();
  }
  snapshot(){
    return Object.freeze({state:this.state,elapsedMs:this.elapsedMs,
      voiceDetected:this.voiceDetected,noiseFloor:this.noiseFloor,
      maxRms:this.maxRms,reason:this.reason??null});
  }
  feed(rms,elapsedMs){
    if(!Number.isFinite(rms)||rms<0||rms>1
      ||!Number.isFinite(elapsedMs)||elapsedMs<0)
      throw new Error('INVALID_AUDIO_VAD_FRAME');
    if(['complete','timeout'].includes(this.state))return this.snapshot();
    if(elapsedMs<this.elapsedMs)throw new Error('INVALID_AUDIO_VAD_TIME_ORDER');
    const advance=Math.min(this.frameMs*2,Math.max(0,elapsedMs-this.elapsedMs));
    this.elapsedMs=elapsedMs;
    this.maxRms=Math.max(this.maxRms,rms);
    const active=rms>=Math.max(this.threshold,this.noiseFloor*this.noiseRatio);
    if(this.state==='waiting'){
      if(active){
        this.candidateMs+=advance;
        if(this.candidateMs>=this.minSpeechMs){
          this.state='speaking';this.voiceDetected=true;
          this.speechMs=this.candidateMs;
        }
      }else{
        this.candidateMs=0;
        // Adapt only while waiting; once speech begins the threshold cannot
        // drift upward and prematurely suppress a quiet speaker.
        this.noiseFloor=Math.min(0.1,this.noiseFloor*0.9+rms*0.1);
      }
    }else if(this.state==='speaking'){
      if(active){this.speechMs+=advance;this.silenceMs=0;}
      else{
        this.silenceMs+=advance;
        if(this.silenceMs>=this.hangoverMs){
          this.state='complete';this.reason='end-of-speech';
        }
      }
    }
    if(this.state==='waiting'&&elapsedMs>=this.noSpeechTimeoutMs){
      this.state='timeout';this.reason='no-speech';
    }
    if(elapsedMs>=this.maxDurationMs&&!['complete','timeout'].includes(this.state)){
      this.state=this.voiceDetected?'complete':'timeout';
      this.reason=this.voiceDetected?'duration-limit':'no-speech';
    }
    return this.snapshot();
  }
}
class AlexEnergyAudioMonitor {
  #ctx=null;#source=null;#analyser=null;#timer=null;#started=0;#buffer=null;
  constructor({contextFactory=null,clock=()=>performance.now(),
    scheduler=setInterval,clearScheduler=clearInterval,
    onEnd=()=>{},onLevel=()=>{},frameMs=80,detector=null}={}){
    this.contextFactory=contextFactory;this.clock=clock;
    this.scheduler=scheduler;this.clearScheduler=clearScheduler;
    this.onEnd=onEnd;this.onLevel=onLevel;this.frameMs=frameMs;
    this.detector=detector??new AlexEnergyTurnDetector({frameMs});
  }
  async start(stream){
    if(this.#ctx)throw new Error('AUDIO_VAD_ALREADY_RUNNING');
    const factory=this.contextFactory??(()=>{
      const Ctor=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Ctor)throw new Error('AUDIO_VAD_UNSUPPORTED');
      return new Ctor();
    });
    const ctx=factory();
    try{
      this.#source=ctx.createMediaStreamSource(stream);
      this.#analyser=ctx.createAnalyser();
      this.#analyser.fftSize=1024;
      this.#analyser.smoothingTimeConstant=0;
      this.#source.connect(this.#analyser);
      this.#buffer=new Float32Array(this.#analyser.fftSize);
      this.#ctx=ctx;this.detector.reset();this.#started=this.clock();
      this.#timer=this.scheduler(()=>this.sample(),this.frameMs);
      return {active:true,kind:'energy-heuristic',frameMs:this.frameMs};
    }catch(error){
      try{this.#source?.disconnect();}catch{}
      await ctx.close?.().catch(()=>{});
      this.#source=null;this.#analyser=null;this.#buffer=null;
      throw error;
    }
  }
  sample(){
    if(!this.#analyser)return null;
    this.#analyser.getFloatTimeDomainData(this.#buffer);
    let sum=0;
    for(const sample of this.#buffer)sum+=sample*sample;
    const rms=Math.sqrt(sum/this.#buffer.length);
    const event=this.detector.feed(Math.min(1,rms),
      Math.max(0,this.clock()-this.#started));
    this.onLevel({rms:event.maxRms,state:event.state,
      elapsedMs:event.elapsedMs}); // no samples or transcription content
    if(event.state==='complete'||event.state==='timeout'){
      this.stop();
      this.onEnd({reason:event.reason,voiceDetected:event.voiceDetected,
        elapsedMs:event.elapsedMs});
    }
    return event;
  }
  stop(){
    if(this.#timer!==null){this.clearScheduler(this.#timer);this.#timer=null;}
    try{this.#source?.disconnect();}catch{}
    try{void this.#ctx?.close?.();}catch{}
    this.#ctx=null;this.#source=null;this.#analyser=null;this.#buffer=null;
  }
}
globalThis.AlexEnergyTurnDetector=AlexEnergyTurnDetector;
globalThis.AlexEnergyAudioMonitor=AlexEnergyAudioMonitor;
