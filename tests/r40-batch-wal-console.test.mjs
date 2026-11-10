import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');
test('R40 durable batch WAL console is parent-only and escapes dynamic records',()=>{
 for(const id of ['skill-batch-wal-recover','skill-batch-wal-status','skill-batch-wal-list'])
  assert.ok(html.indexOf('id="'+id+'"')>html.indexOf('id="family-private"'),id);
 assert.ok(app.includes("fetch('/api/skills/batch-transactions'"));
 assert.ok(app.includes("action:'batch-recover'"));
 assert.ok(app.includes("action:'batch-abandon'"));
 assert.ok(app.includes("operationId:'parent-batch-'+crypto.randomUUID()"));
 assert.ok(app.includes('esc(r.operationId)'));
 assert.ok(app.includes('esc(r.targets.map('));
 assert.ok(app.includes('window.confirm('));
});
test('R40 parent endpoints are private and all atomic-batch mutations flow through durable WAL',()=>{
 const get=server.indexOf("pathname==='/api/skills/batch-transactions'");
 assert.ok(get>0);
 assert.ok(server.slice(get,get+320).includes("auth.mode!=='local'"));
 assert.ok(server.slice(get,get+320).includes("auth.actor(req)!=='parent'"));
 assert.ok(server.includes('await skillBatchTransactions.apply(actor,data)'));
 assert.ok(server.includes('await skillBatchTransactions.recover(actor)'));
 assert.ok(server.includes('await skillBatchTransactions.abandon(actor,data)'));
 assert.ok(!server.includes('await skillPackages.installBatch(actor,data)'));
});
