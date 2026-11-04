import {MAX_AUDIO_UPLOAD_BYTES,MAX_AUDIO_MS,validateMime} from './audio-provider.mjs';

const MAX_CALLS_PER_MINUTE=6;
export class AudioTurnGate {
  #active=new Map();
  #history=new Map();
  constructor({now=()=>Date.now()}={}){this.now=now;}
  async run(principal,kind,task){
    if(typeof principal!=='string'||!['asr','tts'].includes(kind)
      ||typeof task!=='function')throw new Error('INVALID_AUDIO_TASK');
    if(this.#active.has(principal))throw new Error('AUDIO_ALREADY_ACTIVE');
    const now=this.now(),recent=(this.#history.get(principal)??[])
      .filter(t=>now-t<60_000);
    if(recent.length>=MAX_CALLS_PER_MINUTE)throw new Error('AUDIO_RATE_LIMIT');
    recent.push(now);this.#history.set(principal,recent);
    const controller=new AbortController();
    this.#active.set(principal,controller);
    try{return await task(controller.signal);}
    finally{if(this.#active.get(principal)===controller)this.#active.delete(principal);}
  }
  cancel(principal){
    const controller=this.#active.get(principal);
    if(!controller)return false;
    controller.abort();return true;
  }
  cancelChild(){
    for(const principal of this.#active.keys())
      if(principal==='child'||principal.startsWith('learner:'))
        this.cancel(principal);
  }
  stats(){return {active:this.#active.size};}
}
export async function readAudioUpload(req,{maxBytes=MAX_AUDIO_UPLOAD_BYTES}={}){
  const mime=validateMime(req.headers['content-type']);
  const claimedLength=Number(req.headers['content-length']??NaN);
  if(Number.isFinite(claimedLength)&&claimedLength>maxBytes)
    throw new Error('INVALID_AUDIO_BYTES');
  // Duration header is only a client claim; it is NOT acoustic VAD or
  // trustworthy audio duration evidence.
  const duration=Number(req.headers['x-alex-audio-duration-ms']);
  if(!Number.isSafeInteger(duration)||duration<300||duration>MAX_AUDIO_MS)
    throw new Error('INVALID_AUDIO_DURATION');
  const chunks=[];let count=0;
  for await(const part of req){
    count+=part.byteLength;
    if(count>maxBytes)throw new Error('INVALID_AUDIO_BYTES');
    chunks.push(part);
  }
  if(count<128)throw new Error('INVALID_AUDIO_BYTES');
  return {audio:Buffer.concat(chunks,count),mime,durationClaimMs:duration};
}
