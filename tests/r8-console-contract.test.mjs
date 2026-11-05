import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';

const cwd=resolve(import.meta.dirname,'..');
test('R8 browser and server scripts parse; worklet registered before UI starts',async()=>{
 for(const file of [
  'public/pcm-capture-processor.js',
  'public/realtime-pcm-session.js','public/app.js',
  'scripts/realtime-wss.mjs','scripts/realtime-transcription-provider.mjs',
  'scripts/realtime-pcm-sessions.mjs','scripts/server.mjs'
 ])execFileSync(process.execPath,['--check',join(cwd,file)],{stdio:'pipe'});
 const html=await readFile(join(cwd,'public/index.html'),'utf8');
 assert.ok(html.indexOf('/realtime-pcm-session.js')<html.indexOf('/app.js'));
 for(const control of ['companion-realtime-record','companion-realtime-partial'])
  assert.ok(html.includes('id="'+control+'"'));
 assert.match(html,/实时转写/);
 assert.match(html,/第三方实时转写供应商/);
});
test('R8 parent authorization and browser explicit initiation are not bypassed by UI',async()=>{
 const server=await readFile(join(cwd,'scripts/server.mjs'),'utf8');
 const app=await readFile(join(cwd,'public/app.js'),'utf8');
 for(const path of ['capabilities','start','frame','status','metrics','commit','cancel'])
  assert.ok(server.includes('/api/audio/realtime/'+path));
 assert.match(server,/audioAllowed\(principal,'asr'\)/);
 assert.match(server,/realtimeSessions\?\.erasePrincipal\('learner:'\+data\.id\)/);
 assert.match(server,/realtimeSessions\?\.eraseScope\(data\.scope\)/);
 assert.match(app,/\$\('companion-realtime-record'\)\.addEventListener\('click'/);
 assert.match(app,/if\(!realtimeCapabilities\.inputAllowed\)/);
 assert.match(app,/realtimePcmBridge\.interrupt\('identity-changed'\)/);
 assert.match(app,/realtimePcmBridge\.interrupt\('parent-revoked'\)/);
 assert.match(app,/realtimePcmBridge\.interrupt\('pagehide'\)/);
 assert.match(app,/realtimePcmBridge\.interrupt\('chat-submit'\)/);
 assert.match(app,/realtimePcmBridge\.stop\(\)/);
});
test('R8 realtime PCM bridge and worklet never auto send chat, persist audio or control devices',async()=>{
 const source=await readFile(join(cwd,'public/realtime-pcm-session.js'),'utf8');
 const processor=await readFile(join(cwd,'public/pcm-capture-processor.js'),'utf8');
 const executable=source.replace(/^\s*\/\/.*$/gm,'');
 for(const path of ['/api/audio/realtime/start','/api/audio/realtime/frame',
  '/api/audio/realtime/status','/api/audio/realtime/commit',
  '/api/audio/realtime/cancel'])
  assert.ok(source.includes(path));
 assert.match(source,/this\.onTranscript\(\{text:result\.text/);
 assert.match(source,/requiresManualSubmit:true/);
 assert.match(processor,/this\.frame\.fill\(0\)/);
 assert.match(processor,/registerProcessor\('alex-pcm16-capture'/);
 assert.doesNotMatch(executable,/\/api\/gateway|\/api\/companion\/stream|requestSubmit|\.submit\(/);
 assert.doesNotMatch(executable,/localStorage|sessionStorage|indexedDB/);
 assert.doesNotMatch(processor,/fetch\(|WebSocket|localStorage|indexedDB|SpeechRecognition/);
});
