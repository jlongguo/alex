// R9 browser PCM playback with bounded queue and epoch-based cancellation.
// Explicit user activation required; not auto-wired to ASR or chat.
class AlexStreamingSpeechPlayer {
  #epoch=0;#ctx=null;#sources=new Set();#nextAt=0;
  #owner=null;#turn=null;#seq=0;#played=0;#queued=0;#state='idle';
  constructor({contextFactory=()=>new (globalThis.AudioContext
    ||globalThis.webkitAudioContext)(),onStatus=()=>{}}={}){
    Object.assign(this,{contextFactory,onStatus});
  }
  snapshot(){return Object.freeze({state:this.#state,owner:this.#owner,
    turn:this.#turn,epoch:this.#epoch,nextSeq:this.#seq,
    queuedFrames:this.#queued,playedFrames:this.#played});}
  #emit(){this.onStatus(this.snapshot());}
  interrupt(reason='interrupt'){
    this.#epoch++;
    for(const s of this.#sources)try{s.stop();}catch{}
    this.#sources.clear();
    try{void this.#ctx?.close?.();}catch{}
    this.#ctx=null;this.#nextAt=0;this.#owner=null;this.#turn=null;
    this.#seq=0;this.#played=0;this.#queued=0;this.#state='idle';
    this.#emit();return {reason,epoch:this.#epoch};
  }
  async begin({owner,turn}={}){
    if(typeof owner!=='string'||!owner||owner.length>100
      ||typeof turn!=='string'||!turn||turn.length>100)
      throw Error('INVALID_SPEECH_IDENTITY');
    this.interrupt('new-turn');
    const epoch=this.#epoch,ctx=this.contextFactory();
    if(!ctx?.createBuffer||!ctx.createBufferSource
      ||!Number.isFinite(ctx.currentTime))throw Error('SPEECH_AUDIO_CONTEXT_UNSUPPORTED');
    this.#ctx=ctx;this.#owner=owner;this.#turn=turn;this.#state='playing';
    try{await ctx.resume?.();}
    catch{this.interrupt('audio-denied');throw Error('SPEECH_AUDIO_DENIED');}
    if(epoch!==this.#epoch)throw Error('SPEECH_CANCELLED');
    this.#nextAt=ctx.currentTime;this.#emit();return this.snapshot();
  }
  append({owner,turn,seq,pcm,sampleRate=24000}={}){
    if(this.#state!=='playing'||owner!==this.#owner||turn!==this.#turn)
      throw Error('SPEECH_STALE_TURN');
    if(!Number.isSafeInteger(seq)||seq!==this.#seq)
      throw Error('SPEECH_INVALID_SEQUENCE');
    if(sampleRate!==24000||!(pcm instanceof Uint8Array)||pcm.length<2
      ||pcm.length>9600||pcm.length%2)throw Error('SPEECH_INVALID_PCM');
    const ctx=this.#ctx,at=Math.max(ctx.currentTime,this.#nextAt);
    if(at-ctx.currentTime>1.500001)throw Error('SPEECH_PLAYBACK_BACKPRESSURE');
    const samples=pcm.length/2,buffer=ctx.createBuffer(1,samples,24000);
    const floats=buffer.getChannelData(0);
    const view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
    for(let i=0;i<samples;i++)floats[i]=view.getInt16(i*2,true)/32768;
    const source=ctx.createBufferSource();
    source.buffer=buffer;source.connect(ctx.destination);
    const epoch=this.#epoch;
    source.onended=()=>{
      this.#sources.delete(source);
      if(epoch!==this.#epoch)return;
      this.#played++;this.#queued--;
      if(this.#state==='draining'&&!this.#queued)this.#state='complete';
      this.#emit();
    };
    this.#sources.add(source);
    try{source.start(at);}
    catch{this.#sources.delete(source);throw Error('SPEECH_PLAYBACK_FAILED');}
    this.#nextAt=at+samples/24000;this.#seq++;this.#queued++;
    this.#emit();return this.snapshot();
  }
  finish({owner,turn}={}){
    if(this.#state!=='playing'||owner!==this.#owner||turn!==this.#turn)
      throw Error('SPEECH_STALE_TURN');
    this.#state=this.#queued?'draining':'complete';
    this.#emit();return this.snapshot();
  }
  identityChanged(owner){
    if(this.#owner!==null&&owner!==this.#owner)this.interrupt('identity-changed');
  }
}
globalThis.AlexStreamingSpeechPlayer=AlexStreamingSpeechPlayer;
