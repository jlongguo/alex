// Test-only outbound audio vendor interceptor. No network traffic leaves CI.
// It does not intercept localhost browser->Alex requests.
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const url=String(input);
  if(url.startsWith('https://speech-fixture.example/v1/audio/')){
    if(!String(options?.headers?.Authorization??'').startsWith('Bearer '))
      throw new Error('Missing provider credential');
    if(url.endsWith('/transcriptions')){
      if(options?.body?.get?.('model')!=='fixture-asr')
        throw new Error('Unexpected ASR model');
      if(!options?.body?.get?.('file'))throw new Error('Missing audio file');
      return new Response(JSON.stringify({text:'Hello, Alex.'}),{
        status:200,headers:{'content-type':'application/json'}
      });
    }
    if(url.endsWith('/speech')){
      const args=JSON.parse(options.body);
      if(args.model!=='fixture-tts'||args.voice!=='alloy')
        throw new Error('Unexpected TTS model');
      if(args.input==='SLOW_AUDIO_CANCEL_TEST')
        return new Promise((resolve,reject)=>{
          if(options.signal?.aborted)
            return reject(new Error('fixture upstream cancelled'));
          options.signal.addEventListener('abort',
            ()=>reject(new Error('fixture upstream cancelled')),{once:true});
        });
      return new Response(Buffer.alloc(1024,0x42),{
        status:200,headers:{'content-type':'audio/mpeg'}
      });
    }
  }
  return originalFetch(input,options);
};
