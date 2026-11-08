import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderBillingStatementStore} from '../scripts/provider-billing-reconciliation.mjs';

async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'alex-r24-provenance-'));
 mkdirSync(dir,{recursive:true});
 try{return await fn(join(dir,'billing.jsonl'));}
 finally{rmSync(dir,{recursive:true,force:true});}
}
const statement=()=>({
 schemaVersion:1,statementId:'r24-invoice-001',provider:'tts-provider',
 currency:'USD',periodStart:'2026-11-01T00:00:00Z',
 periodEnd:'2026-11-02T00:00:00Z',
 items:[{model:'voice-v1',metric:'pcm_bytes',quantity:1000,amountMinor:10}]
});
const provenance=(source='json')=>({
 source,importedAt:'2026-11-09T00:00:00.000Z',
 sourceDigest:'a'.repeat(64),mappingDigest:source==='csv'?'b'.repeat(64):null
});
test('R24 source provenance survives restart without storing raw input',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement(),{provenance:provenance('csv')});
 const raw=readFileSync(file,'utf8');
 assert.ok(raw.includes('sourceDigest'));
 assert.ok(!raw.includes('rawCsv'));
 const restarted=new ProviderBillingStatementStore({file});
 const saved=restarted.list()[0].provenance;
 assert.equal(saved.source,'csv');
 assert.equal(saved.sourceDigest,'a'.repeat(64));
 assert.equal(saved.mappingDigest,'b'.repeat(64));
 assert.equal(saved.importedAt,'2026-11-09T00:00:00.000Z');
}));
test('R24 duplicate imports preserve original provenance and statement identity',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement(),{provenance:provenance('json')});
 const duplicate=store.importStatement(statement(),{provenance:provenance('csv')});
 assert.equal(duplicate.duplicate,true);
 const saved=new ProviderBillingStatementStore({file}).list()[0];
 assert.equal(saved.provenance.source,'json');
 assert.equal(saved.provenance.mappingDigest,null);
}));
test('R24 invalid provenance is rejected before durable append',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 assert.throws(()=>store.importStatement(statement(),{provenance:{
  source:'unknown',importedAt:'not-a-date',sourceDigest:'bad',mappingDigest:null
 }}),/INVALID_PROVIDER_BILLING_PROVENANCE/);
 assert.equal(store.list().length,0);
}));
test('R24 tampered provenance fails closed on restart',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement(),{provenance:provenance()});
 const record=JSON.parse(readFileSync(file,'utf8'));
 record.provenance.sourceDigest='tampered';
 writeFileSync(file,JSON.stringify(record)+'\n');
 assert.throws(()=>new ProviderBillingStatementStore({file}),
  /PROVIDER_BILLING_STORE_INVALID/);
}));
test('R24 legacy normalized statements remain readable without provenance',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 store.importStatement(statement());
 const restarted=new ProviderBillingStatementStore({file});
 assert.equal(restarted.list()[0].provenance,undefined);
}));
