import test from 'node:test';
import assert from 'node:assert/strict';
import {
 StreamingPcmSpeechProvider,SPEECH_PCM_CHUNK_BYTES,
 SPEECH_MAX_PCM_BYTES
} from '../scripts/streaming-speech-provider.mjs';

const base={
 baseUrl:'https://speech-fixture.example/v1',apiKey:'secret-speech-key',
 model:'test-tts-model',voice:'alloy'
};
const mock=(chunks,{type='application/octet-stream',status=200}={})=>
 new Response(new ReadableStream({
  start(controller){
   for(const chunk of chunks)controller.enqueue(chunk);
   controller.close();
  }
 }),{status,headers:{'content-type':type}});
test('R9 PCM streaming sends exact server-only OpenAI-compatible TTS schema',async()=>{
 const seen=[];
 const provider=new StreamingPcmSpeechProvider({...base,
  fetchFn:async(url,options)=>{
   seen.push({url:String(url),options});
   return mock([new Uint8Array(1200).fill(20),
    new Uint8Array(7400).fill(32)],{type:'audio/pcm'});
  }
 });
 const stream=await provider.open({text:'Hello child'});
 const chunks=[];
 while(true){
  const part=await stream.read();
  if(part.done)break;
  chunks.push(part);
 }
 assert.deepEqual(chunks.map(x=>x.pcm.length),[4800,3800]);
 assert.deepEqual(chunks.map(x=>x.samples),[2400,1900]);
 assert.equal(stream.stats().deliveredBytes,8600);
 assert.equal(seen.length,1);
 assert.equal(seen[0].url,'https://speech-fixture.example/v1/audio/speech');
 assert.equal(seen[0].options.redirect,'error');
 assert.equal(seen[0].options.headers.Authorization,'Bearer secret-speech-key');
 assert.deepEqual(JSON.parse(seen[0].options.body),{
  model:'test-tts-model',voice:'alloy',input:'Hello child',
  response_format:'pcm',stream_format:'audio'
 });
 assert.ok(!JSON.stringify(JSON.parse(seen[0].options.body))
  .includes('secret-speech-key'));
 await stream.close();
});
test('R9 PCM provider applies strict URL, text and content-type checks',async()=>{
 for(const url of [
  'http://speech-fixture.example/v1','https://localhost/v1',
  'https://127.0.0.1/v1','https://speech-fixture.example/v1?secret=42',
  'https://name:pass@speech-fixture.example/v1'
 ])assert.throws(()=>new StreamingPcmSpeechProvider({...base,baseUrl:url}),
   /INVALID_SPEECH_PROVIDER_URL/);
 const calls=[];
 const provider=new StreamingPcmSpeechProvider({...base,
  fetchFn:async(url,opts)=>{
   calls.push(opts);
   return mock([new Uint8Array(300)],{type:'text/html'});
  }
 });
 await assert.rejects(()=>provider.open({text:'Hello'}),/SPEECH_PROVIDER_INVALID_RESPONSE/);
 await assert.rejects(()=>provider.open({text:'x'.repeat(501)}),/INVALID_AUDIO_TEXT/);
 assert.equal(calls.length,1);
});
test('R9 odd truncated PCM, total bound and upstream errors reject without exposing vendor body',async()=>{
 const invalid=new StreamingPcmSpeechProvider({...base,
  fetchFn:async()=>mock([new Uint8Array(301).fill(1)])});
 const reader=await invalid.open({text:'hello'});
 await assert.rejects(()=>reader.read(),/SPEECH_PROVIDER_INVALID_PCM/);
 const huge=new StreamingPcmSpeechProvider({...base,
  fetchFn:async()=>mock(Array.from({length:17},()=>new Uint8Array(122880)))});
 const large=await huge.open({text:'hello'});
 await assert.rejects(async()=>{
  for(let i=0;i<500;i++){
   const b=await large.read();
   if(b.done)break;
  }
 },/SPEECH_PROVIDER_PCM_TOO_LARGE/);
 const bad=new StreamingPcmSpeechProvider({...base,
  fetchFn:async()=>new Response('private vendor key in body',{status:429})});
 await assert.rejects(()=>bad.open({text:'hello'}),/SPEECH_PROVIDER_HTTP_429/);
 assert.equal(SPEECH_PCM_CHUNK_BYTES,4800);
 assert.equal(SPEECH_MAX_PCM_BYTES,1_920_000);
});
test('R9 cancellation while reading a slow vendor PCM stream releases reader',async()=>{
 let controller;
 const stream=new ReadableStream({
  start(c){controller=c;c.enqueue(new Uint8Array(4800));},
  cancel(){}
 });
 const p=new StreamingPcmSpeechProvider({...base,
  fetchFn:async()=>new Response(stream,{headers:{
   'content-type':'application/octet-stream'
  }})
 });
 const abort=new AbortController();
 const source=await p.open({text:'hello',signal:abort.signal});
 assert.equal((await source.read()).pcm.length,4800);
 const waiting=source.read();
 abort.abort();
 await assert.rejects(waiting,/AUDIO_REQUEST_CANCELLED/);
 await source.close();
 assert.equal(source.stats().closed,true);
});
