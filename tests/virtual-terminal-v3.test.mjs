import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import '../public/terminal-runtime.js';
import {VirtualPresentationRuntime} from '../scripts/virtual-presentation.mjs';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';

const cwd=resolve(import.meta.dirname,'..');
const fresh=()=> 'virtual_'+Math.random().toString(16).slice(2)+'_req';

test('terminal state machine checks transitions, interruption and stale callbacks',()=>{
 const Terminal=globalThis.AlexTerminalRuntime;
 let time=100;
 const terminal=new Terminal({clock:()=>time++});
 assert.equal(terminal.snapshot().state,'idle');
 const listening=terminal.transition('listening',{reason:'microphone-click'});
 assert.equal(listening.state,'listening');
 assert.equal(terminal.current(listening.revision),true);
 assert.throws(()=>terminal.transition('speaking'),/INVALID_TERMINAL_TRANSITION/);
 const thinking=terminal.transition('thinking');
 assert.equal(terminal.current(listening.revision),false);
 const speaking=terminal.transition('speaking');
 assert.equal(terminal.current(speaking.revision),true);
 assert.equal(terminal.current(thinking.revision),false);
 const stopped=terminal.interrupt('barge-in');
 assert.equal(stopped.state,'idle');
 assert.equal(terminal.current(speaking.revision),false);
 assert.equal(terminal.transition('listening').revision,stopped.revision+1);
 for(let i=0;i<45;i++){terminal.transition('idle');terminal.transition('thinking');}
 assert.equal(terminal.snapshot().recent.length,20);
 assert.throws(()=>terminal.transition('moving'),/INVALID_TERMINAL_STATE/);
 assert.throws(()=>terminal.transition('idle',{reason:'x'.repeat(61)}),/INVALID_TERMINAL_REASON/);
});

test('CLI virtual terminal renders only faces and captions, never physical audio',async()=>{
 const logged=[];
 const runtime=new VirtualPresentationRuntime({write:value=>logged.push(value),delay:async()=>{}});
 assert.deepEqual(await runtime.render({capability:'display.face',params:{expression:'happy'}}),{expression:'happy'});
 assert.deepEqual(await runtime.render({capability:'audio.output',params:{text:'Hello Alex'}}),{characters:10});
 assert.equal(runtime.snapshot().face,'happy');
 assert.equal(runtime.snapshot().caption,'Hello Alex');
 assert.equal(runtime.snapshot().physicalAudio,false);
 assert.match(logged[0],/virtual-display/);
 assert.match(logged[1],/virtual-caption/);
 await runtime.render({capability:'audio.output',params:{text:'Hello\u001b[31mworld'}});
 assert.equal(logged.at(-1).includes('\u001b'),false,'CLI must never execute untrusted ANSI controls');

 assert.equal(await runtime.render({capability:'audio.output',params:{text:'cancel'}},{isCancelled:()=>true}),null);
 await assert.rejects(()=>runtime.render({capability:'audio.output',params:{text:''}}),/INVALID_VIRTUAL_PRESENTATION_TEXT/);
 await assert.rejects(()=>runtime.render({capability:'display.face',params:{expression:'evil'}}),/INVALID_VIRTUAL_PRESENTATION_FACE/);
});

