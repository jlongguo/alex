import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');
test('R38 parent-only upgrade form and capacity/recovery interface are wired',()=>{
 const start=html.indexOf('id="family-private"');
 for(const id of ['skill-upgrade-plan-form','skill-upgrade-targets','skill-upgrade-plan-status',
  'skill-upgrade-plan-results'])assert.ok(html.indexOf('id="'+id+'"')>start,id);
 assert.ok(app.includes("action:'upgrade-plan'"));
 assert.ok(app.includes("esc(b.reason)"));
 assert.ok(app.includes("state.readiness.remaining"));
 assert.ok(app.includes("data-abandon-transaction"));
 assert.ok(app.includes("action:'abandon'"));
 assert.ok(app.includes("authorizedActor!=='parent'"));
 assert.ok(app.includes('window.confirm('));
});
test('R38 server routes require verified parent and expose only advisory planning',()=>{
 const start=server.indexOf("pathname==='/api/skills/packages'");
 assert.ok(start>0);
 const post=server.indexOf("action==='upgrade-plan'");
 assert.ok(post>start);
 assert.ok(server.includes('verify:manifest=>skillPackageTrust.assertTrusted(manifest)'));
 assert.ok(server.includes("action==='abandon'"));
 assert.ok(server.includes("readiness:skillTransactions.readiness('parent')"));
});
