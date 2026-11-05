import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const A='11111111-1111-4111-8111-111111111111';
async function bridgeClass(){
  const source=await readFile(new URL('../public/streaming-speech-bridge.js',import.meta.url),'utf8');
  const context={Uint8Array,ArrayBuffer,AbortController,atob,encodeURIComponent,
    setTimeout,clearTimeout,Promise};
  vm.runInNewContext(source,context);
  return context.AlexStreamingSpeechBridge;
}
const ok=body=>({ok:true,json:async()=>body});
const b64=Buffer.alloc(4800).toString('base64');
function player(){
  const events=[];
  const p={events,state:{queuedFrames:0},
    snapshot(){return this.state;},
    async begin(x){events.push(['begin',x]);},
    append(x){events.push(['frame',x.seq,x.owner,x.turn,x.pcm.length]);},
    finish(x){events.push(['finish',x]);},
    interrupt(reason){events.push(['interrupt',reason]);}
  };
  return p;
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,15));
test('R9 browser bridge starts under gesture and plays ordered HTTP PCM frames',async()=>{
  const Bridge=await bridgeClass(),p=player();
  const requested=[];
  let reads=0;
  const fetchFn=async(path,options)=>{
    requested.push([path,options?.method]);
    if(path==='/api/audio/speech/start')return ok({session:{id:A}});
    if(path.startsWith('/api/audio/speech/read')){
      if(reads++===0)return ok({seq:0,pcm:b64,sampleRate:24000});
      return ok({done:true,frames:1,pcmBytes:4800});
    }
    return ok({cancelled:true});
  };
  const bridge=new Bridge({fetchFn,player:p});
  await bridge.start({principal:'learner:one',text:'Hello'});
  await flush();
  assert.deepEqual(p.events.filter(x=>x[0]==='frame').map(x=>x[1]),[0]);
  assert.equal(p.events.filter(x=>x[0]==='finish').length,1);
  assert.equal(p.events.filter(x=>x[0]==='begin').length,1);
  assert.equal(bridge.snapshot().phase,'draining');
  assert.ok(requested.some(x=>x[0]==='/api/audio/speech/start'));
});
test('R9 interrupted speech discards delayed server frame',async()=>{
  const Bridge=await bridgeClass(),p=player();
  let resolveRead;
  const requests=[];
  const fetchFn=async(path)=>{
    requests.push(path);
    if(path==='/api/audio/speech/start')return ok({session:{id:A}});
    if(path.startsWith('/api/audio/speech/read'))
      return new Promise(resolve=>resolveRead=resolve);
    return ok({});
  };
  const bridge=new Bridge({fetchFn,player:p});
  await bridge.start({principal:'child',text:'Hi'});
  await flush();
  bridge.interrupt('barge-in');
  resolveRead(ok({seq:0,pcm:b64,sampleRate:24000}));
  await flush();
  assert.equal(p.events.filter(x=>x[0]==='frame').length,0);
  assert.equal(bridge.snapshot().phase,'idle');
  assert.ok(requests.includes('/api/audio/speech/cancel'));
});
test('R9 identity change stops and cancels prior learner output',async()=>{
  const Bridge=await bridgeClass(),p=player();
  const requests=[];
  const bridge=new Bridge({player:p,fetchFn:async(path)=>{
    requests.push(path);
    if(path==='/api/audio/speech/start')return ok({session:{id:A}});
    if(path.startsWith('/api/audio/speech/read'))return new Promise(()=>{});
    return ok({});
  }});
  await bridge.start({principal:'learner:one',text:'hello'});
  bridge.identityChanged('learner:two');
  assert.equal(bridge.snapshot().phase,'idle');
  assert.ok(requests.includes('/api/audio/speech/cancel'));
});
