// R8 consent-guarded, memory-only per-principal realtime PCM16 sessions.
// Provider append occurs as each PCM chunk arrives; no assembled recording,
// no disk transcript, no conversational / device side-effects. Final text is
// a preview returned only to its verified owner (manual chat Send required).
import {randomUUID} from 'node:crypto';

const FRAME_MAX=9600; // 200ms at PCM16 mono 24kHz
const PCM_MAX=720000; // 15s
const MAX_ACTIVE=4;
const IDLE_MS=10_000;
const CAPTURE_MS=16_000;
const FINAL_MS=35_000;
const STARTS_PER_MINUTE=6;
const validId=x=>typeof x==='string'
  &&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(x);
const blank=()=>({opened:0,completed:0,cancelled:0,expired:0,failed:0,
  pcmBytes:0,frames:0,lastCaptureMs:null,lastFinalizeMs:null,
  lastFirstPartialMs:null});
export class RealtimePcmSessions {
  #sessions=new Map();
  #owners=new Map();
  #history=new Map();
  #metrics=new Map();
  constructor({provider,now=()=>Date.now(),makeId=randomUUID,
    maxActive=MAX_ACTIVE}={}){
    if(!provider||typeof provider.open!=='function')
      throw new Error('INVALID_REALTIME_PROVIDER');
    this.provider=provider;this.now=now;this.makeId=makeId;
    this.maxActive=maxActive;
  }
  #count(principal,key,additional={}){
    const item=this.#metrics.get(principal)??blank();
    item[key]=(item[key]??0)+1;
    Object.assign(item,additional);
    this.#metrics.set(principal,item);
  }
  #release(session,reason=null){
    if(this.#sessions.get(session.id)!==session)return;
    this.#sessions.delete(session.id);
    if(this.#owners.get(session.principal)===session.id)
      this.#owners.delete(session.principal);
    session.controller.abort();
    try{session.channel?.cancel?.();}catch{}
    try{session.channel?.close?.();}catch{}
    session.partial='';session.pending=false;
    if(reason)this.#count(session.principal,reason);
  }
  sweep(){
    const now=this.now();
    for(const session of this.#sessions.values()){
      if((['starting','recording'].includes(session.phase)
        &&(now-session.openedAt>CAPTURE_MS
          ||now-session.lastAt>IDLE_MS))
        ||(session.phase==='committing'
          &&now-session.lastAt>FINAL_MS)){
        this.#release(session,'expired');
      }
    }
    for(const [owner,history] of this.#history){
      const kept=history.filter(t=>now-t<60000);
      if(kept.length)this.#history.set(owner,kept);
      else this.#history.delete(owner);
    }
    return this.#sessions.size;
  }
  async start(principal,{language='zh'}={}){
    if(typeof principal!=='string'||!principal||principal.length>100)
      throw new Error('INVALID_AUDIO_PRINCIPAL');
    if(!['en','zh'].includes(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    this.sweep();
    if(this.#owners.has(principal))throw new Error('AUDIO_ALREADY_ACTIVE');
    if(this.#sessions.size>=this.maxActive)throw new Error('AUDIO_SERVER_BUSY');
    const now=this.now();
    const attempts=(this.#history.get(principal)??[]).filter(t=>now-t<60000);
    if(attempts.length>=STARTS_PER_MINUTE)throw new Error('AUDIO_RATE_LIMIT');
    attempts.push(now);this.#history.set(principal,attempts);
    const id=this.makeId();
    if(!validId(id)||this.#sessions.has(id))
      throw new Error('INVALID_REALTIME_SESSION_ID');
    const session={id,principal,language,openedAt:now,lastAt:now,
      phase:'starting',seq:0,bytes:0,partial:'',pending:false,
      controller:new AbortController(),channel:null};
    this.#sessions.set(id,session);this.#owners.set(principal,id);
    this.#count(principal,'opened');
    try{
      const channel=await this.provider.open({
        signal:session.controller.signal,
        onPartial:({text,final})=>{
          if(this.#sessions.get(id)!==session)return;
          if(typeof text==='string'&&text.length<=500)
            session.partial=text;
          session.lastTranscriptFinal=!!final;
        }
      });
      if(session.controller.signal.aborted||this.#sessions.get(id)!==session){
        channel.cancel?.();channel.close?.();
        throw new Error('AUDIO_REQUEST_CANCELLED');
      }
      session.channel=channel;session.phase='recording';session.lastAt=this.now();
      return {id,language,format:'pcm16-mono-24khz',
        maxFrameBytes:FRAME_MAX,maxAudioBytes:PCM_MAX,
        maxDurationMs:15000,transport:'incremental-http',
        upstream:'wss-realtime-transcription',transcriptMode:'preview-only'};
    }catch(error){
      if(this.#sessions.get(id)===session)this.#release(session,'failed');
      throw error;
    }
  }
  #get(principal,id){
    if(!validId(id))throw new Error('INVALID_REALTIME_SESSION_ID');
    this.sweep();
    const s=this.#sessions.get(id);
    if(!s)throw new Error('UNKNOWN_REALTIME_SESSION');
    if(s.principal!==principal)throw new Error('REALTIME_SESSION_FORBIDDEN');
    if(s.controller.signal.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
    return s;
  }
  status(principal,id){
    const s=this.#get(principal,id);
    return {id:s.id,phase:s.phase,nextSeq:s.seq,
      pcmBytes:s.bytes,partialTranscript:s.partial,
      partialFinal:!!s.lastTranscriptFinal,
      elapsedMs:Math.max(0,this.now()-s.openedAt),
      format:'pcm16-mono-24khz'};
  }
  async append(principal,id,{seq,data}={}){
    const s=this.#get(principal,id);
    if(s.phase!=='recording')throw new Error('AUDIO_REALTIME_NOT_READY');
    if(s.pending)throw new Error('AUDIO_REALTIME_BACKPRESSURE');
    if(!Number.isSafeInteger(seq)||seq!==s.seq)
      throw new Error('INVALID_REALTIME_SEQUENCE');
    if(!(data instanceof Uint8Array)||data.byteLength<2
      ||data.byteLength>FRAME_MAX||data.byteLength%2
      ||s.bytes+data.byteLength>PCM_MAX)
      throw new Error('INVALID_REALTIME_PCM_BYTES');
    if(this.now()-s.openedAt>CAPTURE_MS)
      throw new Error('INVALID_AUDIO_DURATION');
    s.pending=true;
    const scratch=Buffer.from(data);
    try{
      const result=await s.channel.append(scratch);
      if(s.controller.signal.aborted||this.#sessions.get(id)!==s)
        throw new Error('AUDIO_REQUEST_CANCELLED');
      s.seq++;s.bytes+=scratch.byteLength;s.lastAt=this.now();
      return {acceptedSeq:seq,nextSeq:s.seq,pcmBytes:s.bytes,
        providerFrames:result?.frames??s.seq};
    }catch(error){
      if(error.message==='AUDIO_REALTIME_BACKPRESSURE'
        ||error.message==='AUDIO_WS_BACKPRESSURE')
        this.#release(s,'failed');
      throw error;
    }finally{scratch.fill(0);s.pending=false;}
  }
  async commit(principal,id,{authorized=()=>{}}={}){
    const s=this.#get(principal,id);
    if(s.phase!=='recording'||s.pending)
      throw new Error('AUDIO_REALTIME_NOT_READY');
    const captureMs=this.now()-s.openedAt;
    if(s.bytes<4800||captureMs<300||captureMs>CAPTURE_MS)
      throw new Error('INVALID_REALTIME_AUDIO_TOO_SHORT');
    s.phase='committing';s.lastAt=this.now();
    const started=this.now();
    try{
      authorized();
      const result=await s.channel.commit();
      if(s.controller.signal.aborted||this.#sessions.get(id)!==s)
        throw new Error('AUDIO_REQUEST_CANCELLED');
      authorized();
      const extra={
        pcmBytes:(this.#metrics.get(principal)?.pcmBytes??0)+s.bytes,
        frames:(this.#metrics.get(principal)?.frames??0)+s.seq,
        lastCaptureMs:captureMs,lastFinalizeMs:Math.max(0,this.now()-started),
        lastFirstPartialMs:result.metrics?.firstPartialMs??null
      };
      this.#count(principal,'completed',extra);
      return {text:result.text,source:result.source,
        validated:false,requiresManualSubmit:true,
        metrics:{captureMs,finalizeMs:extra.lastFinalizeMs,
          pcmBytes:s.bytes,frames:s.seq,
          firstPartialMs:extra.lastFirstPartialMs}};
    }catch(error){
      if(this.#sessions.get(id)===s)this.#count(principal,'failed');
      throw error;
    }finally{this.#release(s);}
  }
  cancel(principal,id){
    if(id===undefined||id===null)id=this.#owners.get(principal);
    if(!validId(id))return false;
    const s=this.#sessions.get(id);
    if(!s||s.principal!==principal)return false;
    this.#release(s,'cancelled');return true;
  }
  cancelChildren(){
    for(const s of [...this.#sessions.values()])
      if(s.principal==='child'||s.principal.startsWith('learner:'))
        this.cancel(s.principal,s.id);
  }
  erasePrincipal(principal){
    this.cancel(principal);
    const had=this.#metrics.delete(principal);
    this.#history.delete(principal);
    return Number(had);
  }
  eraseScope(scope){
    if(!['parent','child','all'].includes(scope))
      throw new Error('INVALID_AUDIO_ERASE_SCOPE');
    const owners=new Set([...this.#sessions.values()].map(x=>x.principal));
    for(const key of this.#history.keys())owners.add(key);
    for(const key of this.#metrics.keys())owners.add(key);
    let deleted=0;
    for(const principal of owners){
      const child=principal==='child'||principal.startsWith('learner:');
      if(scope==='all'||(scope==='child'&&child)
        ||(scope==='parent'&&!child))
        deleted+=this.erasePrincipal(principal);
    }
    return deleted;
  }
  metrics(principal){return structuredClone(this.#metrics.get(principal)??blank());}
  activeCount(){this.sweep();return this.#sessions.size;}
}
export const REALTIME_PCM_FRAME_BYTES=FRAME_MAX;
export const REALTIME_PCM_TOTAL_BYTES=PCM_MAX;
