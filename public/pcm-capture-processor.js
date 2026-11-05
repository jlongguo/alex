// Browser AudioWorklet: capture-only mono PCM16 24kHz in ~100ms frames.
// Input samples stay inside the AudioWorklet; do NOT persist, analyse
// speech identity, send device commands or start without a user gesture.
// AudioContext may run at 44.1k/48k; simple linear sample interpolation
// resamples to 24k. High quality production resampling needs DSP QA.
class AlexPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.targetRate=24000;
    this.ratio=this.targetRate/sampleRate;
    this.phase=0;
    this.prev=0;
    this.frame=new Int16Array(2400);
    this.used=0;
    this.active=true;
    this.port.onmessage=event=>{
      if(event.data?.type==='flush'){
        this.flush();
        this.port.postMessage({type:'flushed'});
      }else if(event.data?.type==='stop'){
        this.active=false;this.flush();
        this.port.postMessage({type:'stopped'});
      }
    };
  }
  flush(){
    if(!this.used)return;
    const payload=new Int16Array(this.used);
    payload.set(this.frame.subarray(0,this.used));
    this.port.postMessage({type:'pcm',buffer:payload.buffer},
      [payload.buffer]);
    this.frame.fill(0);this.used=0;
  }
  process(inputs){
    if(!this.active)return false;
    const channels=inputs?.[0];
    if(!channels?.length)return true;
    const length=channels[0]?.length??0;
    for(let i=0;i<length;i++){
      let x=0;
      for(const channel of channels)x+=channel[i]??0;
      x/=channels.length;
      // Anti-alias filtering is not yet production grade.
      this.phase+=this.ratio;
      if(this.phase>=1){
        const clamped=Math.max(-1,Math.min(1,(this.prev+x)/2));
        this.frame[this.used++]=Math.max(-32768,
          Math.min(32767,Math.round(clamped*32767)));
        this.phase-=1;
        if(this.used===this.frame.length)this.flush();
      }
      this.prev=x;
    }
    return true;
  }
}
registerProcessor('alex-pcm16-capture',AlexPcmCaptureProcessor);
