import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';

const root=resolve(import.meta.dirname,'..');

test('R4 Console JavaScript parses and has all wired curriculum / privacy elements',async()=>{
  execFileSync(process.execPath,['--check',join(root,'public/app.js')],{stdio:'pipe'});
  execFileSync(process.execPath,['--check',join(root,'public/terminal-runtime.js')],{stdio:'pipe'});
  const html=await readFile(join(root,'public/index.html'),'utf8');
  const app=await readFile(join(root,'public/app.js'),'utf8');
  for(const id of [
    'companion-mode','companion-lesson','companion-course-progress',
    'companion-assignments','learning-plan-form','learning-plan-profile',
    'learning-plan-course','learning-plan-target','learning-plan-list',
    'companion-history','companion-progress-summary'
  ]){
    assert.ok(html.includes('id="'+id+'"'),'Missing R4 user-facing control '+id);
    assert.ok(app.includes("'"+id+"'"),'Unwired R4 control '+id);
  }
  for(const mode of ['english','story','quiz','chat'])
    assert.ok(html.includes('value="'+mode+'"'),'Missing interactive mode '+mode);
  for(const endpoint of ['/api/learning/catalog','/api/learning/assign','/api/learning/overview'])
    assert.ok(app.includes(endpoint),'Missing UI integration '+endpoint);
  assert.match(app,/textContent=course.title/,'Untrusted course titles must not be inserted as HTML');
  assert.match(app,/esc\(profile\?\.nickname/,'Learner names must be escaped when using HTML templates');
});

test('R4 browser never forwards model output to DeviceGateway or physical actuators',async()=>{
  const app=await readFile(join(root,'public/app.js'),'utf8');
  const streamBegin=app.indexOf('async function receiveCompanionStream(');
  const streamEnd=app.indexOf("'companion-delete').addEventListener",streamBegin);
  assert.ok(streamBegin>=0&&streamEnd>streamBegin);
  const portion=app.slice(streamBegin,streamEnd);
  assert.ok(portion.includes('preview.body.textContent+=delta'));
  assert.ok(portion.includes('/api/companion/stream'));
  assert.doesNotMatch(portion,/\/api\/gateway\/dispatch|\/api\/safety\/reset|\/api\/environment/);
  assert.doesNotMatch(portion,/\.innerHTML\s*=\s*(?:delta|result\.assistant)/);
});
