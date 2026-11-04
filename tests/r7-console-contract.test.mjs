import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const cwd=resolve(import.meta.dirname,'..');

test('R7 real browser source parses and scripts load before app',async()=>{
 const scripts=['audio-vad.js','audio-stream-session.js','audio-session.js','app.js'];
 for(const name of scripts)
   execFileSync(process.execPath,['--check',join(cwd,'public',name)],{stdio:'pipe'});
 const html=await readFile(join(cwd,'public/index.html'),'utf8');
 for(const name of ['audio-vad.js','audio-stream-session.js'])
   assert.ok(html.indexOf('/'+name)>0&&html.indexOf('/'+name)<html.indexOf('/app.js'));
 for(const id of ['companion-stream-record','companion-stream-vad',
   'companion-stream-notice'])
   assert.ok(html.includes('id="'+id+'"'),'Missing incremental recording control '+id);
 assert.ok(html.includes('增量'));
 assert.ok(html.includes('语音供应商仍在完成录制后处理'));
});
test('R7 app only starts browser audio after explicit user action and server capabilities',async()=>{
 const app=await readFile(join(cwd,'public/app.js'),'utf8');
 assert.match(app,/const streamingAudioBridge=new globalThis\.AlexStreamingAudioBridge/);
 assert.match(app,/\$\('companion-stream-record'\)\.addEventListener\('click'/);
 assert.match(app,/if\(!audioCapabilities\.inputAllowed\)/);
 assert.match(app,/autoStopOnSilence:\$\('companion-stream-vad'\)\.checked/);
 assert.match(app,/streamingAudioBridge\.interrupt\('identity-changed'\)/);
 assert.match(app,/streamingAudioBridge\.interrupt\('parent-revoked'\)/);
 assert.match(app,/streamingAudioBridge\.interrupt\('pagehide'\)/);
 assert.match(app,/streamingAudioBridge\.interrupt\('chat-submit'\)/);
});
test('R7 streaming bridge cannot auto submit transcriptions, dispatch device tasks or persist raw media',async()=>{
 const code=await readFile(join(cwd,'public/audio-stream-session.js'),'utf8');
 const executable=code.replace(/^\s*\/\/.*$/gm,'');
 for(const path of ['/api/audio/turn/start','/api/audio/turn/chunk',
   '/api/audio/turn/finish','/api/audio/turn/cancel'])
   assert.ok(code.includes(path),'Missing expected ingress endpoint '+path);
 assert.match(code,/requiresManualSubmit:true/);
 assert.match(code,/onTranscript\(\{text:result\.text/);
 assert.match(code,/this\.\#pending=this\.\#pending\.then/);
 assert.doesNotMatch(executable,/requestSubmit|\.submit\(|\/api\/companion\/stream|\/api\/gateway\/dispatch/);
 assert.doesNotMatch(executable,/\blocalStorage\b|\bindexedDB\b|\bsessionStorage\b/);
});
test('R7 server checks login/permission on ingress and never exports source audio or sample frames',async()=>{
 const server=await readFile(join(cwd,'scripts/server.mjs'),'utf8');
 const source=await readFile(join(cwd,'scripts/audio-ingress-sessions.mjs'),'utf8');
 for(const path of ['turn/start','turn/chunk','turn/finish','turn/cancel',
   'turn/status','turn/metrics'])
   assert.ok(server.includes('/api/audio/'+path));
 assert.match(server,/audioAllowed\(principal,'asr'\)/);
 assert.match(server,/audioIngress\.cancelAllChildren\(\)/);
 assert.match(server,/audioIngress\.erasePrincipal\('learner:'\+data\.id\)/);
 assert.match(source,/scrub\(session\)/);
 assert.doesNotMatch(source,/writeFile|appendFile|INSERT INTO|localStorage/);
});
