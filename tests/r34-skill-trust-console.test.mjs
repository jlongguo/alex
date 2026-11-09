import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
test('R34 trust controls live in parent-only family workspace',()=>{
 const boundary=html.indexOf('id="family-private"');
 const panel=html.indexOf('id="skill-package-panel"');
 const trust=html.indexOf('id="skill-attestation-form"');
 assert.ok(boundary>=0&&panel>boundary&&trust>panel);
 for(const id of ['skill-publisher-form','skill-publisher-id','skill-publisher-key',
  'skill-attestation-form','skill-attestation-json','skill-trust-notice',
  'skill-trust-publishers','skill-trust-events'])
  assert.ok(html.includes('id="'+id+'"'),id);
});
test('R34 UI never asks for private keys and escapes publisher data',()=>{
 assert.ok(app.includes("fetch('/api/skills/trust'"));
 assert.ok(app.includes("api('/api/skills/trust'"));
 assert.ok(app.includes("authorizedActor!=='parent'"));
 assert.ok(app.includes('esc(p.fingerprint.slice('));
 assert.ok(app.includes('esc(e.target)'));
 assert.ok(app.includes('window.confirm('));
 assert.ok(!html.includes('PRIVATE KEY-----'));
 assert.ok(!html.includes('id="skill-private-key"'));
});
