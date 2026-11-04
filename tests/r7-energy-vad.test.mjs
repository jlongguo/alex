import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/audio-vad.js';

const Detector=globalThis.AlexEnergyTurnDetector;
const Monitor=globalThis.AlexEnergyAudioMonitor;
test('R7 energy detector requires sustained speech, then stops on measured quiet period',()=>{
 const v=new Detector();
 let result;
 for(let t=80;t<=400;t+=80)result=v.feed(0.2,t);
 assert.equal(result.state,'speaking');
 assert.equal(result.voiceDetected,true);
 for(let t=480;t<=1440;t+=80)result=v.feed(0.001,t);
 assert.equal(result.state,'complete');
 assert.equal(result.reason,'end-of-speech');
 assert.equal(v.feed(0.4,1520).state,'complete',
   'terminal decision cannot be resurrected by late audio');
});
test('R7 energy detector rejects short clicks and times out without detectable voice',()=>{
 const v=new Detector();
 for(let t=80;t<4800;t+=80){
  const rms=t===240||t===800?0.3:0.002;
  v.feed(rms,t);
 }
 const end=v.feed(0.002,4800);
 assert.equal(end.state,'timeout');
 assert.equal(end.reason,'no-speech');
 assert.equal(end.voiceDetected,false);
});
test('R7 energy VAD adapts to noise before voice and enforces monotonic bounded frames',()=>{
 const d=new Detector({threshold:0.04,noiseRatio:3});
 d.feed(0.01,80);d.feed(0.02,160);
 assert.ok(d.snapshot().noiseFloor>0.004);
 assert.throws(()=>d.feed(0.2,100),/INVALID_AUDIO_VAD_TIME_ORDER/);
 assert.throws(()=>d.feed(-0.2,240),/INVALID_AUDIO_VAD_FRAME/);
 assert.throws(()=>d.feed(Infinity,240),/INVALID_AUDIO_VAD_FRAME/);
 assert.throws(()=>new Detector({frameMs:-10}),/INVALID_AUDIO_VAD_CONFIG/);
});
test('R7 client-side monitor reads only RMS and reliably disconnects microphone analyser',async()=>{
 let clock=0,callback,closed=0,disconnected=0;
 let rms=0.15,levels=0;
 const context={
  createMediaStreamSource:()=>({connect(){},disconnect(){disconnected++;}}),
  createAnalyser:()=>({fftSize:1024,smoothingTimeConstant:0,
    getFloatTimeDomainData(buffer){buffer.fill(rms);}}),
  async close(){closed++;}
 };
 let finish;
 const gotEnd=new Promise(resolve=>finish=resolve);
 const m=new Monitor({
  contextFactory:()=>context,
  clock:()=>clock,
  scheduler:fn=>{callback=fn;return 29;},
  clearScheduler:()=>{callback=null;},
  onLevel:()=>levels++,
  onEnd:finish
 });
 await m.start({getTracks:()=>[]});
 for(let i=0;i<5;i++){clock+=80;callback();}
 rms=0;
 for(let i=0;i<11;i++){
  if(!callback)break;
  clock+=80;callback();
 }
 const event=await gotEnd;
 assert.equal(event.reason,'end-of-speech');
 assert.ok(event.elapsedMs>=800);
 assert.ok(levels>10);
 assert.equal(disconnected,1);
 await Promise.resolve();
 assert.equal(closed,1);
 assert.equal(callback,null);
 m.stop(); // idempotent cleanup
 assert.equal(disconnected,1);
});
test('R7 VAD never records or reconstructs samples or speech content',async()=>{
 const fs=await import('node:fs/promises');
 const source=await fs.readFile(new URL('../public/audio-vad.js',import.meta.url),'utf8');
 assert.ok(source.includes('getFloatTimeDomainData'));
 assert.ok(source.includes('rms'));
 assert.doesNotMatch(source,/fetch\(|MediaRecorder|localStorage|indexedDB|SpeechRecognition/);
});
