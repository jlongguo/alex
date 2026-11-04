import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {CompatibleAudioProvider,MAX_AUDIO_UPLOAD_BYTES,validateMime} from '../scripts/audio-provider.mjs';
import {AudioTurnGate,readAudioUpload} from '../scripts/audio-transport.mjs';

const fixture={
  baseUrl:'https://speech.example/v1',apiKey:'secret-test-key',
  transcriptionModel:'asr-model',speechModel:'tts-model',voice:'alloy'
};
const waves=new Uint8Array(320).fill(18);
test('R6 audio provider validates secure HTTPS endpoints and non-secret model parameters',()=>{
 for(const baseUrl of [
  'http://speech.example/v1','https://me:pass@speech.example/v1',
  'https://speech.example/v1?key=123','https://speech.example/v1#fragment',
  'https://127.0.0.1/v1','not a url'
 ]){
  assert.throws(()=>new CompatibleAudioProvider({...fixture,baseUrl}),
    /INVALID_AUDIO_PROVIDER_URL/);
 }
 assert.throws(()=>new CompatibleAudioProvider({...fixture,voice:'uploaded-child-voice'}),
   /INVALID_AUDIO_PROVIDER_CONFIG/);
 assert.equal(validateMime('audio/webm;codecs=opus'),'audio/webm');
 assert.throws(()=>validateMime('application/octet-stream'),/INVALID_AUDIO_MIME/);
});

