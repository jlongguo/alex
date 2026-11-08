import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderBillingStatementStore,ProviderBillingReconciler} from '../scripts/provider-billing-reconciliation.mjs';

async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'alex-r25-report-'));
 mkdirSync(dir,{recursive:true});
 try{return await fn(join(dir,'billing.jsonl'));}
 finally{rmSync(dir,{recursive:true,force:true});}
}
const invoice=(id,provider,currency,start,end,items)=>({
 schemaVersion:1,statementId:id,provider,currency,
 periodStart:start,periodEnd:end,items
});
const journal={usageForPeriod:({provider,model,from,to})=>({
 requests:1,responseBytes:provider==='vendor-a'?1000:500,
 completed:1,cancelled:0,failed:0,inflight:0
})};
test('R25 summary aggregates by currency without cross-currency conversion',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(invoice('usd-1','vendor-a','USD',
  '2026-11-01T00:00:00Z','2026-11-02T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:1000,amountMinor:20},
   {model:'voice-v1',metric:'characters',quantity:300,amountMinor:5}
  ]));
 store.importStatement(invoice('eur-1','vendor-b','EUR',
  '2026-11-01T00:00:00Z','2026-11-02T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:500,amountMinor:2}
  ]));
 const result=new ProviderBillingReconciler({statements:store,journal}).summary();
 assert.equal(result.statementCount,2);
 assert.deepEqual(result.currencyTotals.map(x=>[x.currency,x.amountMinor]),
  [['USD',25],['EUR',2]]);
 assert.equal(result.currencyConversion,'none');
 assert.equal(result.groups.length,3);
 assert.equal(result.groups.find(x=>x.currency==='USD'&&x.metric==='pcm_bytes').variance,0);
 assert.equal(result.groups.find(x=>x.metric==='characters').localQuantity,null);
}));
test('R25 report filters by overlapping UTC period and exact provider',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(invoice('old','vendor-a','USD',
  '2026-11-01T00:00:00Z','2026-11-02T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:1,amountMinor:1}
  ]));
 store.importStatement(invoice('new','vendor-a','USD',
  '2026-11-03T00:00:00Z','2026-11-04T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:2,amountMinor:2}
  ]));
 store.importStatement(invoice('other','vendor-b','EUR',
  '2026-11-03T00:00:00Z','2026-11-04T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:3,amountMinor:3}
  ]));
 const reconciler=new ProviderBillingReconciler({statements:store,journal});
 const from=Date.parse('2026-11-02T00:00:00Z'),to=Date.parse('2026-11-04T00:00:00Z');
 assert.deepEqual(reconciler.report({from,to,provider:'vendor-a'}).map(x=>x.statementId),['new']);
 assert.equal(reconciler.summary({from,to}).statementCount,2);
}));
test('R25 invalid or partial report windows are rejected',()=>fixture(file=>{
 const reconciler=new ProviderBillingReconciler({
  statements:new ProviderBillingStatementStore({file}),journal
 });
 assert.throws(()=>reconciler.report({from:1}),/INVALID_PROVIDER_BILLING_REPORT_WINDOW/);
 assert.throws(()=>reconciler.report({from:10,to:10}),/INVALID_PROVIDER_BILLING_REPORT_WINDOW/);
 assert.throws(()=>reconciler.report({provider:''}),/INVALID_PROVIDER_BILLING_REPORT_FILTER/);
}));
test('R25 refuses monetary aggregate overflow rather than returning an unsafe number',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(invoice('huge-1','vendor-a','USD',
  '2026-11-01T00:00:00Z','2026-11-02T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:1,amountMinor:Number.MAX_SAFE_INTEGER}
  ]));
 store.importStatement(invoice('huge-2','vendor-a','USD',
  '2026-11-01T00:00:00Z','2026-11-02T00:00:00Z',[
   {model:'voice-v1',metric:'pcm_bytes',quantity:1,amountMinor:1}
  ]));
 const reconciler=new ProviderBillingReconciler({statements:store,journal});
 assert.throws(()=>reconciler.summary(),/PROVIDER_BILLING_AGGREGATE_OVERFLOW/);
}));
