// R9 memory-only per-learner outbound speech sessions. No persisted audio/text.
// Slow browsers cannot cause unbounded PCM queues; revocation aborts upstream.
import {randomUUID} from 'node:crypto';
const MAX_ACTIVE=4, MAX_QUEUED=10, TTL_MS=30000;
const frameCopy=data=>Uint8Array.from(data);
export class OutboundSpeechSessions {
  #sessions=new Map();#owners=new Map();
  constructor({provider,authorize=()=>{},now=()=>Date.now(),makeId=randomUUID,
    maxActive=MAX_ACTIVE}={}){
    if(typeof provider?.stream!=='function')throw Error('INVALID_SPEECH_PROVIDER');
    Object.assign(this,{provider,authorize,now,makeId,maxActive});
  }
  #get(principal,id){
    const s=this.#sessions.get(id);
    if(!s||s.principal!==principal)throw Error('UNKNOWN_SPEECH_SESSION');
    this.authorize(principal);
    if(s.controller.signal.aborted)throw Error('SPEECH_CANCELLED');
    return s;
  }
  #wipe(s){
    if(this.#sessions.get(s.id)!==s)return;
    this.#sessions.delete(s.id);
    if(this.#owners.get(s.principal)===s.id)this.#owners.delete(s.principal);
    s.controller.abort();
    for(const chunk of s.queue)chunk.pcm.fill(0);
    s.queue.length=0;s.text='';s.waiters.splice(0).forEach(resolve=>resolve());
  }
  cancel(principal,id=this.#owners.get(principal)){
    const s=this.#sessions.get(id);
    if(!s||s.principal!==principal)return false;
    this.#wipe(s);return true;
  }
  erasePrincipal(principal){return this.cancel(principal);}
  sweep(){
    for(const s of [...this.#sessions.values()])
      if(this.now()-s.startedAt>TTL_MS)this.#wipe(s);
    return this.#sessions.size;
  }
  start(principal,text){
    if(typeof principal!=='string'||!principal||principal.length>100
      ||typeof text!=='string'||!text.trim()||text.length>1200)
      throw Error('INVALID_SPEECH_SESSION_INPUT');
    this.sweep();this.authorize(principal);
    if(this.#owners.has(principal))throw Error('SPEECH_ALREADY_ACTIVE');
    if(this.#sessions.size>=this.maxActive)throw Error('SPEECH_SERVER_BUSY');
    const id=this.makeId();
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)||this.#sessions.has(id))
      throw Error('INVALID_SPEECH_SESSION_ID');
    const s={id,principal,text,startedAt:this.now(),controller:new AbortController(),
      queue:[],waiters:[],status:'running',error:null,seq:0,bytes:0};
    this.#sessions.set(id,s);this.#owners.set(principal,id);
    const wake=()=>s.waiters.splice(0).forEach(resolve=>resolve());
    s.task=(async()=>{
      try{
        await this.provider.stream(s.text,{
          signal:s.controller.signal,authorized:()=>this.authorize(principal),
          onFrame:async({pcm,seq,sampleRate})=>{
            if(s.controller.signal.aborted||this.#sessions.get(id)!==s)
              throw Error('SPEECH_CANCELLED');
            this.authorize(principal);
            if(sampleRate!==24000||!Number.isInteger(seq)||seq!==s.seq
              ||!(pcm instanceof Uint8Array)||!pcm.length||pcm.length%2
              ||pcm.length>9600)throw Error('SPEECH_INVALID_FRAME');
            if(s.queue.length>=MAX_QUEUED)throw Error('SPEECH_QUEUE_OVERFLOW');
            s.queue.push({seq,pcm:frameCopy(pcm),sampleRate:24000});
            s.seq++;s.bytes+=pcm.length;wake();
          }
        });
        if(this.#sessions.get(id)===s){s.status='complete';wake();}
      }catch(error){
        if(this.#sessions.get(id)===s){
          s.status='failed';s.error=error?.message??'SPEECH_PROVIDER_FAILED';
          wake();
        }
      }finally{s.text='';}
    })();
    return {id,state:'running',sampleRate:24000,maxQueueFrames:MAX_QUEUED};
  }
  async read(principal,id,{signal}={}){
    let s=this.#get(principal,id);
    if(signal?.aborted)throw Error('SPEECH_CANCELLED');
    if(!s.queue.length&&s.status==='running'){
      await new Promise(resolve=>{
        const wake=()=>{signal?.removeEventListener('abort',wake);resolve();};
        s.waiters.push(wake);
        signal?.addEventListener('abort',wake,{once:true});
      });
    }
    if(signal?.aborted)throw Error('SPEECH_CANCELLED');
    s=this.#get(principal,id);
    if(s.status==='failed'){
      const code=s.error;
      this.#wipe(s);
      throw Error(code);
    }
    const frame=s.queue.shift();
    if(frame){
      const reply={seq:frame.seq,pcm:frame.pcm,sampleRate:frame.sampleRate,
        done:false};
      // Caller owns the returned buffer and must zero it after sending.
      return reply;
    }
    if(s.status==='complete'){
      const reply={done:true,frames:s.seq,pcmBytes:s.bytes};
      this.#wipe(s);
      return reply;
    }
    throw Error('SPEECH_NO_FRAME');
  }
  activeCount(){return this.sweep();}
}
