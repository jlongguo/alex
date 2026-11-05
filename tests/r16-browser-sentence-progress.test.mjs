import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/speech-playback-session.js';

const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){
 for(let i=0;i<80;i++){if(predicate())return;await pause();}
 throw Error('R16_BROWSER_TIMEOUT');
}
const session={id:'11111111-1111-4111-8111-111111111111',
 sampleRate:24000,format:'pcm16-mono-24khz',maxUnacknowledged:3};
const response=data=>new Response(JSON.stringify(data),{
 headers:{'Content-Type':'application/json'}});
function harness({badMetadata=false,badAck=false,legacy=false}={}){
 const sources=[],paths=[],acks=[];
 let n=0;
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  scheduler:()=>1,clearScheduler:()=>{},clock:()=>1000,
  contextFactory:()=>({currentTime:0,destination:{},
   async resume(){},async close(){},
   createBuffer:(_,samples)=>({getChannelData:()=>new Float32Array(samples)}),
   createBufferSource:()=>{
    const source={connect(){},disconnect(){},
     start(){sources.push(this);},stop(){this.stopped=true;}};
    return source;
   }
  }),
  fetchFn:async(path,options)=>{
   paths.push(path);
   if(path==='/api/audio/playback/start')return response({session});
   if(path==='/api/audio/playback/next'){
    if(n>=2)return new Response(null,{status:204});
    const index=n++;
    const headers={'x-alex-speech-seq':String(index),
     'x-alex-speech-samples':'2400'};
    if(!legacy){
     headers['x-alex-speech-sentence-index']=String(badMetadata?4:index);
     headers['x-alex-speech-sentence-count']='2';
    }
    return new Response(Buffer.alloc(4800),{headers});
   }
   if(path==='/api/audio/playback/ack'){
    const {seq}=JSON.parse(options.body);
    acks.push(seq);
    return response({acknowledgedSeq:seq,
     ...(legacy?{}:{sentenceIndex:badAck?5:seq})});
   }
   if(path==='/api/audio/playback/cancel')return response({cancelled:true});
   throw Error('UNEXPECTED_ROUTE '+path);
  }
 });
 return {bridge,sources,paths,acks};
}
test('R16 browser tracks current and client-claimed sentence without exposing text',async()=>{
 const h=harness();
 await h.bridge.play('The selected answer');
 await until(()=>h.sources.length===2);
 assert.equal(h.bridge.snapshot().sentenceIndex,1);
 assert.equal(h.bridge.snapshot().sentenceCount,2);
 assert.equal(h.bridge.snapshot().claimedSentenceIndex,0);
 h.sources[0].onended();
 await until(()=>h.acks.length===1);
 h.sources[1].onended();
 await until(()=>h.bridge.snapshot().phase==='complete');
 assert.deepEqual(h.acks,[0,1]);
 assert.equal(h.bridge.snapshot().claimedSentenceIndex,1);
 assert.equal(h.paths.filter(p=>p==='/api/audio/playback/start').length,1);
 assert.equal(h.paths.filter(p=>p==='/api/audio/playback/next').length,3);
});
test('R16 rejects forged sentence index before browser schedules audio',async()=>{
 const h=harness({badMetadata:true});
 await h.bridge.play('Hello');
 await until(()=>h.bridge.snapshot().phase==='error');
 assert.equal(h.sources.length,0);
 assert.equal(h.bridge.snapshot().sentenceCount,1);
});
test('R16 rejects inconsistent per-sentence playback ACK',async()=>{
 const h=harness({badAck:true});
 await h.bridge.play('Hello');
 await until(()=>h.sources.length===2);
 h.sources[0].onended();
 await until(()=>h.bridge.snapshot().phase==='error');
 assert.equal(h.bridge.snapshot().playedMsClaimed,0);
 assert.equal(h.bridge.snapshot().claimedSentenceIndex,0);
});
test('R16 accepts older single-sentence HTTP sources without new headers',async()=>{
 const h=harness({legacy:true});
 await h.bridge.play('Hello');
 await until(()=>h.sources.length===2);
 assert.equal(h.bridge.snapshot().sentenceCount,1);
 assert.equal(h.bridge.snapshot().sentenceIndex,0);
 h.bridge.interrupt('user');
 assert.equal(h.bridge.snapshot().phase,'idle');
});
