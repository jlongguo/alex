// R19 single-process, crash-recoverable PCM *delivery reservation* ledger.
// This is NOT supplier billing. Persist BEFORE returning PCM; failed writes
// deny delivery. A canceled HTTP write may leave a conservative reservation.
import {readFileSync,openSync,closeSync,writeSync,fsyncSync,renameSync,
 mkdirSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PCM_SAMPLES_PER_SECOND} from './speech-delivery-budget.mjs';

const DAY_MS=86_400_000;
const validPrincipal=x=>typeof x==='string'&&!!x&&x.length<=100
 &&!/[\x00-\x1f]/.test(x);
const validSamples=x=>Number.isSafeInteger(x)&&x>=1&&x<=2400;
function validateState(data,limit){
 if(!data||data.version!==1||!Array.isArray(data.rows)
   ||data.rows.length>10000)throw Error('SPEECH_LEDGER_INVALID_FILE');
 const entries=new Map();
 for(const row of data.rows){
  if(!Array.isArray(row)||row.length!==3||!validPrincipal(row[0])
   ||!Number.isSafeInteger(row[1])||row[1]<0||row[1]>100000
   ||!Number.isSafeInteger(row[2])||row[2]<0||row[2]>limit
   ||entries.has(row[0]))throw Error('SPEECH_LEDGER_INVALID_FILE');
  entries.set(row[0],{day:row[1],reservedSamples:row[2]});
 }
 return entries;
}
export class DurableSpeechDeliveryBudget{
 #entries=new Map();
 constructor({file,dailySeconds=120,now=()=>Date.now()}={}){
  if(typeof file!=='string'||!file||typeof now!=='function'
   ||!Number.isSafeInteger(dailySeconds)||dailySeconds<1||dailySeconds>86400)
   throw Error('INVALID_SPEECH_LEDGER_CONFIG');
  this.file=resolve(file);this.dailySeconds=dailySeconds;
  this.limit=dailySeconds*PCM_SAMPLES_PER_SECOND;this.now=now;
  try{
   const raw=readFileSync(this.file,'utf8');
   if(raw.length>1_000_000)throw Error('SPEECH_LEDGER_INVALID_FILE');
   this.#entries=validateState(JSON.parse(raw),this.limit);
  }catch(error){
   if(error?.code!=='ENOENT')throw Error('SPEECH_LEDGER_INVALID_FILE');
  }
 }
 #today(){
  const now=this.now();
  if(!Number.isFinite(now)||now<0)throw Error('INVALID_SPEECH_BUDGET_CLOCK');
  return Math.floor(now/DAY_MS);
 }
 #principal(principal){
  if(!validPrincipal(principal))throw Error('INVALID_AUDIO_PRINCIPAL');
  return principal;
 }
 #value(principal){
  this.#principal(principal);
  const day=this.#today();
  const row=this.#entries.get(principal);
  return row?.day===day?row.reservedSamples:0;
 }
 #save(next){
  mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
  const path=this.file+'.'+randomUUID()+'.tmp';
  let fd=null;
  try{
   const payload=JSON.stringify({version:1,rows:[...next].map(
    ([key,row])=>[key,row.day,row.reservedSamples])});
   fd=openSync(path,'wx',0o600);
   writeSync(fd,payload);
   fsyncSync(fd);closeSync(fd);fd=null;
   renameSync(path,this.file);
   // Best effort directory durability on filesystems supporting dir fsync.
   try{const dir=openSync(dirname(this.file),'r');
    try{fsyncSync(dir);}finally{closeSync(dir);}}catch{}
  }catch(error){
   if(fd!==null)try{closeSync(fd);}catch{}
   try{unlinkSync(path);}catch{}
   throw Error('SPEECH_LEDGER_PERSIST_FAILED');
  }
  this.#entries=next;
 }
 check(principal,samples=1){
  if(!validSamples(samples))throw Error('INVALID_SPEECH_BUDGET_SAMPLES');
  if(this.#value(principal)+samples>this.limit)
   throw Error('SPEECH_DAILY_DELIVERY_LIMIT');
  return true;
 }
 consume(principal,samples){
  this.check(principal,samples);
  const day=this.#today();
  const next=new Map(this.#entries);
  next.set(principal,{day,reservedSamples:this.#value(principal)+samples});
  this.#save(next);
  return this.snapshot(principal);
 }
 snapshot(principal){
  const reservedSamples=this.#value(principal),day=this.#today();
  return Object.freeze({
   dayUtc:new Date(day*DAY_MS).toISOString().slice(0,10),
   limitSeconds:this.dailySeconds,
   deliveredSamples:reservedSamples,
   deliveredMs:Math.floor(reservedSamples*1000/PCM_SAMPLES_PER_SECOND),
   remainingSamples:this.limit-reservedSamples,
   remainingMs:Math.floor((this.limit-reservedSamples)*1000/PCM_SAMPLES_PER_SECOND),
   measurement:'alex-reserved-for-delivery-not-vendor-billed',
   persistence:'single-process-durable'
  });
 }
 erasePrincipal(principal){
  this.#principal(principal);
  if(!this.#entries.has(principal))return false;
  const next=new Map(this.#entries);next.delete(principal);
  this.#save(next);return true;
 }
 eraseScope(scope){
  if(!['parent','child','all'].includes(scope))
   throw Error('INVALID_AUDIO_ERASE_SCOPE');
  const next=new Map(this.#entries);let removed=0;
  for(const key of next.keys()){
   const child=key==='child'||key.startsWith('learner:');
   if(scope==='all'||(scope==='child'&&child)
      ||(scope==='parent'&&!child)){next.delete(key);removed++;}
  }
  if(removed)this.#save(next);
  return removed;
 }
 sweep(){
  const day=this.#today(),next=new Map(this.#entries);
  for(const [key,value] of next)if(value.day!==day)next.delete(key);
  if(next.size!==this.#entries.size)this.#save(next);
  return next.size;
 }
}
