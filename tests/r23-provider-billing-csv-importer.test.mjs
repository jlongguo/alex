import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderBillingStatementStore} from '../scripts/provider-billing-reconciliation.mjs';
import {ProviderBillingCsvImporter,PROVIDER_BILLING_CSV_FIELDS} from '../scripts/provider-billing-csv-importer.mjs';

async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'alex-r23-csv-'));
 mkdirSync(join(dir,'state'),{recursive:true});
 try{return await fn(join(dir,'state','billing.jsonl'));}
 finally{rmSync(dir,{recursive:true,force:true});}
}
const mapping={statementId:'id',provider:'vendor',currency:'ccy',
 periodStart:'start',periodEnd:'end',model:'model',metric:'metric',
 quantity:'qty',amountMinor:'amount'};
const csv=[
 'id,vendor,ccy,start,end,model,metric,qty,amount',
 'invoice-1,tts-vendor,USD,2026-11-01T00:00:00Z,2026-11-02T00:00:00Z,voice-v1,pcm_bytes,9600,12',
 'invoice-1,tts-vendor,USD,2026-11-01T00:00:00Z,2026-11-02T00:00:00Z,voice-v1,characters,2500,8'
].join('\r\n');
test('R23 mapped CSV imports multiple line items into one normalized statement',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 const importer=new ProviderBillingCsvImporter({store});
 const result=importer.importCsv({csv,mapping});
 assert.equal(result.imported,true);assert.equal(result.rowsImported,2);
 assert.equal(result.source,'normalized-csv-mapping');
 assert.equal(store.list().length,1);
 assert.equal(store.list()[0].items.length,2);
 assert.equal(store.list()[0].items[0].quantity,9600);
 assert.equal(PROVIDER_BILLING_CSV_FIELDS.length,9);
}));
test('R23 CSV re-import is idempotent and never persists raw source content',()=>fixture(file=>{
 const store=new ProviderBillingStatementStore({file});
 const importer=new ProviderBillingCsvImporter({store});
 importer.importCsv({csv,mapping});
 assert.equal(importer.importCsv({csv,mapping}).duplicate,true);
 const raw=readFileSync(file,'utf8');
 assert.ok(!raw.includes('id,vendor,ccy'));
 assert.ok(!raw.includes('qty,amount'));
}));
test('R23 rejects malformed quoting, duplicate headers and missing mapped columns',()=>fixture(file=>{
 const importer=new ProviderBillingCsvImporter({store:new ProviderBillingStatementStore({file})});
 assert.throws(()=>importer.importCsv({csv:'a,b\n"bad,x',mapping}),
  /INVALID_PROVIDER_BILLING_CSV/);
 assert.throws(()=>importer.importCsv({csv:'id,id\na,b',mapping}),
  /INVALID_PROVIDER_BILLING_CSV_HEADERS/);
 assert.throws(()=>importer.importCsv({csv,mapping:{...mapping,model:'missing'}}),
  /INVALID_PROVIDER_BILLING_CSV_MAPPING/);
}));
test('R23 rejects blank numeric values and repeated column mappings',()=>fixture(file=>{
 const importer=new ProviderBillingCsvImporter({store:new ProviderBillingStatementStore({file})});
 const blank=csv.replace(',9600,12',',,12');
 assert.throws(()=>importer.importCsv({csv:blank,mapping}),
  /INVALID_PROVIDER_BILLING_CSV_VALUE/);
 const hex=csv.replace(',9600,12',',0x2580,12');
 assert.throws(()=>importer.importCsv({csv:hex,mapping}),
  /INVALID_PROVIDER_BILLING_CSV_VALUE/);
 assert.throws(()=>importer.importCsv({csv,mapping:{...mapping,model:'metric'}}),
  /INVALID_PROVIDER_BILLING_CSV_MAPPING/);
}));
test('R23 refuses mixed statement IDs or periods in one CSV import',()=>fixture(file=>{
 const importer=new ProviderBillingCsvImporter({store:new ProviderBillingStatementStore({file})});
 const mixed=csv.replace('invoice-1,tts-vendor,USD,2026-11-01',
  'invoice-2,tts-vendor,USD,2026-11-01');
 assert.throws(()=>importer.importCsv({csv:mixed,mapping}),
  /PROVIDER_BILLING_CSV_MULTIPLE_STATEMENTS/);
 assert.equal(importer.store.list().length,0);
}));
test('R23 enforces input, row and field bounds',()=>fixture(file=>{
 const importer=new ProviderBillingCsvImporter({store:new ProviderBillingStatementStore({file})});
 assert.throws(()=>importer.importCsv({csv:'x'.repeat(1024*1024+1),mapping}),
  /INVALID_PROVIDER_BILLING_CSV/);
 assert.throws(()=>importer.importCsv({csv:'a,b\n'+ 'x'.repeat(5000)+',y',mapping}),
  /PROVIDER_BILLING_CSV_FIELD_LIMIT|INVALID_PROVIDER_BILLING_CSV_MAPPING/);
}));
