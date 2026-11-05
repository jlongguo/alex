import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/speech-playback-session.js';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,max=60){
 for(let i=0;i<max;i++){if(predicate())return;await flush();}
 throw Error('TEST_CONDITION_TIMEOUT');
}
const json=data=>new Response(JSON.stringify(data),{
 headers:{'content-type':'application/json'}
});
function harness({chunks=4}={}){
 const sources=[],calls=[],status=[];
 let queuedClock=0,stopCount=0;
 const provider={open:async()=>({
  step:0,async read(){
   if(this.step++>=chunks)return {done:true};
   const bytes=Buffer.alloc(4800,0x40);
   return {done:false,pcm:bytes,samples:2400};
  },
  async close(){}
 })};
 const manager=new StreamingSpeechSessions({provider});
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  contextFactory:()=>({
   get currentTime(){return queuedClock;},
   destination:{},
   async resume(){},
   async close(){stopCount++;},
   createBuffer:(channels,samples,rate)=>{
    assert.equal(channels,1);assert.equal(rate,24000);
    const floats=new Float32Array(samples);
    return {getChannelData:()=>floats};
   },
   createBufferSource:()=>{
    const src={buffer:null,onended:null,
     connect(){},disconnect(){},
     start(at){this.startedAt=at;sources.push(this);},
     stop(){this.stopped=true;}
    };
    return src;
   }
  }),
  clock:()=>1000,
  scheduler:()=>111,clearScheduler:()=>{},
  onStatus:s=>status.push(s),
  fetchFn:async(url,opts)=>{
   calls.push({url,opts});
   if(url==='/api/audio/playback/start'){
    return json({session:await manager.start('learner:A',JSON.parse(opts.body))});
   }
   if(url==='/api/audio/playback/next'){
    const input=JSON.parse(opts.body);
    const block=await manager.next('learner:A',input.id,input.seq);
    if(block.done)return new Response(null,{status:204});
    return new Response(block.pcm,{
     headers:{'Content-Type':'application/octet-stream',
      'X-Alex-Speech-Seq':String(block.seq),
      'X-Alex-Speech-Samples':String(block.samples)}
    });
   }
   if(url==='/api/audio/playback/ack'){
    const args=JSON.parse(opts.body);
    return json(manager.ack('learner:A',args.id,args.seq));
   }
   if(url==='/api/audio/playback/cancel'){
    return json(manager.cancel('learner:A',JSON.parse(opts.body).id));
   }
   throw Error('unexpected '+url);
  }
 });
 return {bridge,manager,sources,calls,status,
  closeCount:()=>stopCount,
  advance:seconds=>{queuedClock+=seconds;},
  completeSource:i=>sources[i].onended?.()
 };
}
test('R9 real browser-style Web Audio streams PCM during playback and ACKs only after onended',async()=>{
 const h=harness({chunks:4});
 const {bridge,sources,calls}=h;
 await bridge.play('The cat is sleeping');
 await until(()=>sources.length===2);
 assert.equal(bridge.snapshot().playing,true);
 assert.equal(bridge.snapshot().queued,2);
 assert.equal(calls.filter(x=>x.url.endsWith('/next')).length,2);
 assert.equal(calls.filter(x=>x.url.endsWith('/ack')).length,0,
  'receiving audio is not proof that a child heard it');
 assert.equal(sources[0].buffer.getChannelData(0)[0],0.501953125);
 assert.ok(sources[1].startedAt>sources[0].startedAt);
 h.advance(.11);h.completeSource(0);
 await until(()=>calls.filter(x=>x.url.endsWith('/ack')).length>=1);
 await until(()=>sources.length>=3);
 h.advance(.11);h.completeSource(1);
 await until(()=>sources.length>=4);
 h.advance(.11);h.completeSource(2);
 await until(()=>calls.filter(x=>x.url.endsWith('/ack')).length>=3);
 h.advance(.11);h.completeSource(3);
 await until(()=>bridge.snapshot().phase==='complete');
 assert.equal(bridge.snapshot().playedMsClaimed,400);
 assert.equal(h.manager.metrics('learner:A').completed,1);
 assert.equal(h.manager.metrics('learner:A').acknowledgedSamples,9600);
 assert.equal(h.manager.activeCount(),0);
 assert.ok(!calls.some(x=>x.url.includes('companion')||x.url.includes('gateway')));
});
test('R9 barge-in stops all scheduled audio immediately and sends per-session cancellation',async()=>{
 const h=harness({chunks:12});
 await h.bridge.play('A story for my child');
 await until(()=>h.sources.length===2);
 assert.equal(h.manager.activeCount(),1);
 h.completeSource(0);
 await until(()=>h.manager.metrics('learner:A').acknowledgedSamples===2400);
 const before=h.bridge.snapshot();
 assert.equal(before.playedMsClaimed,100);
 h.bridge.interrupt('microphone-user-barge-in');
 await until(()=>h.calls.some(x=>x.url.endsWith('/cancel')));
 assert.ok(h.sources.some(x=>x.stopped===true));
 assert.equal(h.bridge.snapshot().phase,'idle');
 assert.equal(h.manager.activeCount(),0);
 assert.equal(h.manager.metrics('learner:A').cancelled,1);
 assert.equal(h.manager.metrics('learner:A').lastClaimedPlaybackMs,100);
 h.completeSource(1);
 assert.equal(h.bridge.snapshot().phase,'idle');
});
test('R9 failed upstream or invalid PCM frame cannot schedule or store audio',async()=>{
 let closed=0;
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  contextFactory:()=>({
   currentTime:0,destination:{},
   async resume(){},async close(){closed++;},
   createBuffer:()=>({getChannelData:()=>new Float32Array(1)}),
   createBufferSource:()=>{throw Error('should never play invalid response');}
  }),
  scheduler:()=>1,clearScheduler:()=>{},
  fetchFn:async(url)=>{
   if(url.endsWith('/start'))
    return json({session:{id:'11111111-1111-4111-8111-111111111111',
      sampleRate:24000,format:'pcm16-mono-24khz',maxUnacknowledged:3}});
   if(url.endsWith('/next'))return new Response(new Uint8Array(11),{
    headers:{'x-alex-speech-seq':'0','x-alex-speech-samples':'6'}
   });
   return json({cancelled:true});
  }
 });
 await bridge.play('hello');
 await until(()=>bridge.snapshot().phase==='error');
 assert.equal(bridge.snapshot().playing,false);
 assert.ok(closed>=1);
});
test('R9 browser refuses text over 500 characters before requesting remote audio',async()=>{
 let calls=0;
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  fetchFn:async()=>{calls++;}
 });
 await assert.rejects(()=>bridge.play('x'.repeat(501)),/INVALID_AUDIO_TEXT/);
 assert.equal(calls,0);
});
