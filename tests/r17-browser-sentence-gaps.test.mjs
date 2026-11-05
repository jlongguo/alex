import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/speech-playback-session.js';
const uid='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){
 for(let i=0;i<80;i++){if(fn())return;await tick();}
 throw Error('R17_BROWSER_SCHEDULING_TIMEOUT');
}
function response(data){return new Response(JSON.stringify(data),{
 headers:{'Content-Type':'application/json'}
});}
function frame(index){
 return new Response(Buffer.alloc(4800),{headers:{
  'x-alex-speech-seq':String(index),'x-alex-speech-samples':'2400',
  'x-alex-speech-sentence-index':String(index),
  'x-alex-speech-sentence-count':'2'
 }});
}
function make({delaySecond=false}={}){
 let audioClock=0,readCount=0,resolveSecond;
 const scheduled=[];
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  scheduler:()=>1,clearScheduler:()=>{},clock:()=>1000,
  contextFactory:()=>({
   get currentTime(){return audioClock;},
   destination:{},async resume(){},async close(){},
   createBuffer:(_n,samples)=>({getChannelData:()=>new Float32Array(samples)}),
   createBufferSource:()=>({
    connect(){},disconnect(){},stop(){},
    start(when){scheduled.push(when);}
   })
  }),
  fetchFn:async(url)=>{
   if(url==='/api/audio/playback/start')
    return response({session:{id:uid,format:'pcm16-mono-24khz',
     sampleRate:24000,maxUnacknowledged:3}});
   if(url==='/api/audio/playback/next'){
    if(readCount++===0)return frame(0);
    if(readCount===2)return delaySecond
      ?new Promise(resolve=>resolveSecond=resolve):frame(1);
    return new Response(null,{status:204});
   }
   if(url==='/api/audio/playback/cancel')return response({cancelled:true});
   if(url==='/api/audio/playback/ack')return response({acknowledgedSeq:0});
   throw Error('UNEXPECTED_R17_HTTP_ROUTE');
  }
 });
 return {bridge,scheduled,
  setAudioClock:x=>audioClock=x,
  get canRelease(){return typeof resolveSecond==='function';},
  releaseSecond:()=>resolveSecond(frame(1))};
}
test('R17 adjacent sentence buffers schedule zero additional gap when both ready',async()=>{
 const h=make();
 await h.bridge.play('hello');
 await until(()=>h.scheduled.length===2);
 assert.equal(h.bridge.snapshot().sentenceScheduledGaps,1);
 assert.equal(h.bridge.snapshot().sentenceScheduledGapP50Ms,0);
 assert.equal(h.bridge.snapshot().sentenceScheduledGapP95Ms,0);
 h.bridge.interrupt('test-reset');
 assert.equal(h.bridge.snapshot().sentenceScheduledGaps,0);
 assert.equal(h.bridge.snapshot().sentenceScheduledGapP95Ms,null);
});
test('R17 delayed sentence delivery measures scheduling gap, not audible proof',async()=>{
 const h=make({delaySecond:true});
 await h.bridge.play('hello');
 await until(()=>h.scheduled.length===1&&h.canRelease);
 h.setAudioClock(0.52);
 h.releaseSecond();
 await until(()=>h.scheduled.length===2);
 assert.equal(h.bridge.snapshot().sentenceScheduledGaps,1);
 assert.equal(h.bridge.snapshot().sentenceScheduledGapP50Ms,420);
 assert.equal(h.bridge.snapshot().sentenceScheduledGapP95Ms,420);
 assert.equal(h.bridge.snapshot().claimedSentenceIndex,0);
 h.bridge.interrupt('test-stop');
});