test('gateway v3 requires authenticated typed render evidence before presentation success',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-v3-gateway-'));
 try{
  const registry=new DeviceRegistry(join(dir,'devices.json'));
  const gateway=new DeviceGateway(join(dir,'gateway.json'),registry);
  const paired=await registry.complete(registry.start('parent').code,'Terminal');
  await gateway.announce(paired.deviceId,paired.token,['display.face','audio.output','sim.navigation.goto'],3);
  await registry.heartbeat(paired.deviceId,paired.token);
  await gateway.approve('parent',paired.deviceId,['display.face','audio.output','sim.navigation.goto']);
  const started=await gateway.dispatch('parent',{deviceId:paired.deviceId,capability:'display.face',
    params:{expression:'happy'},requestId:fresh()});
  assert.equal(started.ok,true);
  const jobId=started.job.id;
  const base={jobId,sequence:1,phase:'rendered',kind:'display.face',observed:{expression:'happy'}};
  assert.equal((await gateway.presentation(paired.deviceId,paired.token,base)).ok,false);
  assert.equal((await gateway.result(paired.deviceId,paired.token,{jobId,status:'running'})).ok,true);
  assert.equal((await gateway.result(paired.deviceId,paired.token,{jobId,status:'succeeded'})).ok,false);
  await assert.rejects(()=>gateway.presentation(paired.deviceId,'bad',base),/DEVICE_UNAUTHORIZED/);
  await assert.rejects(()=>gateway.presentation(paired.deviceId,paired.token,{...base,kind:'audio.output'}),/INVALID_PRESENTATION_CAPABILITY/);
  await assert.rejects(()=>gateway.presentation(paired.deviceId,paired.token,{...base,observed:{expression:'sleepy'}}),/INVALID_PRESENTATION_FEEDBACK/);
  assert.equal((await gateway.presentation(paired.deviceId,paired.token,base)).ok,true);
  assert.equal((await gateway.presentation(paired.deviceId,paired.token,base)).duplicate,true);
  const finished=await gateway.result(paired.deviceId,paired.token,{jobId,status:'succeeded'});
  assert.equal(finished.ok,true);
  assert.equal(finished.job.presentationEvidence.kind,'display.face');
  assert.equal((await gateway.presentation(paired.deviceId,paired.token,base)).ok,false);
  const audio=await gateway.dispatch('parent',{deviceId:paired.deviceId,capability:'audio.output',
    params:{text:'Hi'},requestId:fresh()});
  const id=audio.job.id;
  await gateway.result(paired.deviceId,paired.token,{jobId:id,status:'running'});
  await assert.rejects(()=>gateway.presentation(paired.deviceId,paired.token,{
    jobId:id,sequence:1,phase:'rendered',kind:'audio.output',observed:{characters:3}
  }),/INVALID_PRESENTATION_FEEDBACK/);
  assert.equal((await gateway.presentation(paired.deviceId,paired.token,{
    jobId:id,sequence:1,phase:'rendered',kind:'audio.output',observed:{characters:2}
  })).ok,true);
  assert.equal((await gateway.result(paired.deviceId,paired.token,{jobId:id,status:'succeeded'})).ok,true);
  const raw=await readFile(join(dir,'gateway.json'),'utf8');
  assert.ok(!raw.includes(paired.token));
  assert.match(raw,/presentationEvidence/);
  const loaded=new DeviceGateway(join(dir,'gateway.json'),registry);
  await loaded.load();
  assert.equal(loaded.list().find(x=>x.id===id).status,'succeeded');

  // A v2 device retains the previous non-evidenced virtual presentation semantics.
  const oldDevice=await registry.complete(registry.start('parent').code,'V2');
  await gateway.announce(oldDevice.deviceId,oldDevice.token,['display.face'],2);
  await registry.heartbeat(oldDevice.deviceId,oldDevice.token);
  await gateway.approve('parent',oldDevice.deviceId,['display.face']);
  const old=await gateway.dispatch('parent',{deviceId:oldDevice.deviceId,capability:'display.face',
    params:{expression:'neutral'},requestId:fresh()});
  await gateway.result(oldDevice.deviceId,oldDevice.token,{jobId:old.job.id,status:'running'});
  assert.equal((await gateway.result(oldDevice.deviceId,oldDevice.token,{jobId:old.job.id,status:'succeeded'})).ok,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('terminal runtime loads before app and cannot touch microphone/network directly',async()=>{
 const html=await readFile(join(cwd,'public/index.html'),'utf8');
 const app=await readFile(join(cwd,'public/app.js'),'utf8');
 const runtime=await readFile(join(cwd,'public/terminal-runtime.js'),'utf8');
 assert.ok(html.indexOf('/terminal-runtime.js')<html.indexOf('/app.js'));
 assert.match(app,/const terminalRuntime=new globalThis.AlexTerminalRuntime\(\)/);
 assert.match(app,/terminalRuntime\.current\(revision\)/);
 assert.match(app,/voiceBridge\.interrupt\('pagehide'\)/);
 assert.match(app,/refreshCompanionPrivacy\(true\)/);
 const bridge=await readFile(join(cwd,'public/voice-session.js'),'utf8');
 assert.match(bridge,/this\.onTranscript\(\{text:transcript,isFinal\}\)/);
 assert.match(bridge,/epoch!==this\.#epoch/);
 assert.doesNotMatch(runtime,/getUserMedia|fetch\(|webkitSpeechRecognition/);
});
