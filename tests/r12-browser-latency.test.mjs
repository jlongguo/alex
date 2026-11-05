import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/speech-playback-session.js';

const json=value=>new Response(JSON.stringify(value),{
 headers:{'content-type':'application/json'}
});
const wait=()=>new Promise(resolve=>setImmediate(resolve));
const token='11111111-1111-4111-8111-111111111111';
test('R12 client distinguishes request time from the moment audio is scheduled',async()=>{
 let clock=1000,source,reads=0;
 const events=[];
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  clock:()=>clock,
  scheduler:()=>1,clearScheduler:()=>{},
  contextFactory:()=>({
   currentTime:0,destination:{},async resume(){clock+=30;},
   async close(){},
   createBuffer:(_channels,count)=>({getChannelData:()=>new Float32Array(count)}),
   createBufferSource:()=>{
    source={connect(){},disconnect(){},start(){},stop(){}};
    return source;
   }
  }),
  onStatus:state=>events.push(state),
  fetchFn:async(path)=>{
   if(path==='/api/audio/playback/start'){
    clock+=75;
    return json({session:{id:token,format:'pcm16-mono-24khz',
      sampleRate:24000,maxUnacknowledged:3}});
   }
   if(path==='/api/audio/playback/next'){
    if(reads++>0)return new Response(null,{status:204});
    clock+=45;
    return new Response(new Uint8Array(4800),{
     headers:{'x-alex-speech-seq':'0','x-alex-speech-samples':'2400'}
    });
   }
   return json({cancelled:true});
  }
 });
 await bridge.play('spoken reply');
 for(let i=0;i<30&&!source;i++)await wait();
 assert.ok(source);
 const snapshot=bridge.snapshot();
 assert.equal(snapshot.firstScheduledLatencyMs,150);
 assert.equal(snapshot.firstAudioMs,1150);
 assert.equal(snapshot.playing,true);
 assert.equal(events.at(-1).firstScheduledLatencyMs,150);
 bridge.interrupt('manual');
 assert.equal(bridge.snapshot().firstScheduledLatencyMs,null);
});

test('R12 no first-audio latency reported before any valid PCM is scheduled',async()=>{
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  contextFactory:()=>({currentTime:0,destination:{},
   async resume(){},async close(){},
   createBuffer:()=>({getChannelData:()=>new Float32Array(1)}),
   createBufferSource:()=>{throw Error('unexpected');}
  }),
  scheduler:()=>1,clearScheduler:()=>{},
  fetchFn:async(path)=>{
   if(path.endsWith('/start'))
    return json({session:{id:token,format:'pcm16-mono-24khz',
     sampleRate:24000,maxUnacknowledged:3}});
   if(path.endsWith('/next'))return new Response(new Uint8Array(1),{
    headers:{'x-alex-speech-seq':'0','x-alex-speech-samples':'1'}
   });
   return json({cancelled:true});
  }
 });
 await bridge.play('hello');
 for(let i=0;i<30&&bridge.snapshot().phase!=='error';i++)await wait();
 assert.equal(bridge.snapshot().phase,'error');
 assert.equal(bridge.snapshot().firstScheduledLatencyMs,null);
});
