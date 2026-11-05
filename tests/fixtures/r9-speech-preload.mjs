// R9 test-only global fetch replacement inside forked localhost server.
// Never reaches external vendor; no runtime module imports this fixture.
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
 const url=String(input);
 if(!url.startsWith('https://speech-fixture.example/v1/audio/speech'))
  return nativeFetch(input,options);
 if(options?.headers?.Authorization!=='Bearer test-r9-private-server-key')
  throw Error('R9 fixture missing protected server-only key');
 const sent=JSON.parse(options.body);
 if(sent.response_format!=='pcm'||sent.stream_format!=='audio'
   ||sent.model!=='r9-test-model'||sent.voice!=='alloy'
   ||typeof sent.input!=='string'||sent.input.length>500)
  throw Error('R9 fixture unexpected TTS schema');
 const pcm=new Uint8Array(4800*6);
 for(let i=0;i<pcm.length;i+=2){
  pcm[i]=0x20;pcm[i+1]=0x04;
 }
 const sizes=[500,5000,6500,16000,pcm.length-22000];
 let offset=0;
 return new Response(new ReadableStream({
  pull(controller){
   if(options.signal.aborted){
    controller.error(Error('fixture upstream cancelled'));return;
   }
   if(offset>=pcm.length){controller.close();return;}
   const size=Math.min(sizes.shift()??4800,pcm.length-offset);
   controller.enqueue(pcm.slice(offset,offset+size));
   offset+=size;
  },
  cancel(){}
 }),{status:200,headers:{'content-type':'application/octet-stream'}});
};
