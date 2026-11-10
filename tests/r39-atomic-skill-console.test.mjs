import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const js=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');
test('R39 parent atomic batch UI is private, reviewed, and disables commit before preview',()=>{
 const start=html.indexOf('id="family-private"');
 for(const id of ['skill-atomic-batch-preview','skill-atomic-batch-status',
  'skill-atomic-batch-results','skill-atomic-batch-commit'])
  assert.ok(html.indexOf('id="'+id+'"')>start,id);
 assert.match(html,/id="skill-atomic-batch-commit" disabled/);
 assert.ok(js.includes("action:'atomic-plan'"));
 assert.ok(js.includes("action:'atomic-batch'"));
 assert.ok(js.includes("plan.currentPins"));
 assert.ok(js.includes("atomicSkillBatchPlan=null"));
 assert.ok(js.includes('window.confirm('));
 assert.ok(js.includes('esc(blocker.reason)'));
});
test('R39 server only exposes verified parent atomic planning and install actions',()=>{
 const start=server.indexOf("pathname==='/api/skills/packages'");
 assert.ok(start>0);
 assert.ok(server.slice(start,start+500).includes("auth.mode!=='local'"));
 assert.ok(server.slice(start,start+500).includes("actor!=='parent'"));
 assert.ok(server.includes("action==='atomic-plan'"));
 assert.ok(server.includes("action==='atomic-batch'"));
 assert.ok(server.includes('await skillPackages.installBatch(actor,data)'));
 assert.ok(server.includes('verify:manifest=>skillPackageTrust.assertTrusted(manifest)'));
});
