import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioIngressSessions} from '../scripts/audio-ingress-sessions.mjs';
import '../public/audio-vad.js';
import '../public/audio-stream-session.js';

const Stream=globalThis.AlexStreamingAudioBridge;
const HEADER={'content-type':'application/json'};
const response=data=>new Response(JSON.stringify(data),{headers:HEADER});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,max=40){
 for(let i=0;i<max;i++){
  if(predicate())return;
  await tick();
 }
 throw new Error('TEST_CONDITION_TIMEOUT');
}
test('R7 browser sends ordered chunks *during* microphone capture and waits for manual chat submit',async()=>{
 let now=1000,stops=0,recorder,transfer=[],transcript;
 const backend=new AudioIngressSessions({now:()=>now});
 let delivered;
 const received=new Promise(resolve=>delivered=resolve);
 const browser=new Stream({
  mediaDevices:{getUserMedia:async()=>({
    getTracks:()=>[{stop(){stops++;}}]
  })},
  supports:type=>type.startsWith('audio/webm'),
  recorderFactory:()=>{
    recorder={state:'inactive',start(){this.state='recording';},
      stop(){
        this.state='inactive';
        this.ondataavailable({data:new Blob([new Uint8Array(300).fill(7)])});
        void this.onstop();
      }};
    return recorder;
  },
  fetchFn:async(url,opts)=>{
    transfer.push({url,seq:opts.headers?.['X-Alex-Chunk-Seq']});
    if(url==='/api/audio/turn/start'){
      const args=JSON.parse(opts.body);
      return response({ok:true,turn:backend.open('learner:A',args)});
    }
    if(url==='/api/audio/turn/chunk'){
      const data=new Uint8Array(await opts.body.arrayBuffer());
      return response({ok:true,...backend.append('learner:A',
        opts.headers['X-Alex-Turn-Id'],{
          seq:Number(opts.headers['X-Alex-Chunk-Seq']),
          mime:opts.headers['Content-Type'],data
        })});
    }
    if(url==='/api/audio/turn/finish'){
      now+=800;
      const result=await backend.finish('learner:A',JSON.parse(opts.body).id,{
        authorized:()=>true,transcribe:async()=>({
          text:'I like robots',source:'cloud-asr',validated:false})
      });
      return response({ok:true,...result});
    }
    if(url==='/api/audio/turn/cancel'){
      const cancelled=backend.cancel('learner:A',JSON.parse(opts.body).id);
      return response({ok:true,cancelled});
    }
    throw Error('Unexpected route '+url);
  },
  monitorFactory:()=>{throw Error('VAD is off in this test');},
  onTranscript:data=>{transcript=data;delivered(data);}
 });
 await browser.startCapture({language:'en',autoStopOnSilence:false});
 assert.equal(browser.snapshot().recording,true);
 assert.equal(transfer[0].url,'/api/audio/turn/start');
 assert.equal(transfer.filter(x=>x.url==='/api/audio/turn/finish').length,0);
 // Simulate an actual MediaRecorder timeslice before the user presses stop.
 recorder.ondataavailable({data:new Blob([new Uint8Array(400).fill(3)])});
 await until(()=>transfer.some(x=>x.url==='/api/audio/turn/chunk'));
 assert.equal(transfer.filter(x=>x.url==='/api/audio/turn/finish').length,0);
 assert.equal(browser.snapshot().sentChunks,1);
 browser.stopCapture();
 const result=await received;
 assert.equal(result.text,'I like robots');
 assert.equal(result.requiresManualSubmit,true);
 assert.equal(result.metrics.chunks,2);
 assert.equal(result.metrics.totalBytes,700);
 assert.equal(transcript.text,'I like robots');
 assert.equal(transfer.filter(x=>x.url==='/api/audio/turn/finish').length,1);
 assert.deepEqual(transfer.filter(x=>x.url==='/api/audio/turn/chunk').map(x=>x.seq),['0','1']);
 assert.equal(stops,1);
 assert.equal(backend.activeCount(),0);
 assert.ok(!transfer.some(x=>x.url.includes('companion/stream')||x.url.includes('gateway')));
 browser.interrupt('test-complete');
});
test('R7 browser splits oversized ondataavailable Blob without buffering all recording',async()=>{
 let now=1000,recorder,last;
 const backend=new AudioIngressSessions({now:()=>now});
 const complete=new Promise(resolve=>last=resolve);
 const bridge=new Stream({
  mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},
  supports:type=>type.startsWith('audio/webm'),
  recorderFactory:()=>{
    recorder={state:'inactive',start(){this.state='recording';},
      stop(){this.state='inactive';void this.onstop();}};
    return recorder;
  },
  fetchFn:async(url,opts)=>{
    if(url.endsWith('/start'))return response({turn:backend.open('parent',JSON.parse(opts.body))});
    if(url.endsWith('/chunk')){
      const data=new Uint8Array(await opts.body.arrayBuffer());
      assert.ok(data.byteLength<=64*1024);
      return response(backend.append('parent',opts.headers['X-Alex-Turn-Id'],{
        seq:Number(opts.headers['X-Alex-Chunk-Seq']),
        mime:opts.headers['Content-Type'],data
      }));
    }
    if(url.endsWith('/finish')){
      now+=600;
      return response(await backend.finish('parent',JSON.parse(opts.body).id,{
        authorized:()=>true,transcribe:async()=>({text:'done'})
      }));
    }
    if(url.endsWith('/cancel'))return response({ok:true});
    throw Error(url);
  },
  onTranscript:value=>last(value)
 });
 await bridge.startCapture({language:'zh'});
 recorder.ondataavailable({data:new Blob([new Uint8Array(140_000)])});
 await until(()=>bridge.snapshot().sentChunks===3);
 assert.equal(bridge.snapshot().sentBytes,140000);
 bridge.stopCapture();
 const result=await complete;
 assert.equal(result.metrics.chunks,3);
 assert.equal(result.metrics.totalBytes,140000);
 bridge.interrupt('test-complete');
});
test('R7 quiet endpoint calls cancel rather than sending no-speech audio to ASR',async()=>{
 let capture,recorder;
 const urls=[];
 const bridge=new Stream({
  mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},
  supports:type=>type.startsWith('audio/webm'),
  recorderFactory:()=>{
    recorder={state:'inactive',start(){this.state='recording';},stop(){this.state='inactive';}};
    return recorder;
  },
  monitorFactory:options=>{
    capture=options.onEnd;
    return {start:async()=>{},stop(){}};
  },
  fetchFn:async(url)=>{
    urls.push(url);
    if(url.endsWith('/start'))
      return response({turn:{id:'11111111-1111-4111-8111-111111111111',maxDurationMs:15000}});
    return response({ok:true,cancelled:true});
  }
 });
 await bridge.startCapture({autoStopOnSilence:true});
 capture({voiceDetected:false,reason:'no-speech'});
 await until(()=>urls.some(url=>url.endsWith('/cancel')));
 assert.equal(bridge.snapshot().state,'error');
 assert.equal(urls.filter(x=>x.endsWith('/finish')).length,0);
 assert.equal(urls.filter(x=>x.endsWith('/chunk')).length,0);
});
test('R7 stale getUserMedia resolution after role switch releases mic and avoids opening server session',async()=>{
 let accept,stopped=0,networkCalls=0;
 const bridge=new Stream({
  mediaDevices:{getUserMedia:()=>new Promise(resolve=>accept=resolve)},
  supports:()=>true,recorderFactory:()=>{throw Error('Must never record');},
  fetchFn:async()=>{networkCalls++;}
 });
 const pending=bridge.startCapture();
 await tick();
 bridge.interrupt('identity-change');
 accept({getTracks:()=>[{stop(){stopped++;}}]});
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(stopped,1);
 assert.equal(networkCalls,0);
});
test('R7 consent/browsers errors remain explicit without starting automatic voice or chat',async()=>{
 const bridge=new Stream({mediaDevices:{getUserMedia:async()=>{throw Error('denied');}},
  supports:()=>true,fetchFn:async()=>{throw Error('must not reach server');}});
 await assert.rejects(()=>bridge.startCapture({language:'xx'}),/INVALID_AUDIO_LANGUAGE/);
 await assert.rejects(()=>bridge.startCapture({language:'en'}),/MICROPHONE_PERMISSION_DENIED/);
 assert.equal(bridge.snapshot().state,'error');
});
