import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/speech-playback-session.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<60;i++){if(check())return;await flush();}throw Error('TIMEOUT');}
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const session={id:'11111111-1111-4111-8111-111111111111',
 format:'pcm16-mono-24khz',sampleRate:24000,maxUnacknowledged:3};
const voiceTurnId='22222222-2222-4222-8222-222222222222';
function harness(){
 const calls=[],sources=[],events=[];
 const bridge=new globalThis.AlexStreamingSpeechBridge({
  scheduler:()=>1,clearScheduler:()=>{},
  contextFactory:()=>({currentTime:0,destination:{},async resume(){},
   async close(){},createBuffer:(_c,n)=>({getChannelData:()=>new Float32Array(n)}),
   createBufferSource:()=>{const s={connect(){},disconnect(){},
     start(){sources.push(this);},stop(){this.stopped=true;}};return s;}
  }),
  fetchFn:async(url,opts)=>{
   calls.push(url);
   if(url==='/api/voice/turn/start'){
    const input=JSON.parse(opts.body);
    assert.equal(input.conversationId,'33333333-3333-4333-8333-333333333333');
    return json({turn:{id:voiceTurnId},speechSession:session,
     assistant:{text:'committed'},session:{id:input.conversationId}});
   }
   if(url==='/api/audio/playback/next'){
    if(calls.filter(x=>x.endsWith('/next')).length===1)
     return new Response(Buffer.alloc(4800),{headers:{
      'x-alex-speech-seq':'0','x-alex-speech-samples':'2400'}});
    return new Response(null,{status:204});
   }
   if(url==='/api/audio/playback/ack')
    return json({acknowledgedSeq:JSON.parse(opts.body).seq});
   if(url==='/api/audio/playback/cancel'||url==='/api/voice/turn/cancel')
    return json({cancelled:true});
   throw Error('unexpected '+url);
  }
 });
 return {bridge,calls,sources,events};
}
test('R11 reviewed browser voice turn reuses the preopened speech session once',async()=>{
 const h=harness();
 await h.bridge.playVoiceTurn({
  conversationId:'33333333-3333-4333-8333-333333333333',
  text:'my reviewed text',onCommitted:p=>h.events.push(p.assistant.text)
 });
 await until(()=>h.sources.length===1);
 assert.deepEqual(h.events,['committed']);
 assert.equal(h.calls.filter(x=>x==='/api/voice/turn/start').length,1);
 assert.equal(h.calls.filter(x=>x==='/api/audio/playback/start').length,0);
 assert.equal(h.bridge.snapshot().playing,true);
 h.bridge.interrupt('user-barge-in');
 await until(()=>h.calls.includes('/api/voice/turn/cancel'));
 assert.equal(h.sources[0].stopped,true);
});
test('R11 browser input is bounded before cloud requests',async()=>{
 const h=harness();
 await assert.rejects(()=>h.bridge.playVoiceTurn({
  conversationId:'invalid',text:'hello'}),/INVALID_VOICE_TURN_INPUT/);
 await assert.rejects(()=>h.bridge.playVoiceTurn({
  conversationId:'33333333-3333-4333-8333-333333333333',
  text:'x'.repeat(501)}),/INVALID_AUDIO_TEXT/);
 assert.equal(h.calls.length,0);
});
