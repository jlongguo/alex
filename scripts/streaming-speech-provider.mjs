// R9 bounded HTTP binary PCM16 speech stream adapter; not yet wired into HTTP.
export class StreamingSpeechProvider {
  constructor({url,apiKey,model,voice='alloy',fetchFn=fetch,timeoutMs=20000}={}) {
    let target;try{target=new URL(url);}catch{throw Error('INVALID_SPEECH_URL');}
    if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash
      ||typeof apiKey!=='string'||!apiKey||typeof model!=='string'
      ||!/^[-\w.]{1,100}$/.test(model)||!/^[-\w]{1,50}$/.test(voice))
      throw Error('INVALID_SPEECH_CONFIG');
    Object.assign(this,{url:target,apiKey,model,voice,fetchFn,timeoutMs});
  }
  async stream(text,{signal,onFrame,authorized=()=>{}}={}) {
    if(typeof text!=='string'||!text.trim()||text.length>1200
      ||typeof onFrame!=='function'||typeof authorized!=='function')
      throw Error('INVALID_SPEECH_INPUT');
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(abort,Math.min(30000,Math.max(1000,this.timeoutMs)));
    timeout.unref?.();
    let reader,bytes=0,frames=0,carry=new Uint8Array(0),done=false;
    try {
      authorized();
      if(signal?.aborted)throw Error('SPEECH_CANCELLED');
      const response=await this.fetchFn(this.url,{
        method:'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:'Bearer '+this.apiKey,'Content-Type':'application/json',
          Accept:'application/octet-stream'},
        body:JSON.stringify({model:this.model,voice:this.voice,input:text,
          response_format:'pcm',sample_rate:24000})
      });
      if(!response?.ok||!/^application\/octet-stream(?:\s*;|$)/i.test(
        response.headers?.get?.('content-type')??''))
        throw Error('SPEECH_PROVIDER_UNAVAILABLE');
      if(!response.body?.getReader)throw Error('SPEECH_STREAM_UNAVAILABLE');
      reader=response.body.getReader();
      while(true){
        if(controller.signal.aborted)throw Error('SPEECH_CANCELLED');
        authorized();
        const packet=await reader.read();
        if(packet.done){done=true;break;}
        const data=packet.value;
        if(!(data instanceof Uint8Array)||!data.length)throw Error('SPEECH_INVALID_PCM');
        bytes+=data.length;
        if(bytes>2880000)throw Error('SPEECH_BYTES_EXCEEDED');
        const merged=new Uint8Array(carry.length+data.length);
        merged.set(carry);merged.set(data,carry.length);
        let offset=0;
        while(merged.length-offset>=4800){
          if(controller.signal.aborted)throw Error('SPEECH_CANCELLED');
          authorized();
          const frame=merged.slice(offset,offset+4800);
          try{await onFrame({seq:frames,pcm:frame,sampleRate:24000});}
          finally{frame.fill(0);}
          frames++;offset+=4800;
        }
        carry=merged.slice(offset);merged.fill(0);
      }
      if(carry.length%2)throw Error('SPEECH_INVALID_PCM');
      if(carry.length){
        authorized();
        const frame=carry.slice();
        try{await onFrame({seq:frames,pcm:frame,sampleRate:24000});}
        finally{frame.fill(0);}
        frames++;
      }
      if(!frames)throw Error('SPEECH_EMPTY_OUTPUT');
      return {frames,pcmBytes:bytes,sampleRate:24000,complete:true};
    }catch(error){
      if(controller.signal.aborted||signal?.aborted)throw Error('SPEECH_CANCELLED');
      throw error;
    }finally{
      carry.fill(0);
      if(!done)try{await reader?.cancel?.();}catch{}
      clearTimeout(timeout);
      signal?.removeEventListener('abort',abort);
      controller.abort();
    }
  }
}
