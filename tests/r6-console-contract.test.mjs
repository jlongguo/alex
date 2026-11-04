import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const root=resolve(import.meta.dirname,'..');
test('R6 browser scripts parse; cloud media controls and explicit grants are all wired',{timeout:12000},async()=>{
 for(const file of ['public/app.js','public/audio-session.js','public/voice-session.js']){
  execFileSync(process.execPath,['--check',join(root,file)],{stdio:'pipe'});
 }
 const html=await readFile(join(root,'public/index.html'),'utf8');
 const app=await readFile(join(root,'public/app.js'),'utf8');
 assert.ok(html.indexOf('/audio-session.js')<html.indexOf('/app.js'));
 for(const id of ['companion-cloud-record','companion-cloud-speak',
  'companion-audio-cancel','companion-audio-policy',
  'learner-privacy-cloud-asr','learner-privacy-cloud-tts']){
  assert.ok(html.includes('id="'+id+'"'),'Missing R6 UI element '+id);
  assert.ok(app.includes("'"+id+"'"),'Missing R6 handler '+id);
 }
 assert.match(app,/refreshAudioCapabilities/);
 assert.match(app,/cloudAudioBridge\.startCapture/);
 assert.match(app,/cloudAudioBridge\.stopCapture/);
 assert.match(app,/cloudAudioBridge\.speak/);
 assert.match(app,/cloudAudioBridge\.interrupt\('identity-changed'\)/);
 assert.match(app,/cloudAudioBridge\.interrupt\('pagehide'\)/);
 assert.match(app,/cloudAudioInputAllowed,cloudAudioOutputAllowed/);
});
test('R6 cloud audio module never automatically invokes chat, robot actions or persistent media stores',async()=>{
 const code=await readFile(join(root,'public/audio-session.js'),'utf8');
 assert.match(code,/this\.onTranscript\(\{text:result\.text,requiresManualSubmit:true\}\)/);
 assert.match(code,/getUserMedia/);
 assert.match(code,/new Blob\(chunks/);
 assert.match(code,/this\.urlApi\.revokeObjectURL/);
 assert.match(code,/this\.\#controller\?\.abort\(\)/);
 assert.doesNotMatch(code,/\/api\/companion\/stream|\/api\/gateway\/dispatch|\/api\/safety\/stop/);
 assert.doesNotMatch(code,/localStorage|sessionStorage|indexedDB|requestSubmit/);
});
