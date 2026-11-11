import test from 'node:test';
import assert from 'node:assert/strict';
import {CompatibleAudioProvider,MAX_AUDIO_UPLOAD_BYTES} from '../scripts/audio-provider.mjs';
import {StreamingPcmSpeechProvider,SPEECH_PCM_CHUNK_BYTES} from '../scripts/streaming-speech-provider.mjs';

const baseUrl='https://voice.example.test/v1';
const secret='r55-test-key-never-log';
const audio=new Uint8Array(256).fill(7);
const makeAsr=(fetchFn)=>new CompatibleAudioProvider({
 baseUrl,apiKey:secret,transcriptionModel:'asr-test',speechModel:'tts-test',
 fetchFn,timeoutMs:2000
});
const makeTts=(fetchFn)=>new StreamingPcmSpeechProvider({
 baseUrl,apiKey:secret,model:'tts-test',fetchFn,timeoutMs:2000
});
const pcm=()=>new Uint8Array(SPEECH_PCM_CHUNK_BYTES).fill(12);
const chunks=values=>new ReadableStream({
 start(controller){
  for(const bytes of values)controller.enqueue(bytes);
  controller.close();
 }
});

test('R55 ASR 实际 multipart 契约：模型/语言/内容类型正确，识别只产生待确认文字',async()=>{
 let seen=0;
 const provider=makeAsr(async(url,request)=>{
  seen++;
  assert.equal(url.href,'https://voice.example.test/v1/audio/transcriptions');
  assert.equal(request.method,'POST');
  assert.equal(request.redirect,'error');
  assert.equal(request.headers.Authorization,'Bearer '+secret);
  assert.equal(request.body.get('model'),'asr-test');
  assert.equal(request.body.get('language'),'en');
  assert.equal(request.body.get('response_format'),'json');
  const file=request.body.get('file');
  assert.equal(file.type,'audio/webm');
  assert.equal(file.size,256);
  return new Response(JSON.stringify({text:'  Hello Alex  '}),{
   headers:{'Content-Type':'application/json'}
  });
 });
 const result=await provider.transcribe({audio,mime:'audio/webm',language:'en'});
 assert.deepEqual(result,{text:'Hello Alex',source:'cloud-asr',validated:false});
 assert.equal(seen,1);
});
test('R55 ASR 供应商 HTTP 错误与无效 JSON 不得视为成功，也不能泄漏认证密钥',async()=>{
 const failed=makeAsr(async()=>new Response('blocked',{status:429}));
 await assert.rejects(failed.transcribe({audio,mime:'audio/webm'}),error=>{
  assert.equal(error.message,'AUDIO_PROVIDER_HTTP_429');
  assert.ok(!error.message.includes(secret));
  return true;
 });
 const invalid=makeAsr(async()=>new Response('not-json',{
  headers:{'Content-Type':'application/json'}
 }));
 await assert.rejects(invalid.transcribe({audio,mime:'audio/webm'}),
  /AUDIO_PROVIDER_INVALID_RESPONSE/);
});
test('R55 ASR 上游响应体超过 8 KiB 必须有界拒绝，绝不提交长转录',async()=>{
 const provider=makeAsr(async()=>new Response(JSON.stringify({
  text:'x'.repeat(9000)}),{headers:{'Content-Type':'application/json'}
 }));
 await assert.rejects(provider.transcribe({audio,mime:'audio/webm'}),
  /AUDIO_PROVIDER_RESPONSE_TOO_LARGE/);
});
test('R55 ASR 已撤销请求不允许调用供应商，音频大小亦不得绕过约束',async()=>{
 let invoked=false;
 const provider=makeAsr(async()=>{invoked=true;throw Error('UNREACHABLE');});
 const controller=new AbortController();controller.abort();
 await assert.rejects(provider.transcribe({audio,mime:'audio/webm',
  signal:controller.signal}),/AUDIO_REQUEST_CANCELLED/);
 await assert.rejects(provider.transcribe({
  audio:new Uint8Array(MAX_AUDIO_UPLOAD_BYTES+1),mime:'audio/webm'
 }),/INVALID_AUDIO_BYTES/);
 assert.equal(invoked,false);
});
test('R55 TTS 供应商必须使用 HTTPS、正确模型和 PCM 原始音频协议',async()=>{
 let invoked=0;
 const provider=makeTts(async(url,request)=>{
  invoked++;
  assert.equal(url.href,'https://voice.example.test/v1/audio/speech');
  assert.equal(request.redirect,'error');
  assert.equal(request.method,'POST');
  assert.equal(request.headers.Authorization,'Bearer '+secret);
  const body=JSON.parse(request.body);
  assert.equal(body.model,'tts-test');
  assert.equal(body.input,'Hello Alex!');
  assert.equal(body.response_format,'pcm');
  assert.equal(body.stream_format,'audio');
  return new Response(chunks([pcm(),pcm()]),{
   headers:{'Content-Type':'audio/pcm'}
  });
 });
 const stream=await provider.open({text:'Hello Alex!'});
 assert.equal(stream.format,'pcm16-mono-24khz');
 const first=await stream.read();
 const second=await stream.read();
 const end=await stream.read();
 assert.equal(first.pcm.byteLength,SPEECH_PCM_CHUNK_BYTES);
 assert.equal(first.samples,SPEECH_PCM_CHUNK_BYTES/2);
 assert.equal(second.deliveredBytes,2*SPEECH_PCM_CHUNK_BYTES);
 assert.equal(end.done,true);
 assert.equal(invoked,1);
 await stream.close();
 assert.equal(stream.stats().closed,true);
});
test('R55 TTS 上游拒绝、错误 Content-Type 必须安全退出',async()=>{
 const rejected=makeTts(async()=>new Response('down',{status:503}));
 await assert.rejects(rejected.open({text:'hello'}),/SPEECH_PROVIDER_HTTP_503/);
 const badType=makeTts(async()=>new Response('abc',{
  headers:{'Content-Type':'text/html'}
 }));
 await assert.rejects(badType.open({text:'hello'}),
  /SPEECH_PROVIDER_INVALID_RESPONSE/);
});
test('R55 TTS 等待上游 PCM 片段时即便 reader 未结束也可取消',async()=>{
 let readerClosed=false;
 const provider=makeTts(async()=>new Response(new ReadableStream({
  pull(){return new Promise(()=>{});},
  cancel(){readerClosed=true;}
 }),{headers:{'Content-Type':'audio/pcm'}}));
 const controller=new AbortController();
 const stream=await provider.open({text:'hello',signal:controller.signal});
 const pending=stream.read();
 controller.abort();
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(stream.stats().closed,true);
 assert.equal(readerClosed,true);
});
test('R55 TTS 恶意大块 PCM 与奇数末尾字节必须拒绝而不交付内容',async()=>{
 const oversized=makeTts(async()=>new Response(chunks([
  new Uint8Array(128*1024+2)
 ]),{headers:{'Content-Type':'audio/pcm'}}));
 const a=await oversized.open({text:'hello'});
 await assert.rejects(a.read(),/SPEECH_PROVIDER_PCM_TOO_LARGE/);
 assert.equal(a.stats().closed,true);
 const odd=makeTts(async()=>new Response(chunks([
  new Uint8Array(3)
 ]),{headers:{'Content-Type':'audio/pcm'}}));
 const b=await odd.open({text:'hello'});
 await assert.rejects(b.read(),/SPEECH_PROVIDER_INVALID_PCM/);
 assert.equal(b.stats().closed,true);
});
test('R55 音频供应商必须拒绝明文 HTTP、回环地址和 URL 凭据',()=>{
 for(const url of [
  'http://voice.example.test/v1','https://localhost/v1',
  'https://127.0.0.1/v1','https://user:pass@voice.example.test/v1'
 ]){
  // 直接实例化验证构造阶段阻断，避免把非法目标发给 fetch。
  assert.throws(()=>new CompatibleAudioProvider({
   baseUrl:url,apiKey:secret,transcriptionModel:'asr',
   speechModel:'tts'
  }),/INVALID_AUDIO_PROVIDER_URL/);
 }
});
