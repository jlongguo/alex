// R7: bounded in-memory ingress sessions for *incremental browser -> Alex*
// audio chunks. The configured compatible ASR provider still receives one
// completed clip; this is NOT provider-side streaming or realtime duplex.
// Raw audio is never persisted, logged, exported, or exposed via GET.
import {randomUUID} from 'node:crypto';
import {MAX_AUDIO_MS,MAX_AUDIO_UPLOAD_BYTES,validateMime} from './audio-provider.mjs';

export const AUDIO_CHUNK_BYTES=64*1024;
export const AUDIO_MAX_CHUNKS=64;
export const AUDIO_MAX_ACTIVE=8;
export const AUDIO_TURN_TTL_MS=20_000;
export const AUDIO_IDLE_TTL_MS=10_000;
export const AUDIO_FINALIZE_TTL_MS=35_000;
const MAX_STARTS_PER_MINUTE=6;
const LANGUAGES=new Set(['en','zh']);
const idValid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(x);
const scrub=session=>{
  for(const bytes of session.parts)bytes.fill(0);
  session.parts.length=0;
  session.bytes=0;
};
export class AudioIngressSessions {
  #sessions=new Map();
  #owners=new Map();
  #starts=new Map();
  #metrics=new Map();
  constructor({now=()=>Date.now(),createId=randomUUID,maxActive=AUDIO_MAX_ACTIVE}={}){
    this.now=now;this.createId=createId;this.maxActive=maxActive;
  }
  #measure(principal,event,extra={}){
    const item=this.#metrics.get(principal)??{
      opened:0,completed:0,cancelled:0,expired:0,rejected:0,
      totalBytes:0,totalChunks:0,lastCaptureMs:null,lastProviderMs:null
    };
    item[event]=(item[event]??0)+1;
    for(const [k,v] of Object.entries(extra))item[k]=v;
    this.#metrics.set(principal,item);
  }
  #forget(session,reason='cancelled'){
    if(this.#sessions.get(session.id)!==session)return false;
    this.#sessions.delete(session.id);
    if(this.#owners.get(session.principal)===session.id)
      this.#owners.delete(session.principal);
    if(reason)this.#measure(session.principal,reason);
    scrub(session);
    return true;
  }
  sweep(){
    const now=this.now();
    for(const session of this.#sessions.values()){
      if((session.phase==='recording'
        &&(now-session.createdAt>AUDIO_TURN_TTL_MS
          ||now-session.updatedAt>AUDIO_IDLE_TTL_MS))
        ||(session.phase==='finalizing'
          &&now-session.updatedAt>AUDIO_FINALIZE_TTL_MS)){
        session.controller.abort();
        this.#forget(session,'expired');
      }
    }
    for(const [principal,times] of this.#starts){
      const live=times.filter(t=>now-t<60_000);
      if(live.length)this.#starts.set(principal,live);
      else this.#starts.delete(principal);
    }
    return this.#sessions.size;
  }
  open(principal,{mime,language='zh'}={}){
    if(typeof principal!=='string'||!principal||principal.length>100)
      throw new Error('INVALID_AUDIO_PRINCIPAL');
    const type=validateMime(mime);
    if(!LANGUAGES.has(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    this.sweep();
    if(this.#owners.has(principal))throw new Error('AUDIO_ALREADY_ACTIVE');
    if(this.#sessions.size>=this.maxActive)throw new Error('AUDIO_SERVER_BUSY');
    const now=this.now();
    const attempts=(this.#starts.get(principal)??[]).filter(t=>now-t<60_000);
    if(attempts.length>=MAX_STARTS_PER_MINUTE)throw new Error('AUDIO_RATE_LIMIT');
    attempts.push(now);this.#starts.set(principal,attempts);
    const id=this.createId();
    if(!idValid(id)||this.#sessions.has(id))throw new Error('INVALID_AUDIO_TURN_ID');
    const session={
      id,principal,mime:type,language,createdAt:now,updatedAt:now,
      phase:'recording',seq:0,bytes:0,parts:[],controller:new AbortController()
    };
    this.#sessions.set(id,session);
    this.#owners.set(principal,id);
    this.#measure(principal,'opened');
    return {id,mime:type,language,maxChunkBytes:AUDIO_CHUNK_BYTES,
      maxAudioBytes:MAX_AUDIO_UPLOAD_BYTES,maxDurationMs:MAX_AUDIO_MS,
      maxChunks:AUDIO_MAX_CHUNKS,transport:'incremental-http',
      upstream:'batch-asr-after-finish'};
  }
  #require(principal,id){
    if(!idValid(id))throw new Error('INVALID_AUDIO_TURN_ID');
    this.sweep();
    const session=this.#sessions.get(id);
    if(!session)throw new Error('UNKNOWN_AUDIO_TURN');
    if(session.principal!==principal)throw new Error('AUDIO_TURN_FORBIDDEN');
    if(session.controller.signal.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
    return session;
  }
  append(principal,id,{seq,mime,data}={}){
    const session=this.#require(principal,id);
    if(session.phase!=='recording')throw new Error('AUDIO_TURN_NOT_RECORDING');
    if(!Number.isSafeInteger(seq)||seq!==session.seq)
      throw new Error('INVALID_AUDIO_CHUNK_SEQUENCE');
    if(validateMime(mime)!==session.mime)throw new Error('INVALID_AUDIO_MIME');
    if(!(data instanceof Uint8Array)||data.byteLength<1
      ||data.byteLength>AUDIO_CHUNK_BYTES)
      throw new Error('INVALID_AUDIO_CHUNK_BYTES');
    if(session.seq>=AUDIO_MAX_CHUNKS)throw new Error('AUDIO_CHUNK_LIMIT');
    if(session.bytes+data.byteLength>MAX_AUDIO_UPLOAD_BYTES)
      throw new Error('INVALID_AUDIO_BYTES');
    const elapsed=this.now()-session.createdAt;
    if(elapsed>MAX_AUDIO_MS+500){
      session.controller.abort();this.#forget(session,'expired');
      throw new Error('INVALID_AUDIO_DURATION');
    }
    const safe=Buffer.from(data);
    session.parts.push(safe);session.bytes+=safe.byteLength;
    session.seq++;session.updatedAt=this.now();
    return {acceptedSeq:seq,nextSeq:session.seq,totalBytes:session.bytes,
      maxAudioBytes:MAX_AUDIO_UPLOAD_BYTES};
  }
  async finish(principal,id,{transcribe,authorized}={}){
    const session=this.#require(principal,id);
    if(session.phase!=='recording')throw new Error('AUDIO_ALREADY_FINISHING');
    if(typeof transcribe!=='function'||typeof authorized!=='function')
      throw new Error('INVALID_AUDIO_TASK');
    const captureMs=this.now()-session.createdAt;
    if(captureMs<300||captureMs>MAX_AUDIO_MS+500
      ||session.bytes<128||session.bytes>MAX_AUDIO_UPLOAD_BYTES
      ||session.seq<1){
      this.#measure(principal,'rejected');
      this.#forget(session,null);
      throw new Error('INVALID_AUDIO_DURATION_OR_BYTES');
    }
    session.phase='finalizing';session.updatedAt=this.now();
    const clip=Buffer.concat(session.parts,session.bytes);
    // Drop the retained individual chunks before sending the assembled
    // clip to the provider. Zero the assembled buffer in finally.
    scrub(session);
    const upstreamStart=this.now();
    try{
      authorized();
      const transcript=await transcribe({
        audio:clip,mime:session.mime,language:session.language,
        signal:session.controller.signal
      });
      if(session.controller.signal.aborted)
        throw new Error('AUDIO_REQUEST_CANCELLED');
      authorized(); // parent can revoke permission while provider is working
      const providerMs=Math.max(0,this.now()-upstreamStart);
      this.#measure(principal,'completed',{
        totalBytes:(this.#metrics.get(principal)?.totalBytes??0)+clip.byteLength,
        totalChunks:(this.#metrics.get(principal)?.totalChunks??0)+session.seq,
        lastCaptureMs:captureMs,lastProviderMs:providerMs
      });
      return {...transcript,requiresManualSubmit:true,
        metrics:{captureMs,providerMs,totalBytes:clip.byteLength,chunks:session.seq}};
    }finally{
      clip.fill(0);
      this.#forget(session,null);
    }
  }
  cancel(principal,id){
    if(id===undefined||id===null)id=this.#owners.get(principal);
    if(!idValid(id))return false;
    const session=this.#sessions.get(id);
    if(!session||session.principal!==principal)return false;
    session.controller.abort();
    return this.#forget(session,'cancelled');
  }
  cancelAllChildren(){
    let cancelled=0;
    for(const session of [...this.#sessions.values()])
      if(session.principal==='child'||session.principal.startsWith('learner:'))
        cancelled+=Number(this.cancel(session.principal,session.id));
    return cancelled;
  }
  erasePrincipal(principal){
    this.cancel(principal);
    const had=this.#metrics.delete(principal);
    this.#starts.delete(principal);
    return Number(had);
  }
  eraseScope(scope){
    if(!['parent','child','all'].includes(scope))
      throw new Error('INVALID_AUDIO_ERASE_SCOPE');
    const principals=new Set([...this.#metrics.keys(),
      ...this.#starts.keys(),...this.#owners.keys()]);
    let erased=0;
    for(const principal of principals){
      const isChild=principal==='child'||principal.startsWith('learner:');
      if(scope==='all'||(scope==='parent'&&!isChild)
        ||(scope==='child'&&isChild))
        erased+=this.erasePrincipal(principal);
    }
    return erased;
  }
  status(principal,id){
    const session=this.#require(principal,id);
    return {id:session.id,phase:session.phase,nextSeq:session.seq,
      receivedBytes:session.bytes,elapsedMs:Math.max(0,this.now()-session.createdAt),
      maxDurationMs:MAX_AUDIO_MS};
  }
  metrics(principal){
    return structuredClone(this.#metrics.get(principal)??{
      opened:0,completed:0,cancelled:0,expired:0,rejected:0,
      totalBytes:0,totalChunks:0,lastCaptureMs:null,lastProviderMs:null
    });
  }
  activeCount(){this.sweep();return this.#sessions.size;}
}

export async function readAudioChunk(req,maxBytes=AUDIO_CHUNK_BYTES){
  const mime=validateMime(req.headers['content-type']);
  const claimed=Number(req.headers['content-length']);
  if(Number.isFinite(claimed)&&claimed>maxBytes)
    throw new Error('INVALID_AUDIO_CHUNK_BYTES');
  let bytes=0;const parts=[];
  for await(const chunk of req){
    bytes+=chunk.byteLength;
    if(bytes>maxBytes)throw new Error('INVALID_AUDIO_CHUNK_BYTES');
    parts.push(chunk);
  }
  if(bytes<1)throw new Error('INVALID_AUDIO_CHUNK_BYTES');
  return {mime,bytes:Buffer.concat(parts,bytes)};
}
