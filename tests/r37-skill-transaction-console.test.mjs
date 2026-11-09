import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');
test('R37 durable parent transaction controls are in private console',()=>{
 for(const id of ['skill-transaction-recover','skill-transaction-notice','skill-transaction-list'])
  assert.ok(html.indexOf('id="'+id+'"')>html.indexOf('id="family-private"'),id);
 assert.ok(app.includes('data-package-action="apply"'));
 assert.ok(app.includes("action==='apply'&&!window.confirm"));
 assert.ok(app.includes("operationId:'parent-'+crypto.randomUUID()"));
 assert.ok(app.includes("fetch('/api/skills/transactions'"));
 assert.ok(app.includes("esc(r.operationId)"));
 assert.ok(app.includes("esc(r.publisherId)"));
});
test('R37 transaction read endpoint and writes require parent local auth',()=>{
 const marker="pathname==='/api/skills/transactions'";
 const start=server.indexOf(marker);
 assert.ok(start>0);
 assert.ok(server.slice(start,start+350).includes("auth.mode!=='local'"));
 assert.ok(server.slice(start,start+350).includes("auth.actor(req)!=='parent'"));
 assert.ok(server.includes("action==='apply'"));
 assert.ok(server.includes("action==='recover'"));
 assert.ok(server.includes("await skillTransactions.recover('parent')"));
});
