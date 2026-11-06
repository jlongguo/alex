import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/speech-playback-session.js';

const id='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){
 for(let i=0;i<80;i++){if(predicate())return;await tick();}
 throw Error('R18_BROWSER_WAIT_TIMEOUT');
}
const json=obj=>new Response(JSON.stringify(obj),{
 headers:{'content-type':'application/json'}
});
function harness(){
 let releaseFrame,reads=0;
 const sources=[],calls=[];
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  clock:()=>1000,scheduler:()=>1,clearScheduler:()=>{},
  contextFactory:()=>({currentTime:0,destination:{},async resume(){},
   async close(){},
   createBuffer:(_n,count)=>({getChannelData:()=>new Float32Array(count)}),
   createBufferSource:()=>({
    connect(){},disconnect(){},onended:null,
    start(){sources.push(this);},stop(){this.stopped=true;}
   })
  }),
  fetchFn:async(path,opts)=>{
   calls.push(path);
   if(path==='/api/audio/playback/start')
    return json({session:{id,format:'pcm16-mono-24khz',sampleRate:24000,
     maxUnacknowledged:3}});
   if(path==='/api/audio/playback/next'){
    reads++;
    if(reads===1)return new Promise(resolve=>releaseFrame=resolve);
    if(reads===2)return new Response(null,{status:204});
   }
   if(path==='/api/audio/playback/cancel')return json({cancelled:true});
   if(path==='/api/audio/playback/ack')return json({acknowledgedSeq:0});
   throw Error('R18_UNEXPECTED_ROUTE '+path);
  }
 });
 return {bridge,sources,calls,
  get pending(){return !!releaseFrame;},
  release:()=>releaseFrame(new Response(Buffer.alloc(4800),{
   headers:{'x-alex-speech-seq':'0','x-alex-speech-samples':'2400'}
  }))};
}
test('R18 stale PCM arriving after barge-in never reaches AudioContext',async()=>{
 const h=harness();
 await h.bridge.play('A committed answer.');
 await until(()=>h.pending);
 h.bridge.interrupt('parent-revoked-audio');
 assert.equal(h.bridge.snapshot().phase,'idle');
 h.release();
 await tick();await tick();
 assert.equal(h.sources.length,0);
 assert.equal(h.bridge.snapshot().playedMsClaimed,0);
 assert.equal(h.calls.filter(x=>x==='/api/audio/playback/ack').length,0);
 assert.ok(h.calls.includes('/api/audio/playback/cancel'));
});
test('R18 new session remains unaffected when the previous pending PCM resolves',async()=>{
 const h=harness();
 await h.bridge.play('First request.');
 await until(()=>h.pending);
 h.bridge.interrupt('switch-learner');
 h.release();
 await tick();
 assert.equal(h.sources.length,0);
 assert.equal(h.bridge.snapshot().phase,'idle');
 assert.equal(h.calls.filter(x=>x==='/api/audio/playback/ack').length,0);
});
