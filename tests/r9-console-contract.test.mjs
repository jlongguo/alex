import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');

test('R9 source syntax parses and only loaded explicit speech player is included before application',async()=>{
 for(const path of ['public/speech-playback-session.js','public/app.js',
   'scripts/streaming-speech-provider.mjs','scripts/streaming-speech-sessions.mjs',
   'scripts/server.mjs'])
  execFileSync(process.execPath,['--check',join(root,path)],{stdio:'pipe'});
 const html=await readFile(join(root,'public/index.html'),'utf8');
 assert.ok(html.indexOf('/speech-playback-session.js')<
  html.indexOf('/app.js'));
 for(const name of ['companion-stream-speak','companion-barge-in',
   'companion-playback-status'])
  assert.ok(html.includes('id="'+name+'"'),'Missing R9 control '+name);
});
test('R9 startup requires actual parental permission and explicit user click',async()=>{
 const app=await readFile(join(root,'public/app.js'),'utf8');
 const server=await readFile(join(root,'scripts/server.mjs'),'utf8');
 assert.match(app,/const streamingSpeechBridge=new globalThis\.AlexStreamingSpeechBridge/);
 assert.match(app,/\$\('companion-stream-speak'\)\.addEventListener\('click'/);
 assert.match(app,/\$\('companion-barge-in'\)\.addEventListener\('click'/);
 assert.match(app,/if\(!speechStreamCapabilities\.outputAllowed\)/);
 assert.match(app,/streamingSpeechBridge\.interrupt\('identity-changed'\)/);
 assert.match(app,/streamingSpeechBridge\.interrupt\('parent-revoked'\)/);
 assert.match(app,/streamingSpeechBridge\.interrupt\('pagehide'\)/);
 assert.match(app,/streamingSpeechBridge\.interrupt\('chat-submit'\)/);
 assert.match(app,/streamingSpeechBridge\.interrupt\('user-barge-in'\)/);
 assert.match(server,/audioAllowed\(principal,'tts'\)/);
 assert.match(server,/speechPlayback\?\.erasePrincipal\('learner:'\+data\.id\)/);
 assert.match(server,/speechPlayback\?\.eraseScope\(data\.scope\)/);
 for(const path of ['capabilities','start','next','ack','status','cancel','metrics'])
  assert.ok(server.includes('/api/audio/playback/'+path));
});
test('R9 playback module has no conversational auto-send, provider credentials or audio persistence side effects',async()=>{
 const source=await readFile(join(root,'public/speech-playback-session.js'),'utf8');
 const active=source.replace(/^\s*\/\/.*$/gm,'');
 assert.match(source,/source\.onended/);
 assert.match(source,/this\.\#sources\.size<2/);
 assert.match(source,/this\.onStatus/);
 assert.match(source,/playedMsClaimed/);
 assert.match(source,/this\.fetchFn\('\/api\/audio\/playback\/ack'/);
 assert.doesNotMatch(active,/\/api\/companion\/stream|\/api\/gateway\/dispatch|requestSubmit|\.submit\(/);
 assert.doesNotMatch(active,/\b(?:localStorage|sessionStorage|indexedDB)\b/);
 assert.doesNotMatch(active,/SpeechRecognition|MediaRecorder/);
});
