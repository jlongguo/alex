import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const css=readFileSync(resolve(root,'public/styles.css'),'utf8');
test('R22 supplier billing controls live inside the parent-private family workspace',()=>{
 const start=html.indexOf('<div id="family-private"');
 const end=html.indexOf('</div>\n      </section>',start);
 const family=html.slice(start,end);
 assert.ok(start>=0&&end>start);
 for(const id of ['provider-billing-refresh','provider-billing-status',
  'provider-billing-summary','provider-billing-import-form',
  'provider-billing-json','provider-billing-reports','provider-billing-statements',
  'provider-billing-csv-form','provider-billing-csv','provider-billing-csv-mapping'])
  assert.ok(family.includes('id="'+id+'"'),id);
});
test('R22 console fetches parent-only provider and statement endpoints without exposing credentials',()=>{
 assert.match(app,/fetch\('\/api\/audio\/provider-usage'/);
 assert.match(app,/fetch\('\/api\/audio\/provider-billing\/statements'/);
 assert.match(app,/fetch\('\/api\/audio\/provider-billing\/reconciliation'/);
 assert.match(app,/api\('\/api\/audio\/provider-billing\/csv'/);
 assert.match(app,/authorizedActor!=='parent'/);
 assert.match(app,/JSON\.parse\(\$\('provider-billing-json'\)\.value\)/);
 assert.ok(!app.includes('ALEX_SPEECH_STREAM_API_KEY'));
});
test('R22 dynamic supplier content is escaped and responsive styles are present',()=>{
 assert.ok(app.includes('esc(statement.provider)'));
 assert.ok(app.includes('esc(statement.provenance.source)'));
 assert.ok(app.includes('statement.provenance.sourceDigest.slice(0,12)'));
 assert.ok(app.includes('esc(item.model)'));
 assert.ok(css.includes('.provider-billing-summary'));
 assert.ok(css.includes('@media(max-width:760px)'));
});
