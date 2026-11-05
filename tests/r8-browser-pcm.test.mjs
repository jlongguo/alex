import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import '../public/realtime-pcm-session.js';
import {RealtimePcmSessions} from '../scripts/realtime-pcm-sessions.mjs';

const ResponseJson=data=>new Response(JSON.stringify(data),{
  headers:{'content-type':'application/json'}
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('R8 actual AudioWorklet converts 48k float mic samples to bounded 24k PCM16 output frames',async()=>{
 const code=await readFile(new URL('../public/pcm-capture-processor.js',import.meta.url),'utf8');
 let Worklet;
 const produced=[];
 class Base{
  constructor(){this.port={postMessage:(message)=>produced.push(message)};}
 }
 const sandbox={AudioWorkletProcessor:Base,sampleRate:48000,
  registerProcessor:(name,ctor)=>{
   assert.equal(name,'alex-pcm16-capture');Worklet=ctor;
  },Float32Array,Int16Array,Math
 };
 vm.runInNewContext(code,sandbox);
 const worklet=new Worklet();
 for(let i=0;i<38;i++){
  const samples=new Float32Array(128);samples.fill(0.25);
  assert.equal(worklet.process([[samples]]),true);
 }
 const frames=produced.filter(x=>x.type==='pcm');
 assert.equal(frames.length,1,'48kHz to 24kHz resampling produces a 100ms output frame');
 const pcm=new Int16Array(frames[0].buffer);
 assert.equal(pcm.length,2400);
 assert.ok(pcm.some(x=>x>0));
 assert.ok(pcm.every(x=>x<=32767&&x>=-32768));
 worklet.port.onmessage({data:{type:'flush'}});
 assert.equal(produced.at(-1).type,'flushed');
 assert.ok(produced.filter(x=>x.type==='pcm').length>=2);
 assert.ok(worklet.frame.every(x=>x===0),'worklet internal raw frame is cleared');
 worklet.port.onmessage({data:{type:'stop'}});
 assert.equal(worklet.process([[new Float32Array(128)]]),false);
});
test('R8 browser mic PCM frame reaches upstream while capturing, final frame flushes before commit and chat remains manual',async()=>{
 let now=1000,stopped=0,connected=0,muted=false;
 const calls=[],partials=[];
 const provider={open:async({onPartial})=>({
  count:0,
  async append(data){
   this.count++;
   onPartial({text:'Hello ',final:false});
   return {frames:this.count};
  },
  async commit(){return {text:'Hello Alex',source:'realtime-cloud-asr',
    metrics:{firstPartialMs:123}};},
  cancel(){},close(){}
 })};
 const manager=new RealtimePcmSessions({provider,now:()=>now});
 let node,done;
 const got=new Promise(resolve=>done=resolve);
 const bridge=new globalThis.AlexRealtimePcmBridge({
  mediaDevices:{getUserMedia:async()=>({
   getTracks:()=>[{stop(){stopped++;}}]
  })},
  contextFactory:()=>({
   sampleRate:48000,
   audioWorklet:{addModule:async path=>assert.equal(path,'/pcm-capture-processor.js')},
   createMediaStreamSource:()=>({
    connect(){connected++;},disconnect(){}
   }),
   createGain:()=>({gain:{
    set value(n){muted=n===0;},get value(){return muted?0:1;}
   },connect(){},disconnect(){}}),
   destination:{},async resume(){},async close(){}
  }),
  workletFactory:()=>{
   node={
    port:{
     onmessage:null,
     postMessage(message){
      if(message.type==='flush'){
       queueMicrotask(()=>{
        this.onmessage({data:{type:'pcm',
          buffer:new Uint8Array(4800).fill(1).buffer}});
        this.onmessage({data:{type:'flushed'}});
       });
      }
     }
    },connect(){},disconnect(){}
   };
   return node;
  },
  fetchFn:async(url,opts={})=>{
   calls.push({url,seq:opts.headers?.['X-Alex-Frame-Seq']});
   if(url.endsWith('/start'))
    return ResponseJson({session:await manager.start('learner:test',JSON.parse(opts.body))});
   if(url.endsWith('/frame')){
    const receipt=await manager.append('learner:test',
      opts.headers['X-Alex-Realtime-Id'],{
       seq:Number(opts.headers['X-Alex-Frame-Seq']),data:opts.body
      });
    return ResponseJson(receipt);
   }
   if(url.includes('/status?id=')){
    return ResponseJson({session:manager.status('learner:test',
      new URL('http://localhost'+url).searchParams.get('id'))});
   }
   if(url.endsWith('/commit')){
    now+=550;
    return ResponseJson(await manager.commit('learner:test',
      JSON.parse(opts.body).id));
   }
   if(url.endsWith('/cancel')){
    return ResponseJson({cancelled:manager.cancel('learner:test',
      JSON.parse(opts.body).id)});
   }
   throw Error('Unexpected endpoint '+url);
  },
  onPartial:part=>partials.push(part),
  onTranscript:item=>done(item)
 });
 await bridge.start({language:'en'});
 assert.equal(bridge.snapshot().recording,true);
 assert.equal(connected,1);
 assert.equal(muted,true,'capture processor output is explicitly silenced');
 // Deliver a PCM frame while the microphone remains active.
 node.port.onmessage({data:{type:'pcm',
  buffer:new Uint8Array(4800).fill(5).buffer}});
 for(let i=0;i<30&&bridge.snapshot().frames<1;i++)await tick();
 assert.equal(bridge.snapshot().frames,1);
 assert.equal(calls.some(x=>x.url.endsWith('/commit')),false);
 const completed=await bridge.stop();
 assert.equal(completed,true);
 const result=await got;
 assert.equal(result.text,'Hello Alex');
 assert.equal(result.requiresManualSubmit,true);
 assert.equal(result.metrics.frames,2);
 assert.deepEqual(calls.filter(x=>x.url.endsWith('/frame')).map(x=>x.seq),
  ['0','1']);
 assert.equal(calls.filter(x=>x.url.endsWith('/commit')).length,1);
 assert.equal(stopped,1);
 assert.ok(!calls.some(x=>/companion\/stream|gateway|device/.test(x.url)));
 bridge.interrupt('test-done');
});
test('R8 stale microphone permissions release tracks and never start remote WSS session',async()=>{
 let resolveMic,stopped=0,called=0;
 const bridge=new globalThis.AlexRealtimePcmBridge({
  mediaDevices:{getUserMedia:()=>new Promise(resolve=>resolveMic=resolve)},
  fetchFn:async()=>{called++;throw Error('Must not send');}
 });
 const pending=bridge.start();
 await tick();
 bridge.interrupt('identity-switch');
 resolveMic({getTracks:()=>[{stop(){stopped++;}}]});
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(stopped,1);
 assert.equal(called,0);
});
