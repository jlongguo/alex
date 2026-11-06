// R18 child-process-only fake vendor. A PCM read remains unresolved until
// the integration test explicitly unlocks a file barrier. No external network.
import {access,writeFile} from 'node:fs/promises';
const realFetch=globalThis.fetch;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=async p=>access(p).then(()=>true,()=>false);
globalThis.fetch=async(input,options)=>{
 const url=String(input);
 if(!url.startsWith('https://speech-fixture.example/v1/audio/speech'))
  return realFetch(input,options);
 if(options?.headers?.Authorization!=='Bearer test-r9-private-server-key')
  throw Error('R18_INVALID_VENDOR_AUTH');
 const request=JSON.parse(options.body);
 if(typeof request.input!=='string'||request.input.length>500
   ||request.response_format!=='pcm'||request.stream_format!=='audio')
  throw Error('R18_INVALID_VENDOR_REQUEST');
 const signalFile=process.env.R18_VENDOR_READ_MARKER;
 const releaseFile=process.env.R18_VENDOR_RELEASE_FILE;
 if(!signalFile||!releaseFile)throw Error('R18_MISSING_BARRIER');
 let emitted=false;
 const stream=new ReadableStream({
  async pull(controller){
   if(emitted){controller.close();return;}
   emitted=true;
   await writeFile(signalFile,'pending','utf8');
   // Deliberately ignore AbortSignal to simulate a non-cooperative supplier.
   for(let attempts=0;attempts<300;attempts++){
    if(await exists(releaseFile)){
     controller.enqueue(new Uint8Array(4800).fill(0x5a));
     controller.close();return;
    }
    await sleep(10);
   }
   controller.error(Error('R18_VENDOR_BARRIER_TIMEOUT'));
  },cancel(){}
 });
 return new Response(stream,{status:200,
  headers:{'content-type':'application/octet-stream'}});
};