test('R6 multipart transcription sends bounded audio only, never browser secrets',async()=>{
 const calls=[];
 const adapter=new CompatibleAudioProvider({...fixture,fetchFn:async(url,options)=>{
  calls.push({url:String(url),options});
  return new Response(JSON.stringify({text:'  Hello from ASR  '}),{
   status:200,headers:{'content-type':'application/json'}
  });
 }});
 const result=await adapter.transcribe({audio:waves,mime:'audio/webm',language:'en'});
 assert.deepEqual(result,{text:'Hello from ASR',source:'cloud-asr',validated:false});
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://speech.example/v1/audio/transcriptions');
 assert.equal(calls[0].options.redirect,'error');
 assert.equal(calls[0].options.headers.Authorization,'Bearer secret-test-key');
 assert.equal(calls[0].options.body.get('model'),'asr-model');
 assert.equal(calls[0].options.body.get('language'),'en');
 assert.equal(calls[0].options.body.get('response_format'),'json');
 assert.equal(calls[0].options.body.get('file').size,320);
 await assert.rejects(()=>adapter.transcribe({
  audio:new Uint8Array(MAX_AUDIO_UPLOAD_BYTES+1),mime:'audio/webm'}),/INVALID_AUDIO_BYTES/);
 await assert.rejects(()=>adapter.transcribe({
  audio:new Uint8Array(10),mime:'audio/webm'}),/INVALID_AUDIO_BYTES/);
 await assert.rejects(()=>adapter.transcribe({audio:waves,mime:'text/html'}),/INVALID_AUDIO_MIME/);
 await assert.rejects(()=>adapter.transcribe({audio:waves,mime:'audio/webm',language:'xx'}),/INVALID_AUDIO_LANGUAGE/);
 assert.equal(calls.length,1,'invalid input cannot reach the upstream provider');
});
test('R6 speech provider sends bounded text, returns strict MP3, ignores remote errors',async()=>{
 const calls=[];
 const adapter=new CompatibleAudioProvider({...fixture,fetchFn:async(url,options)=>{
  calls.push({url:String(url),data:JSON.parse(options.body),options});
  return new Response(Buffer.alloc(1500,0x44),{
    status:200,headers:{'content-type':'application/octet-stream'}
  });
 }});
 const audio=await adapter.synthesize({text:'Hello Alex',language:'en'});
 assert.equal(audio.mime,'audio/mpeg');
 assert.equal(audio.audio.length,1500);
 assert.equal(calls[0].url,'https://speech.example/v1/audio/speech');
 assert.deepEqual(calls[0].data,{model:'tts-model',input:'Hello Alex',
   voice:'alloy',response_format:'mp3'});
 assert.ok(!JSON.stringify(calls[0].data).includes('secret-test-key'));
 await assert.rejects(()=>adapter.synthesize({text:'a'.repeat(501)}),/INVALID_AUDIO_TEXT/);
 await assert.rejects(()=>adapter.synthesize({text:'hi',language:'xx'}),/INVALID_AUDIO_LANGUAGE/);
});
test('R6 upstream data and errors are bounded and never expose provider body',async()=>{
 const bad=new CompatibleAudioProvider({...fixture,fetchFn:async()=>new Response('PRIVATE PROVIDER ERROR',{
  status:429
 })});
 await assert.rejects(()=>bad.transcribe({audio:waves,mime:'audio/webm'}),/AUDIO_PROVIDER_HTTP_429/);
 const evil=new CompatibleAudioProvider({...fixture,fetchFn:async()=>new Response('x'.repeat(9000),{
  headers:{'content-type':'application/json'}
 })});
 await assert.rejects(()=>evil.transcribe({audio:waves,mime:'audio/webm'}),/AUDIO_PROVIDER_RESPONSE_TOO_LARGE/);
 const invalid=new CompatibleAudioProvider({...fixture,fetchFn:async()=>new Response(JSON.stringify({
  text:'a'.repeat(501)
 }),{headers:{'content-type':'application/json'}})});
 await assert.rejects(()=>invalid.transcribe({audio:waves,mime:'audio/webm'}),/AUDIO_PROVIDER_INVALID_TRANSCRIPT/);
 const overflow=new CompatibleAudioProvider({...fixture,fetchFn:async()=>new Response(
  Buffer.alloc(2_000_001,0x33),{headers:{'content-type':'audio/mpeg'}}
 )});
 await assert.rejects(()=>overflow.synthesize({text:'hi'}),/AUDIO_PROVIDER_RESPONSE_TOO_LARGE/);
});
test('R6 audio gate isolates principals, prevents overlaps, rate limits and supports cancel',async()=>{
 let current=100000;
 const gate=new AudioTurnGate({now:()=>current});
 let finish;
 const started=new Promise(resolve=>finish=resolve);
 let release;
 const pending=gate.run('learner:A','asr',async signal=>{
  finish();return new Promise((resolve,reject)=>{
    release=resolve;
    signal.addEventListener('abort',()=>reject(new Error('AUDIO_REQUEST_CANCELLED')),{once:true});
  });
 });
 await started;
 await assert.rejects(()=>gate.run('learner:A','tts',async()=>{}),/AUDIO_ALREADY_ACTIVE/);
 assert.equal(await gate.run('learner:B','tts',async()=>42),42);
 assert.equal(gate.cancel('learner:A'),true);
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(gate.stats().active,0);
 assert.equal(gate.cancel('learner:A'),false);
 for(let i=0;i<5;i++)await gate.run('learner:B','asr',async()=>true);
 await assert.rejects(()=>gate.run('learner:B','tts',async()=>true),/AUDIO_RATE_LIMIT/);
 current+=60001;
 assert.equal(await gate.run('learner:B','tts',async()=>true),true);
});
test('R6 binary upload reader checks MIME, claimed duration and actual byte count',async()=>{
 const stream=Readable.from([Buffer.alloc(128,0x41),Buffer.alloc(128,0x42)]);
 stream.headers={'content-type':'audio/webm;codecs=opus',
  'content-length':'256','x-alex-audio-duration-ms':'900'};
 const clip=await readAudioUpload(stream);
 assert.equal(clip.audio.length,256);
 assert.equal(clip.durationClaimMs,900);
 assert.equal(clip.mime,'audio/webm');
 const invalid=Readable.from([Buffer.alloc(256)]);
 invalid.headers={'content-type':'audio/wav',
  'x-alex-audio-duration-ms':'18000','content-length':'256'};
 await assert.rejects(()=>readAudioUpload(invalid),/INVALID_AUDIO_DURATION/);
 const huge=Readable.from([Buffer.alloc(200),Buffer.alloc(400)]);
 huge.headers={'content-type':'audio/wav','x-alex-audio-duration-ms':'1000'};
 await assert.rejects(()=>readAudioUpload(huge,{maxBytes:500}),/INVALID_AUDIO_BYTES/);
});
