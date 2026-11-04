import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/audio-session.js';

test('R6 browser recording requires explicit start/stop, uploads only bounded clip and never autosends chat',async()=>{
 const requests=[],stopped=[],recorders=[],status=[];
 let finished;
 const transcriptReady=new Promise(resolve=>finished=resolve);
 const bridge=new globalThis.AlexCloudAudioBridge({
  mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped.push('track');}}]})},
  supports:type=>type.startsWith('audio/webm'),
  recorderFactory:(stream,options)=>{
   const r={state:'inactive',mime:options.mimeType,
    start(){this.state='recording';},
    stop(){
      this.state='inactive';
      this.ondataavailable({data:new Blob([new Uint8Array(512).fill(1)],
        {type:'audio/webm'})});
      void this.onstop();
    }};
   recorders.push(r);return r;
  },
  fetchFn:async(url,options)=>{
   requests.push({url,options});
   return new Response(JSON.stringify({text:'I like cats',requiresManualSubmit:true}),
     {headers:{'content-type':'application/json'}});
  },
  onTranscript:result=>finished(result),
  onStatus:item=>status.push(item.state)
 });
 assert.equal(bridge.snapshot().recording,false);
 const recording=await bridge.startCapture({language:'en'});
 assert.equal(recording.recording,true);
 assert.equal(recorders.length,1);
 assert.equal(requests.length,0,'no automatic cloud uploads on microphone start');
 assert.equal(bridge.stopCapture(),true);
 const transcript=await transcriptReady;
 assert.deepEqual(transcript,{text:'I like cats',requiresManualSubmit:true});
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'/api/audio/transcribe');
 assert.equal(requests[0].options.headers['Content-Type'],'audio/webm');
 assert.ok(Number(requests[0].options.headers['X-Alex-Audio-Duration-Ms'])>=300);
 assert.equal(requests[0].options.headers['X-Alex-Language'],'en');
 assert.equal(requests[0].options.body.size,512);
 assert.equal(stopped.length,1);
 assert.ok(status.includes('recording'));
 assert.ok(status.includes('transcribing'));
 assert.ok(!requests.some(x=>/companion\/stream|device\/dispatch/.test(x.url)));
 bridge.interrupt('done');
});
test('R6 browser interruption revokes pending mic grant before recording begins',async()=>{
 let permissionResolve,stopped=0,called=0;
 const bridge=new globalThis.AlexCloudAudioBridge({
  mediaDevices:{getUserMedia:()=>new Promise(resolve=>permissionResolve=resolve)},
  supports:()=>true,recorderFactory:()=>{called++;return {start(){},stop(){}};}
 });
 const pending=bridge.startCapture({language:'en'});
 await Promise.resolve();
 bridge.interrupt('role-switched');
 permissionResolve({getTracks:()=>[{stop(){stopped++;}}]});
 await assert.rejects(pending,/AUDIO_REQUEST_CANCELLED/);
 assert.equal(stopped,1);
 assert.equal(called,0,'mic capture cannot start for stale identity');
});
test('R6 browser cloud TTS renders ephemeral audio, stops and revokes object URL',async()=>{
 const actions=[],urls=[];
 const bridge=new globalThis.AlexCloudAudioBridge({
  fetchFn:async(url,options)=>{
   actions.push({url,options});
   return new Response(new Uint8Array(1024).fill(0x45),{
     headers:{'content-type':'audio/mpeg'}
   });
  },
  urlApi:{
   createObjectURL(blob){urls.push({kind:'create',size:blob.size});return 'blob:test-audio';},
   revokeObjectURL(url){urls.push({kind:'revoke',url});}
  },
  audioFactory:url=>({
   async play(){actions.push({play:url});},
   pause(){actions.push({pause:url});}
  })
 });
 await bridge.speak('Hello there',{language:'en'});
 assert.equal(bridge.snapshot().state,'speaking');
 assert.equal(actions[0].url,'/api/audio/speak');
 assert.equal(JSON.parse(actions[0].options.body).text,'Hello there');
 assert.equal(actions[1].play,'blob:test-audio');
 assert.equal(urls[0].size,1024);
 bridge.interrupt('stop-button');
 assert.equal(bridge.snapshot().state,'idle');
 assert.deepEqual(urls.at(-1),{kind:'revoke',url:'blob:test-audio'});
 assert.ok(actions.some(x=>x.pause==='blob:test-audio'));
});
test('R6 browser ASR rejects unsupported language and unsupported media recorder',async()=>{
 const bridge=new globalThis.AlexCloudAudioBridge({
  mediaDevices:{getUserMedia:async()=>{throw new Error('should not request');}},
  supports:()=>false
 });
 await assert.rejects(()=>bridge.startCapture({language:'xx'}),/INVALID_AUDIO_LANGUAGE/);
 await assert.rejects(()=>bridge.startCapture({language:'zh'}),/BROWSER_RECORDER_UNSUPPORTED/);
});
