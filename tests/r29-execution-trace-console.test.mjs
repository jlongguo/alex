import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
test('R29 read-only execution trace explorer is in Agent/Task Center',()=>{
 const i=html.indexOf('id="execution-trace-section"');
 const j=html.indexOf('id="workflow-section"',i);
 assert.ok(i>=0&&j>i);
 const panel=html.slice(i,j);
 for(const id of ['execution-trace-refresh','execution-trace-notice',
  'execution-trace-list','execution-trace-detail'])
  assert.ok(panel.includes('id="'+id+'"'),id);
 assert.ok(panel.includes('data-nav-view="tasks"'));
});
test('R29 console uses parent-only read endpoints and escapes trace details',()=>{
 assert.ok(app.includes("if(authorizedActor!=='parent')return;"));
 assert.ok(app.includes("fetch('/api/executions?limit=25'"));
 assert.ok(app.includes("fetch('/api/executions/'+encodeURIComponent(id)"));
 for(const field of ['trace.id','step.kind','step.correlation','step.skillId',
  'step.job.jobId','step.dispatchRequestId'])
  assert.ok(app.includes('esc('+field+')'),field);
 assert.ok(app.includes('gatewayHistoryMayBeTruncated'));
 assert.ok(!app.includes("api('/api/executions"));
});
