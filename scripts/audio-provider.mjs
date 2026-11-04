// HTTPS audio adapter: never persists recordings, secrets or synthesized data.
const MIMES=Object.freeze({
  'audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'mp4',
  'audio/wav':'wav','audio/mpeg':'mp3'
});
export const MAX_AUDIO_UPLOAD_BYTES=1_500_000;
export const MAX_AUDIO_OUTPUT_BYTES=2_000_000;
export const MAX_AUDIO_MS=15_000;
export const AUDIO_MIMES=Object.freeze(Object.keys(MIMES));
const VOICES=new Set(['alloy','echo','shimmer','sage','coral','ash']);
const LANGS=new Set(['en','zh']);
const safeBase=value=>{
  let url;
  try{url=new URL(value);}catch{throw new Error('INVALID_AUDIO_PROVIDER_URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash
     ||['localhost','127.0.0.1','[::1]'].includes(url.hostname))
    throw new Error('INVALID_AUDIO_PROVIDER_URL');
  return url;
};
const validateMime=value=>{
  const normalized=String(value??'').split(';')[0].trim().toLowerCase();
  if(!Object.hasOwn(MIMES,normalized))throw new Error('INVALID_AUDIO_MIME');
  return normalized;
};
const limited=async(response,max,signal)=>{
  if(!response?.body||typeof response.body.getReader!=='function')
    throw new Error('AUDIO_PROVIDER_INVALID_RESPONSE');
  const reader=response.body.getReader();
  const chunks=[];let size=0;
  try{
    while(true){
      if(signal?.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>max)throw new Error('AUDIO_PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  }finally{if(size>max)await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks.map(x=>Buffer.from(x)),size);
};
const upstreamError=response=>'AUDIO_PROVIDER_HTTP_'+String(Number.isInteger(response?.status)?response.status:'UNAVAILABLE');
export class CompatibleAudioProvider {
  kind='compatible';
  constructor({baseUrl,apiKey,transcriptionModel,speechModel,voice='alloy',
    timeoutMs=20_000,fetchFn=fetch}={}){
    this.base=safeBase(baseUrl);
    if(typeof apiKey!=='string'||!apiKey||apiKey.length>4096
      ||typeof transcriptionModel!=='string'||!transcriptionModel||transcriptionModel.length>120
      ||typeof speechModel!=='string'||!speechModel||speechModel.length>120
      ||!VOICES.has(voice)||typeof fetchFn!=='function')
      throw new Error('INVALID_AUDIO_PROVIDER_CONFIG');
    this.key=apiKey;this.asr=transcriptionModel;this.tts=speechModel;
    this.voice=voice;this.fetchFn=fetchFn;
    this.timeout=Math.min(30_000,Math.max(2000,timeoutMs));
  }
  #url(path){return new URL(this.base.toString().replace(/\/$/,'')+'/'+path);}
  #signal(signal){
    return signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeout)]):
      AbortSignal.timeout(this.timeout);
  }
  async #fetch(path,options,signal){
    try{
      return await this.fetchFn(this.#url(path),{
        ...options,redirect:'error',signal:this.#signal(signal)
      });
    }catch{
      if(signal?.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
      throw new Error('AUDIO_PROVIDER_UNAVAILABLE');
    }
  }
  async transcribe({audio,mime,language,signal}={}){
    const type=validateMime(mime);
    if(!(audio instanceof Uint8Array)
      ||audio.byteLength<128||audio.byteLength>MAX_AUDIO_UPLOAD_BYTES)
      throw new Error('INVALID_AUDIO_BYTES');
    if(language!==undefined&&!LANGS.has(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    if(signal?.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
    const form=new FormData();
    form.append('file',new Blob([audio],{type}),'clip.'+MIMES[type]);
    form.append('model',this.asr);
    form.append('response_format','json');
    if(language)form.append('language',language);
    const response=await this.#fetch('audio/transcriptions',{
      method:'POST',headers:{Authorization:'Bearer '+this.key},body:form
    },signal);
    if(!response?.ok)throw new Error(upstreamError(response));
    const contentType=response.headers?.get?.('content-type')??'';
    if(!/^application\/json(?:\s*;|$)/i.test(contentType))
      throw new Error('AUDIO_PROVIDER_INVALID_RESPONSE');
    const bytes=await limited(response,8_192,signal);
    let parsed;
    try{parsed=JSON.parse(bytes.toString('utf8'));}catch{
      throw new Error('AUDIO_PROVIDER_INVALID_RESPONSE');
    }
    if(typeof parsed?.text!=='string'||!parsed.text.trim()||parsed.text.length>500)
      throw new Error('AUDIO_PROVIDER_INVALID_TRANSCRIPT');
    if(signal?.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
    return {text:parsed.text.trim(),source:'cloud-asr',validated:false};
  }
  async synthesize({text,language='zh',signal}={}){
    if(typeof text!=='string'||!text.trim()||text.length>500)
      throw new Error('INVALID_AUDIO_TEXT');
    if(!LANGS.has(language))throw new Error('INVALID_AUDIO_LANGUAGE');
    if(signal?.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
    const response=await this.#fetch('audio/speech',{
      method:'POST',
      headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:this.tts,input:text.trim(),voice:this.voice,response_format:'mp3'
      })
    },signal);
    if(!response?.ok)throw new Error(upstreamError(response));
    const type=response.headers?.get?.('content-type')??'';
    if(!/^(?:audio\/(?:mpeg|mp3)|application\/octet-stream)(?:\s*;|$)/i.test(type))
      throw new Error('AUDIO_PROVIDER_INVALID_RESPONSE');
    const audio=await limited(response,MAX_AUDIO_OUTPUT_BYTES,signal);
    if(audio.byteLength<128)throw new Error('AUDIO_PROVIDER_INVALID_AUDIO');
    if(signal?.aborted)throw new Error('AUDIO_REQUEST_CANCELLED');
    return {audio,mime:'audio/mpeg',source:'cloud-tts'};
  }
}
export {validateMime};
