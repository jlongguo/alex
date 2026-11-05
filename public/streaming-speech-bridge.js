// R9 opted-in browser speech downlink: start, incremental pull, play, cancel.
// Does not auto-speak an AI answer or send microphone audio.
class AlexStreamingSpeechBridge {
  #epoch=0;#controller=null;#id=null;#principal=null;#running=null;
  #phase='idle';
  constructor({fetchFn=fetch,player=new globalThis.AlexStreamingSpeechPlayer(),
    onStatus=()=>{},wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    Object.assign(this,{fetchFn,player,onStatus,wait});
  }
  snapshot(){return Object.freeze({phase:this.#phase,principal:this.#principal,
    id:this.#id,epoch:this.#epoch,player:this.player.snapshot()});}
  #set(phase){this.#phase=phase;this.onStatus(this.snapshot());}
  async #cancelServer(id){
    if(!id)return;
    try{await this.fetchFn('/api/audio/speech/cancel',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id})});}catch{}
  }
  interrupt(reason='user-interrupt'){
    const id=this.#id;
    this.#epoch++;
    this.#controller?.abort();this.#controller=null;
    this.#id=null;this.#principal=null;
    this.player.interrupt(reason);
    this.#set('idle');
    void this.#cancelServer(id);
    return this.snapshot();
  }
  identityChanged(principal){
    if(this.#principal!==null&&this.#principal!==principal)
      this.interrupt('identity-change');
  }
  async start({principal,text}={}){
    if(typeof principal!=='string'||!principal||principal.length>100
      ||typeof text!=='string'||!text.trim()||text.length>1200)
      throw Error('INVALID_SPEECH_INPUT');
    this.interrupt('new-speech');
    const epoch=++this.#epoch;
    const controller=new AbortController();
    this.#controller=controller;this.#principal=principal;
    this.#set('starting');
    // AudioContext must be activated inside user gesture before network await.
    await this.player.begin({owner:principal,turn:'pending'});
    if(epoch!==this.#epoch)throw Error('SPEECH_CANCELLED');
    try{
      const response=await this.fetchFn('/api/audio/speech/start',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({text}),signal:controller.signal});
      if(!response.ok){
        const error=await response.json().catch(()=>({}));
        throw Error(error.error??'SPEECH_START_FAILED');
      }
      const json=await response.json();
      const id=json.session?.id;
      if(typeof id!=='string'||!id)throw Error('SPEECH_INVALID_SESSION');
      if(epoch!==this.#epoch){void this.#cancelServer(id);throw Error('SPEECH_CANCELLED');}
      this.#id=id;
      // Rebind the player to opaque server-side turn before the first frame.
      await this.player.begin({owner:principal,turn:id});
      if(epoch!==this.#epoch)throw Error('SPEECH_CANCELLED');
      this.#set('playing');
      this.#running=this.#pump(epoch,principal,id,controller.signal);
      void this.#running.catch(()=>{});
      return this.snapshot();
    }catch(error){
      if(epoch===this.#epoch){this.interrupt('start-failed');this.#set('error');}
      throw error;
    }
  }
  async #pump(epoch,principal,id,signal){
    try{
      while(epoch===this.#epoch&&!signal.aborted){
        // Client-side queue cap: playback catches up before retrieving more PCM.
        while(epoch===this.#epoch&&this.player.snapshot().queuedFrames>=8)
          await this.wait(25);
        if(epoch!==this.#epoch||signal.aborted)throw Error('SPEECH_CANCELLED');
        const response=await this.fetchFn('/api/audio/speech/read?id='+encodeURIComponent(id),
          {cache:'no-store',signal});
        if(!response.ok){
          const body=await response.json().catch(()=>({}));
          throw Error(body.error??'SPEECH_READ_FAILED');
        }
        const data=await response.json();
        if(epoch!==this.#epoch||signal.aborted)throw Error('SPEECH_CANCELLED');
        if(data.done===true){
          this.player.finish({owner:principal,turn:id});
          this.#set('draining');
          return;
        }
        if(typeof data.pcm!=='string'||data.pcm.length>12800
          ||!Number.isSafeInteger(data.seq)||data.sampleRate!==24000)
          throw Error('SPEECH_INVALID_FRAME');
        const raw=atob(data.pcm);
        if(raw.length<2||raw.length>9600||raw.length%2)
          throw Error('SPEECH_INVALID_FRAME');
        const pcm=new Uint8Array(raw.length);
        for(let i=0;i<raw.length;i++)pcm[i]=raw.charCodeAt(i);
        try{this.player.append({owner:principal,turn:id,seq:data.seq,
          sampleRate:24000,pcm});}finally{pcm.fill(0);}
      }
    }catch(error){
      if(epoch===this.#epoch){
        this.interrupt('speech-stream-error');
        this.#set('error');
      }
      throw error;
    }
  }
}
globalThis.AlexStreamingSpeechBridge=AlexStreamingSpeechBridge;
