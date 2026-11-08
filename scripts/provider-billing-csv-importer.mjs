import {createHash} from 'node:crypto';
// R23 bounded RFC4180-style CSV adapter for one normalized supplier statement.
// Column mappings are explicit; vendor semantics are never inferred from header names.
const MAX_CSV_CHARS=1024*1024,MAX_ROWS=5001,MAX_COLUMNS=64,MAX_FIELD=4096;
const FIELDS=['statementId','provider','currency','periodStart','periodEnd',
 'model','metric','quantity','amountMinor'];
function parseCsv(source){
 if(typeof source!=='string'||!source.length||source.length>MAX_CSV_CHARS
  ||source.includes('\0'))throw Error('INVALID_PROVIDER_BILLING_CSV');
 const input=source.charCodeAt(0)===0xfeff?source.slice(1):source;
 const rows=[];let row=[],field='',quoted=false,afterQuote=false;
 const pushField=()=>{row.push(field);field='';afterQuote=false;};
 const pushRow=()=>{
  pushField();
  if(row.some(value=>value.trim()!==''))rows.push(row);
  row=[];
  if(rows.length>MAX_ROWS)throw Error('PROVIDER_BILLING_CSV_TOO_MANY_ROWS');
 };
 for(let i=0;i<input.length;i++){
  const ch=input[i];
  if(quoted){
   if(ch==='"'){
    if(input[i+1]==='"'){field+='"';i++;}
    else{quoted=false;afterQuote=true;}
   }else field+=ch;
  }else if(afterQuote){
   if(ch===',')pushField();
   else if(ch==='\n')pushRow();
   else if(ch==='\r'){if(input[i+1]==='\n')i++;pushRow();}
   else throw Error('INVALID_PROVIDER_BILLING_CSV');
  }else if(ch==='"'){
   if(field.length)throw Error('INVALID_PROVIDER_BILLING_CSV');
   quoted=true;
  }else if(ch===',')pushField();
  else if(ch==='\n')pushRow();
  else if(ch==='\r'){if(input[i+1]==='\n')i++;pushRow();}
  else field+=ch;
  if(field.length>MAX_FIELD||row.length>MAX_COLUMNS)
   throw Error('PROVIDER_BILLING_CSV_FIELD_LIMIT');
 }
 if(quoted)throw Error('INVALID_PROVIDER_BILLING_CSV');
 if(field.length||row.length||afterQuote)pushRow();
 if(rows.length<2)throw Error('PROVIDER_BILLING_CSV_EMPTY');
 if(rows[0].length>MAX_COLUMNS)throw Error('PROVIDER_BILLING_CSV_FIELD_LIMIT');
 const headers=rows[0].map(x=>x.trim());
 if(headers.some(x=>!x)||new Set(headers).size!==headers.length)
  throw Error('INVALID_PROVIDER_BILLING_CSV_HEADERS');
 for(const data of rows.slice(1))
  if(data.length!==headers.length)throw Error('INVALID_PROVIDER_BILLING_CSV_ROW');
 return {headers,rows:rows.slice(1)};
}
export class ProviderBillingCsvImporter{
 constructor({store}={}){
  if(typeof store?.importStatement!=='function')
   throw Error('INVALID_PROVIDER_BILLING_CSV_IMPORTER');
  this.store=store;
 }
 importCsv({csv,mapping}={}){
  const parsed=parseCsv(csv);
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)
   ||FIELDS.some(field=>typeof mapping[field]!=='string'||!mapping[field]))
   throw Error('INVALID_PROVIDER_BILLING_CSV_MAPPING');
  const indices={};
  for(const field of FIELDS){
   const index=parsed.headers.indexOf(mapping[field]);
   if(index<0)throw Error('INVALID_PROVIDER_BILLING_CSV_MAPPING');
   indices[field]=index;
  }
  if(new Set(Object.values(mapping)).size!==FIELDS.length)
   throw Error('INVALID_PROVIDER_BILLING_CSV_MAPPING');
  const rows=parsed.rows.map(values=>{
   const value=field=>values[indices[field]].trim();
   const rawQuantity=value('quantity'),rawAmount=value('amountMinor');
   if(!/^\d+(?:\.\d+)?$/.test(rawQuantity)
    ||!/^\d+$/.test(rawAmount))throw Error('INVALID_PROVIDER_BILLING_CSV_VALUE');
   const quantity=Number(rawQuantity),amountMinor=Number(rawAmount);
   if(!Number.isFinite(quantity)||!Number.isSafeInteger(amountMinor))
    throw Error('INVALID_PROVIDER_BILLING_CSV_VALUE');
   return {statementId:value('statementId'),provider:value('provider'),
    currency:value('currency'),periodStart:value('periodStart'),
    periodEnd:value('periodEnd'),model:value('model'),metric:value('metric'),
    quantity,amountMinor};
  });
  const first=rows[0];
  if(rows.some(row=>row.statementId!==first.statementId
   ||row.provider!==first.provider||row.currency!==first.currency
   ||row.periodStart!==first.periodStart||row.periodEnd!==first.periodEnd))
   throw Error('PROVIDER_BILLING_CSV_MULTIPLE_STATEMENTS');
  const statement={schemaVersion:1,statementId:first.statementId,
   provider:first.provider,currency:first.currency,
   periodStart:first.periodStart,periodEnd:first.periodEnd,
   items:rows.map(row=>({model:row.model,metric:row.metric,
    quantity:row.quantity,amountMinor:row.amountMinor}))};
  const result=this.store.importStatement(statement,{provenance:{
   source:'csv',importedAt:new Date().toISOString(),
   sourceDigest:createHash('sha256').update(csv).digest('hex'),
   mappingDigest:createHash('sha256').update(JSON.stringify(
    FIELDS.map(field=>[field,mapping[field]]))).digest('hex')
  }});
  return {...result,rowsImported:rows.length,
   source:'normalized-csv-mapping',rawCsvPersisted:false};
 }
}
export const PROVIDER_BILLING_CSV_FIELDS=Object.freeze([...FIELDS]);
