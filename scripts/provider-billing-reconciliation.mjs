// R21 provider invoice/usage statement importer and conservative reconciliation.
// Vendor-specific API adapters are intentionally out of scope until a vendor is selected.
import {appendFileSync,readFileSync,openSync,closeSync,fsyncSync,mkdirSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const MAX_FILE=20*1024*1024,MAX_STATEMENTS=10000,MAX_ITEMS=5000;
const METRICS=new Set(['request_count','pcm_bytes','audio_seconds',
 'characters','input_tokens','output_tokens']);
const validText=(v,max=120)=>typeof v==='string'&&v.length>0&&v.length<=max
 &&!/[\x00-\x1f\x7f]/.test(v);
const parseTime=value=>{
 if(typeof value!=='string'||!/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)$/.test(value))
  return null;
 const n=Date.parse(value);
 if(!Number.isSafeInteger(n)||new Date(n).toISOString().slice(0,19)!==value.slice(0,19))return null;
 return n;
};
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalize(input){
 if(!input||input.schemaVersion!==1||!validText(input.statementId,160)
  ||!validText(input.provider,80)||! /^[A-Z]{3}$/.test(input.currency??'')
  ||!Array.isArray(input.items)||input.items.length<1||input.items.length>MAX_ITEMS)
  throw Error('INVALID_PROVIDER_BILLING_STATEMENT');
 const from=parseTime(input.periodStart),to=parseTime(input.periodEnd);
 if(from===null||to===null||to<=from)throw Error('INVALID_PROVIDER_BILLING_PERIOD');
 const items=input.items.map(item=>{
  if(!item||!validText(item.model)||!METRICS.has(item.metric)
   ||typeof item.quantity!=='number'||!Number.isFinite(item.quantity)
   ||item.quantity<0||item.quantity>1e15
   ||(['request_count','pcm_bytes'].includes(item.metric)&&!Number.isSafeInteger(item.quantity))
   ||!Number.isSafeInteger(item.amountMinor)||item.amountMinor<0)
   throw Error('INVALID_PROVIDER_BILLING_ITEM');
  return {model:item.model,metric:item.metric,quantity:item.quantity,
   amountMinor:item.amountMinor};
 });
 const normalized={schemaVersion:1,statementId:input.statementId,
  provider:input.provider,currency:input.currency,
  periodStart:new Date(from).toISOString(),periodEnd:new Date(to).toISOString(),
  items};
 return {...normalized,fingerprint:fingerprint(normalized)};
}
export class ProviderBillingStatementStore{
 #statements=new Map();
 constructor({file}={}){
  if(typeof file!=='string'||!file)throw Error('INVALID_PROVIDER_BILLING_CONFIG');
  this.file=resolve(file);this.#load();
 }
 #load(){
  let raw;try{raw=readFileSync(this.file,'utf8');}
  catch(error){if(error?.code==='ENOENT')return;throw Error('PROVIDER_BILLING_STORE_INVALID');}
  if(Buffer.byteLength(raw)>MAX_FILE)throw Error('PROVIDER_BILLING_STORE_INVALID');
  const lines=raw.split('\n').filter(Boolean);
  if(lines.length>MAX_STATEMENTS)throw Error('PROVIDER_BILLING_STORE_INVALID');
  for(const line of lines){
   let stored;try{stored=JSON.parse(line);}catch{throw Error('PROVIDER_BILLING_STORE_INVALID');}
   const normalized=normalize(stored);
   if(normalized.fingerprint!==stored.fingerprint
    ||this.#statements.has(normalized.statementId))
    throw Error('PROVIDER_BILLING_STORE_INVALID');
   this.#statements.set(normalized.statementId,normalized);
  }
 }
 importStatement(input){
  const statement=normalize(input),existing=this.#statements.get(statement.statementId);
  if(existing){
   if(existing.fingerprint!==statement.fingerprint)
    throw Error('PROVIDER_BILLING_STATEMENT_ID_CONFLICT');
   return {imported:false,duplicate:true,statementId:statement.statementId};
  }
  if(this.#statements.size>=MAX_STATEMENTS)throw Error('PROVIDER_BILLING_STORE_FULL');
  mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
  const line=JSON.stringify(statement)+'\n';
  let size=0;try{size=statSync(this.file).size;}catch(error){
   if(error?.code!=='ENOENT')throw Error('PROVIDER_BILLING_STORE_WRITE_FAILED');
  }
  if(size+Buffer.byteLength(line)>MAX_FILE)throw Error('PROVIDER_BILLING_STORE_FULL');
  try{
   appendFileSync(this.file,line,{encoding:'utf8',mode:0o600,flag:'a'});
   const fd=openSync(this.file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  }catch{throw Error('PROVIDER_BILLING_STORE_WRITE_FAILED');}
  this.#statements.set(statement.statementId,statement);
  return {imported:true,duplicate:false,statementId:statement.statementId};
 }
 list(){return [...this.#statements.values()].map(({fingerprint,...s})=>s);}
}
export class ProviderBillingReconciler{
 constructor({statements,journal}={}){
  if(typeof statements?.list!=='function'
   ||typeof journal?.usageForPeriod!=='function')
   throw Error('INVALID_PROVIDER_BILLING_RECONCILER');
  this.statements=statements;this.journal=journal;
 }
 report(){
  return this.statements.list().map(statement=>{
   const from=Date.parse(statement.periodStart),to=Date.parse(statement.periodEnd);
   const items=statement.items.map(item=>{
    if(item.metric!=='pcm_bytes')
     return {...item,status:'not_comparable',localQuantity:null,
      variance:null,reason:item.metric==='request_count'
       ?'R20 counts request attempts; supplier billable-request semantics are not established'
       :'R20 does not measure this billing unit'};
    const local=this.journal.usageForPeriod({provider:statement.provider,
     model:item.model,from,to});
    const localQuantity=local.responseBytes;
    return {...item,status:'comparable',localQuantity,
     variance:localQuantity-item.quantity,
     localOutcomeCounts:{completed:local.completed,cancelled:local.cancelled,
      failed:local.failed,inflight:local.inflight}};
   });
   return {statementId:statement.statementId,provider:statement.provider,
    currency:statement.currency,periodStart:statement.periodStart,
    periodEnd:statement.periodEnd,items,
    accountingBoundary:'local-telemetry-versus-vendor-statement',
    note:'Variance is a quantity difference only; it is not a monetary credit or proof of vendor billing error.'};
  });
 }
}
