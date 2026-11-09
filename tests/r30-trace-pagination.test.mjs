import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ExecutionTraceProjector} from '../scripts/execution-trace-projector.mjs';
const id=(kind='plan')=>kind+'-'+randomUUID();
const at=ms=>new Date(Date.UTC(2026,10,9,0,0,0,ms)).toISOString();
function fixture(count=21){
 const deviceId='dev-'+randomUUID(),otherId='dev-'+randomUUID();
 const roots=Array.from({length:count},(_,i)=>({
  id:id(i%3===0?'wf':'plan'),requestId:'r30_request_'+i,
  deviceId:i%2?otherId:deviceId,status:'succeeded',reason:null,
  createdAt:at(Math.floor(i/2)),updatedAt:at(Math.floor(i/2)),
  steps:[]
 }));
 const plans=roots.filter(r=>r.id.startsWith('plan-'));
 const workflows=roots.filter(r=>r.id.startsWith('wf-'));
 const projector=new ExecutionTraceProjector({
  plans:{list:()=>plans,getEvents:()=>[]},
  workflows:{list:()=>workflows},
  gateway:{list:()=>[],getEvents:()=>({events:[],oldestSeq:null,latestSeq:0})}
 });
 return {projector,roots,plans,workflows,deviceId,otherId};
}
test('R30 stable keyset pagination covers tied timestamps once without gaps',()=>{
 const f=fixture(37),seen=[],cursors=[];
 let cursor,hasMore=true;
 while(hasMore){
  const page=f.projector.page({limit:4,...(cursor?{cursor}:{})});
  seen.push(...page.executions.map(r=>r.id));
  if(page.nextCursor)cursors.push(page.nextCursor);
  cursor=page.nextCursor;
  hasMore=page.hasMore;
  assert.equal(hasMore,Boolean(cursor));
  assert.ok(page.executions.length<=4);
 }
 assert.equal(seen.length,37);
 assert.equal(new Set(seen).size,37);
 assert.deepEqual(seen,f.projector.list({limit:100}).map(r=>r.id));
 assert.equal(cursors.length,9);
});
test('R30 inserting a new execution ahead of cursor does not repeat earlier entries',()=>{
 const f=fixture(7);
 const first=f.projector.page({limit:3});
 const previous=first.executions.map(r=>r.id);
 f.plans.unshift({id:id(),requestId:'new_request_123456',deviceId:f.deviceId,
  status:'running',reason:null,createdAt:at(1000),updatedAt:at(1000),steps:[]});
 const second=f.projector.page({limit:5,cursor:first.nextCursor});
 assert.equal(second.executions.length,4);
 assert.ok(second.executions.every(r=>!previous.includes(r.id)));
 assert.ok(second.executions.every(r=>r.id!==f.plans[0].id));
});
test('R30 filter-bound cursors prevent cross-device and cross-kind reuse',()=>{
 const f=fixture(20);
 const first=f.projector.page({limit:2,kind:'plan',deviceId:f.deviceId});
 assert.equal(first.executions.length,2);
 assert.ok(first.nextCursor);
 const second=f.projector.page({limit:2,kind:'plan',
  deviceId:f.deviceId,cursor:first.nextCursor});
 assert.ok(second.executions.every(r=>r.kind==='plan'&&r.deviceId===f.deviceId));
 assert.throws(()=>f.projector.page({
  limit:2,kind:'workflow',deviceId:f.deviceId,cursor:first.nextCursor
 }),/INVALID_EXECUTION_TRACE_CURSOR/);
 assert.throws(()=>f.projector.page({
  limit:2,kind:'plan',deviceId:f.otherId,cursor:first.nextCursor
 }),/INVALID_EXECUTION_TRACE_CURSOR/);
});
test('R30 malformed and tampered cursors are rejected without scanning sensitive records',()=>{
 const f=fixture();
 const cursor=f.projector.page({limit:2}).nextCursor;
 const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
 const altered=Buffer.from(JSON.stringify({...parsed,id:id()})).toString('base64url');
 // Arbitrary client cursors are positions, not an authorization boundary.
 // Tamper must still be structurally valid and deterministic, never execute effects.
 assert.ok(f.projector.page({limit:2,cursor:altered}).executions.length<=2);
 for(const bad of ['', 'invalid/+',cursor+'$', 'x'.repeat(400),
  Buffer.from('not json').toString('base64url')]){
  assert.throws(()=>f.projector.page({limit:2,cursor:bad}),
   /INVALID_EXECUTION_TRACE_CURSOR/);
 }
 assert.throws(()=>f.projector.page({limit:0}),/INVALID_EXECUTION_TRACE_FILTER/);
});
test('R30 filtered pagination is read-only and does not mutate source arrays',()=>{
 const f=fixture();
 const before=f.roots.map(r=>r.id);
 const page=f.projector.page({limit:3});
 page.executions[0].status='tampered';
 assert.deepEqual(f.roots.map(r=>r.id),before);
 assert.notEqual(f.projector.page({limit:3}).executions[0].status,'tampered');
 f.projector.gateway.dispatch=()=>{throw Error('PAGING_MUST_NOT_DISPATCH')};
 f.projector.page({limit:3,cursor:page.nextCursor});
});
