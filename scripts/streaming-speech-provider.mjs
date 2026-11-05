// R9: pull-based HTTP PCM speech. A vendor HTTP response is consumed only
// when the authenticated local listener requests its next 24kHz PCM16 block.
// Independent of R8 WSS transcription; not duplex AI.
export const SPEECH_PCM_RATE=24000;
export const SPEECH_PCM_CHUNK_BYTES=4800;
export const SPEECH_MAX_PCM_BYTES=1_920_000;
export const SPEECH_MAX_TEXT_CHARS=500;
const VOICES=new Set(['alloy','echo','shimmer','sage','coral','ash','marin','cedar']);
const safeUrl=raw=>{
 let target;
 try{target=new URL(raw);}catch{throw Error('INVALID_SPEECH_PROVIDER_URL');}
 const hostname=target.hostname.toLowerCase();
 if(target.protocol!=='https:'||target.username||target.password
   ||target.search||target.hash||target.port||hostname==='localhost'
   ||hostname==='127.0.0.1'||hostname==='[::1]'
   ||hostname.endsWith('.local')||hostname.endsWith('.localhost'))
   throw Error('INVALID_SPEECH_PROVIDER_URL');
 return new URL(target.toString().replace(/\/$/,'')+'/audio/speech');
};
export class StreamingPcmSpeechProvider {
 kind='compatible-pcm-stream';
 constructor({baseUrl,apiKey,model,voice='alloy',
   fetchFn=fetch,timeoutMs=30000}={}){
  this.endpoint=safeUrl(baseUrl);
  if(typeof apiKey!=='string'||!apiKey||apiKey.length>4096
    ||typeof model!=='string'||!/^[-\w.]{1,120}$/.test(model)
    ||!VOICES.has(voice)||typeof fetchFn!=='function'
    ||!Number.isInteger(timeoutMs)||timeoutMs<2000||timeoutMs>60000)
    throw Error('INVALID_SPEECH_PROVIDER_CONFIG');
  this.key=apiKey;this.model=model;this.voice=voice;
  this.fetchFn=fetchFn;this.timeoutMs=timeoutMs;
 }
 async open({text,signal}={}){
  if(typeof text!=='string'||!text.trim()||text.length>SPEECH_MAX_TEXT_CHARS)
   throw Error('INVALID_AUDIO_TEXT');
  if(signal?.aborted)throw Error('AUDIO_REQUEST_CANCELLED');
  const controller=new AbortController();
  const timeout=AbortSignal.timeout(this.timeoutMs);
  const linked=signal?AbortSignal.any([controller.signal,timeout,signal]):
    AbortSignal.any([controller.signal,timeout]);
  let response;
  try{
   response=await this.fetchFn(this.endpoint,{
    method:'POST',redirect:'error',signal:linked,
    headers:{Authorization:'Bearer '+this.key,
      'Content-Type':'application/json'},
    body:JSON.stringify({model:this.model,voice:this.voice,
      input:text.trim(),response_format:'pcm',stream_format:'audio'})
   });
  }catch{
   controller.abort();
   if(signal?.aborted)throw Error('AUDIO_REQUEST_CANCELLED');
   throw Error('SPEECH_PROVIDER_UNAVAILABLE');
  }
  if(!response?.ok){
   controller.abort();
   throw Error('SPEECH_PROVIDER_HTTP_'+(
     Number.isInteger(response?.status)?response.status:'UNAVAILABLE'));
  }
  const type=(response.headers?.get?.('content-type')??'').toLowerCase();
  if(!/^(?:audio\/pcm|application\/octet-stream)(?:\s*;|$)/.test(type)
    ||!response.body?.getReader){
   controller.abort();
   throw Error('SPEECH_PROVIDER_INVALID_RESPONSE');
  }
  const reader=response.body.getReader();
  let partial=Buffer.alloc(0),delivered=0,sourceBytes=0,
    complete=false,closed=false;
  const close=async()=>{
   if(closed)return;
   closed=true;controller.abort();
   partial.fill(0);partial=Buffer.alloc(0);
   try{await reader.cancel();}catch{}
  };
  const read=async()=>{
   if(closed)throw Error('AUDIO_REQUEST_CANCELLED');
   try{
    while(partial.length<SPEECH_PCM_CHUNK_BYTES&&!complete){
     if(linked.aborted)throw Error('AUDIO_REQUEST_CANCELLED');
     const {done,value}=await reader.read();
     if(done){complete=true;break;}
     if(!(value instanceof Uint8Array)||!value.byteLength)continue;
     if(value.byteLength>128*1024||
       sourceBytes+value.byteLength>SPEECH_MAX_PCM_BYTES)
       throw Error('SPEECH_PROVIDER_PCM_TOO_LARGE');
     sourceBytes+=value.byteLength;
     const updated=Buffer.concat([partial,Buffer.from(value)]);
     partial.fill(0);partial=updated;
    }
    if(complete&&!partial.length)return {done:true};
    const n=Math.min(SPEECH_PCM_CHUNK_BYTES,partial.length-
      (partial.length%2));
    if(n<2||(complete&&partial.length%2))
      throw Error('SPEECH_PROVIDER_INVALID_PCM');
    const chunk=Buffer.from(partial.subarray(0,n));
    const tail=Buffer.from(partial.subarray(n));
    partial.fill(0);partial=tail;
    delivered+=n;
    return {done:false,pcm:chunk,samples:n/2,deliveredBytes:delivered};
   }catch(error){
    await close();
    if(linked.aborted&&error.message!=='SPEECH_PROVIDER_PCM_TOO_LARGE'
      &&error.message!=='SPEECH_PROVIDER_INVALID_PCM')
      throw Error('AUDIO_REQUEST_CANCELLED');
    throw error;
   }
  };
  return {format:'pcm16-mono-24khz',read,close,
    stats:()=>({deliveredBytes:delivered,sourceBytes,complete,closed})};
 }
}
