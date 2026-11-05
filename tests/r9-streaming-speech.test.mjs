import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {StreamingSpeechProvider} from '../scripts/streaming-speech-provider.mjs';
const fakeFetch=chunks=>async(_url,request)=>({
  ok:true,headers:{get:()=> 'application/octet-stream'},
  body:new ReadableStream({start(c){for(const v of chunks)c.enqueue(v);c.close();}})
});
const makeProvider=(chunks)=>new StreamingSpeechProvider({
  url:'https://voice.example/v1/speech',apiKey:'server-only-key',
  model:'voice-model',fetchFn:fakeFetch(chunks)
});
test('R9 PCM16 upstream stream recombines fragmented network chunks into frames',async()=>{
  const bytes=new Uint8Array(9602);bytes[0]=1;bytes[9601]=2;
  const parts=[bytes.slice(0,1),bytes.slice(1,400),bytes.slice(400,4801),bytes.slice(4801)];
  const frames=[];
  const p=makeProvider(parts);
  const result=await p.stream('Hello',{onFrame:f=>{
    frames.push({seq:f.seq,bytes:f.pcm.length,rate:f.sampleRate});
  }});
  assert.deepEqual(frames.map(f=>f.bytes),[4800,4800,2]);
  assert.deepEqual(frames.map(f=>f.seq),[0,1,2]);
  assert.equal(result.pcmBytes,9602);
  assert.equal(result.complete,true);
});
test('R9 rejects odd PCM, empty output, unsafe URL and oversize text',async()=>{
  await assert.rejects(()=>makeProvider([new Uint8Array(3)]).stream('Hi',
    {onFrame:()=>{}}),/SPEECH_INVALID_PCM/);
  await assert.rejects(()=>makeProvider([]).stream('Hi',
    {onFrame:()=>{}}),/SPEECH_EMPTY_OUTPUT/);
  assert.throws(()=>new StreamingSpeechProvider({url:'http://evil.example',
    apiKey:'secret',model:'foo'}),/INVALID_SPEECH_CONFIG/);
  await assert.rejects(()=>makeProvider([]).stream('x'.repeat(1201),
    {onFrame:()=>{}}),/INVALID_SPEECH_INPUT/);
});
test('R9 authorization is rechecked for every emitted frame',async()=>{
  let checks=0;
  await assert.rejects(()=>makeProvider([new Uint8Array(10000)]).stream('hello',{
    authorized(){if(++checks>=3)throw Error('PARENT_REVOKED');},
    onFrame(){}
  }),/PARENT_REVOKED/);
});
test('R9 abort blocks provider request before any audio leaves host',async()=>{
  const ctrl=new AbortController();ctrl.abort();
  await assert.rejects(()=>makeProvider([new Uint8Array(4800)]).stream('hi',
    {signal:ctrl.signal,onFrame(){throw Error('must not emit');}}),
    /SPEECH_CANCELLED/);
});
async function loadPlayer(){
  const source=await readFile(new URL('../public/streaming-speech-player.js',import.meta.url),'utf8');
  const sandbox={Uint8Array,DataView,Float32Array};
  vm.runInNewContext(source,sandbox);
  return sandbox.AlexStreamingSpeechPlayer;
}
function mockContext(){
  const sources=[];
  const context={currentTime:0,destination:{},resume:async()=>{},close:async()=>{},
    createBuffer(_channels,length){
      const data=new Float32Array(length);
      return {getChannelData:()=>data};
    },
    createBufferSource(){
      const s={connect(){},start(t){this.at=t;},stop(){this.stopped=true;}};
      sources.push(s);return s;
    }};
  return {context,sources};
}
test('R9 browser playback schedules ordered mono chunks and drains audibly',async()=>{
  const Player=await loadPlayer(),{context,sources}=mockContext();
  const p=new Player({contextFactory:()=>context});
  await p.begin({owner:'learner:a',turn:'turn1'});
  const pcm=new Uint8Array(4800);
  p.append({owner:'learner:a',turn:'turn1',seq:0,pcm});
  p.append({owner:'learner:a',turn:'turn1',seq:1,pcm});
  assert.equal(sources[0].at,0);
  assert.equal(sources[1].at,0.1);
  assert.equal(p.finish({owner:'learner:a',turn:'turn1'}).state,'draining');
  sources[0].onended();sources[1].onended();
  assert.equal(p.snapshot().state,'complete');
  assert.equal(p.snapshot().playedFrames,2);
});
test('R9 identity switch invalidates old callbacks, rejects stale frames',async()=>{
  const Player=await loadPlayer(),{context,sources}=mockContext();
  const p=new Player({contextFactory:()=>context});
  await p.begin({owner:'learner:a',turn:'turn1'});
  p.append({owner:'learner:a',turn:'turn1',seq:0,pcm:new Uint8Array(4800)});
  const oldEnd=sources[0].onended;
  p.identityChanged('learner:b');
  assert.equal(sources[0].stopped,true);
  oldEnd();
  assert.equal(p.snapshot().state,'idle');
  assert.equal(p.snapshot().playedFrames,0);
  assert.throws(()=>p.append({owner:'learner:a',turn:'turn1',seq:1,
    pcm:new Uint8Array(4800)}),/SPEECH_STALE_TURN/);
});
test('R9 rejects audio flood and wrong sequence',async()=>{
  const Player=await loadPlayer(),{context}=mockContext();
  const p=new Player({contextFactory:()=>context});
  await p.begin({owner:'child',turn:'x'});
  assert.throws(()=>p.append({owner:'child',turn:'x',seq:1,
    pcm:new Uint8Array(4800)}),/SPEECH_INVALID_SEQUENCE/);
  for(let i=0;i<16;i++)p.append({owner:'child',turn:'x',seq:i,
    pcm:new Uint8Array(4800)});
  assert.throws(()=>p.append({owner:'child',turn:'x',seq:16,
    pcm:new Uint8Array(4800)}),/SPEECH_PLAYBACK_BACKPRESSURE/);
});
