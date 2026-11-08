import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderBillingStatementStore,ProviderBillingReconciler} from '../scripts/provider-billing-reconciliation.mjs';
import {ProviderUsageJournal} from '../scripts/provider-usage-journal.mjs';

async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'alex-r21-billing-'));
 mkdirSync(join(dir,'nested'),{recursive:true});
 try{return await fn(join(dir,'nested','billing.jsonl'),join(dir,'usage.jsonl'));}
 finally{rmSync(dir,{recursive:true,force:true});}
}
const statement=(overrides={})=>({
 schemaVersion:1,statementId:'invoice-2026-11-001',provider:'compatible-pcm-stream',
 currency:'USD',periodStart:'2026-11-01T00:00:00Z',
 periodEnd:'2026-11-02T00:00:00Z',
 items:[{model:'voice-v1',metric:'pcm_bytes',quantity:9600,amountMinor:12},
  {model:'voice-v1',metric:'characters',quantity:2500,amountMinor:8}],
 ...overrides
});
test('R21 statement import persists and reloads normalized records',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 assert.deepEqual(store.importStatement(statement()),{
  imported:true,duplicate:false,statementId:'invoice-2026-11-001'});
 const restarted=new ProviderBillingStatementStore({file});
 assert.equal(restarted.list().length,1);
 assert.equal(restarted.list()[0].currency,'USD');
 assert.equal(restarted.list()[0].items[0].amountMinor,12);
}));
test('R21 identical statement import is idempotent; changed content conflicts',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement());
 assert.equal(store.importStatement(statement()).duplicate,true);
 assert.throws(()=>store.importStatement(statement({items:[
  {model:'voice-v1',metric:'pcm_bytes',quantity:1,amountMinor:1}
 ]})),/PROVIDER_BILLING_STATEMENT_ID_CONFLICT/);
 assert.equal(new ProviderBillingStatementStore({file}).list().length,1);
}));
test('R21 rejects invalid currency, period, unsupported metric and unsafe amounts',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 assert.throws(()=>store.importStatement(statement({currency:'US'})),
  /INVALID_PROVIDER_BILLING_STATEMENT/);
 assert.throws(()=>store.importStatement(statement({periodEnd:'2026-10-01T00:00:00Z'})),
  /INVALID_PROVIDER_BILLING_PERIOD/);
 assert.throws(()=>store.importStatement(statement({items:[
  {model:'voice-v1',metric:'usd',quantity:1,amountMinor:1}
 ]})),/INVALID_PROVIDER_BILLING_ITEM/);
 assert.throws(()=>store.importStatement(statement({items:[
  {model:'voice-v1',metric:'pcm_bytes',quantity:1.5,amountMinor:1}
 ]})),/INVALID_PROVIDER_BILLING_ITEM/);
 assert.throws(()=>store.importStatement(statement({items:[
  {model:'voice-v1',metric:'request_count',quantity:1,amountMinor:Number.MAX_SAFE_INTEGER+1}
 ]})),/INVALID_PROVIDER_BILLING_ITEM/);
 assert.equal(store.list().length,0);
}));
test('R21 reconciliation compares only dimensions measured by R20',()=>fixture(async(file,usageFile)=>{
 const usage=new ProviderUsageJournal({file:usageFile,
  now:()=>Date.parse('2026-11-01T12:00:00Z'),
  makeId:(()=>{let n=0;return()=> '11111111-1111-4111-8111-11111111111'+(++n);})()});
 const id=usage.begin({provider:'compatible-pcm-stream',model:'voice-v1'});
 usage.frame(id,4800);usage.finish(id,'completed');
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement({items:[
  {model:'voice-v1',metric:'pcm_bytes',quantity:6000,amountMinor:12},
  {model:'voice-v1',metric:'request_count',quantity:2,amountMinor:4},
  {model:'voice-v1',metric:'characters',quantity:2500,amountMinor:8}
 ]}));
 const report=new ProviderBillingReconciler({statements:store,journal:usage}).report()[0];
 assert.equal(report.items[0].status,'comparable');
 assert.equal(report.items[0].localQuantity,4800);
 assert.equal(report.items[0].variance,-1200);
 assert.equal(report.items[1].status,'not_comparable');
 assert.equal(report.items[1].localQuantity,null);
 assert.match(report.items[1].reason,/billable-request semantics/);
 assert.equal(report.items[2].status,'not_comparable');
 assert.equal(report.items[2].variance,null);
 assert.match(report.note,/not a monetary credit/);
}));
test('R21 reconciliation scopes usage to provider model and statement period',()=>fixture(async(file,usageFile)=>{
 let now=Date.parse('2026-11-01T12:00:00Z'),n=0;
 const usage=new ProviderUsageJournal({file:usageFile,now:()=>now,
  makeId:()=> '22222222-2222-4222-8222-22222222222'+(++n)});
 const id=usage.begin({provider:'compatible-pcm-stream',model:'voice-v1'});
 usage.frame(id,200);
 now=Date.parse('2026-11-03T12:00:00Z');
 const outside=usage.begin({provider:'compatible-pcm-stream',model:'voice-v1'});
 usage.frame(outside,400);
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement({items:[
  {model:'voice-v1',metric:'pcm_bytes',quantity:200,amountMinor:1}
 ]}));
 const report=new ProviderBillingReconciler({statements:store,journal:usage}).report()[0];
 assert.equal(report.items[0].localQuantity,200);
}));
test('R21 store refuses corrupt history instead of silently dropping statements',()=>fixture(file=>{
 writeFileSync(file,'not-json\n');
 assert.throws(()=>new ProviderBillingStatementStore({file}),
  /PROVIDER_BILLING_STORE_INVALID/);
}));
test('R21 does not persist unsupported arbitrary input fields',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement({...statement(),privateCustomerEmail:'private@example.test'});
 const raw=readFileSync(file,'utf8');
 assert.ok(!raw.includes('privateCustomerEmail'));
 assert.ok(!raw.includes('private@example.test'));
}));
