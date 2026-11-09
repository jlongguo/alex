import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const client=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');
test('R36 reconciliation view is parent-private and never renders untrusted markup',()=>{
 assert.ok(html.indexOf('id="skill-reconciliation-status"')>html.indexOf('id="family-private"'));
 for(const id of ['skill-reconciliation-refresh','skill-reconciliation-findings'])
  assert.ok(html.includes('id="'+id+'"'));
 assert.ok(client.includes("fetch('/api/skills/reconciliation'"));
 assert.ok(client.includes("authorizedActor!=='parent'"));
 assert.ok(client.includes('esc(f.kind)'));
 assert.ok(client.includes('esc(f.id??'));
});
test('R36 server checks local parent identity before exposing reconciliation',()=>{
 const route=server.indexOf("pathname==='/api/skills/reconciliation'");
 assert.ok(route>0);
 const scope=server.slice(route,route+500);
 assert.ok(scope.includes("auth.mode!=='local'"));
 assert.ok(scope.includes("auth.actor(req)!=='parent'"));
 assert.ok(scope.includes('reconcileSkillStores('));
});
