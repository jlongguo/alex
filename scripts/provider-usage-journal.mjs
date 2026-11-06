// R20 append-only supplier-request usage journal.
// Deliberately excludes text, audio, credentials and learner identifiers.
// This measures provider response PCM, NOT a supplier invoice or charge.
import {appendFileSync,readFileSync,openSync,closeSync,fsyncSync,mkdirSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_FILE=20*1024*1024,MAX_EVENTS=200000;
const safeCode=value=>typeof value==='string'&&/^[A-Z0-9_]{1,80}$/.test(value)
 ?value:'PROVIDER_ERROR';
function validEvent(e){
 if(!e||e.version!==1||typeof e.id!=='string'
  ||!/^[0-9a-f-]{36}$/.test(e.id)
  ||!['open','frame','finish'].includes(e.event)
  ||!Number.isSafeInteger(e.at)||e.at<0)return false;
 if(e.event==='open')return typeof e.provider==='string'
  &&e.provider.length<=80&&typeof e.model==='string'&&e.model.length<=120;
 if(e.event==='frame')return Number.isSafeInteger(e.bytes)&&e.bytes>=2
  &&e.bytes<=4800&&e.bytes%2===0;
 return ['completed','cancelled','failed'].includes(e.outcome)
  &&(e.errorCode===null||safeCode(e.errorCode));
}
export class ProviderUsageJournal{
 #requests=new Map();
 constructor({file,now=()=>Date.now(),makeId=randomUUID}={}){
  if(typeof file!=='string'||!file||typeof now!=='function'
   ||typeof makeId!=='function')throw Error('INVALID_PROVIDER_USAGE_CONFIG');
  this.file=resolve(file);this.now=now;this.makeId=makeId;
  this.#load();
 }
 #load(){
  let raw;
  try{raw=readFileSync(this.file,'utf8');}
  catch(error){if(error?.code==='ENOENT')return;throw Error('PROVIDER_USAGE_JOURNAL_INVALID');}
  if(Buffer.byteLength(raw)>MAX_FILE)throw Error('PROVIDER_USAGE_JOURNAL_INVALID');
  const lines=raw.split('\n').filter(Boolean);
  if(lines.length>MAX_EVENTS)throw Error('PROVIDER_USAGE_JOURNAL_INVALID');
  for(const line of lines){
   let e;try{e=JSON.parse(line);}catch{throw Error('PROVIDER_USAGE_JOURNAL_INVALID');}
   if(!validEvent(e))throw Error('PROVIDER_USAGE_JOURNAL_INVALID');
   this.#apply(e);
  }
 }
 #apply(e){
  let row=this.#requests.get(e.id);
  if(e.event==='open'){
   row={id:e.id,provider:e.provider,model:e.model,startedAt:e.at,
    lastAt:e.at,finishedAt:null,outcome:'inflight',responseBytes:0,
    frames:0,errorCode:null};
   this.#requests.set(e.id,row);return;
  }
  if(!row||row.finishedAt!==null||e.at<row.lastAt)
   throw Error('PROVIDER_USAGE_JOURNAL_INVALID');
  row.lastAt=e.at;
  if(e.event==='frame'){row.responseBytes+=e.bytes;row.frames++;return;}
  row.finishedAt=e.at;row.outcome=e.outcome;row.errorCode=e.errorCode;
 }
 #append(event){
  if(!validEvent(event))throw Error('INVALID_PROVIDER_USAGE_EVENT');
  const current=this.#requests.get(event.id);
  if(event.event==='open'){
   if(current)throw Error('PROVIDER_USAGE_JOURNAL_INVALID');
  }else if(!current||current.finishedAt!==null||event.at<current.lastAt){
   throw Error('PROVIDER_USAGE_JOURNAL_INVALID');
  }
  if(this.#requests.size>=MAX_EVENTS)throw Error('PROVIDER_USAGE_JOURNAL_FULL');
  mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
  const line=JSON.stringify(event)+'\n';
  let size=0;try{size=statSync(this.file).size;}catch(error){
   if(error?.code!=='ENOENT')throw Error('PROVIDER_USAGE_JOURNAL_WRITE_FAILED');
  }
  if(size+Buffer.byteLength(line)>MAX_FILE)throw Error('PROVIDER_USAGE_JOURNAL_FULL');
  try{
   appendFileSync(this.file,line,{encoding:'utf8',mode:0o600,flag:'a'});
   const fd=openSync(this.file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  }catch{throw Error('PROVIDER_USAGE_JOURNAL_WRITE_FAILED');}
  this.#apply(event);
 }
 begin({provider,model}={}){
  if(typeof provider!=='string'||!provider||provider.length>80
   ||typeof model!=='string'||!model||model.length>120)
   throw Error('INVALID_PROVIDER_USAGE_METADATA');
  const id=this.makeId();
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)||this.#requests.has(id))
   throw Error('INVALID_PROVIDER_USAGE_ID');
  this.#append({version:1,id,event:'open',at:this.now(),provider,model});
  return id;
 }
 frame(id,bytes){
  if(!Number.isSafeInteger(bytes)||bytes<2||bytes>4800||bytes%2)
   throw Error('INVALID_PROVIDER_USAGE_FRAME');
  this.#append({version:1,id,event:'frame',at:this.now(),bytes});
 }
 finish(id,outcome,errorCode=null){
  if(!['completed','cancelled','failed'].includes(outcome))
   throw Error('INVALID_PROVIDER_USAGE_OUTCOME');
  const row=this.#requests.get(id);
  if(!row||row.finishedAt!==null)return false;
  this.#append({version:1,id,event:'finish',at:this.now(),outcome,
   errorCode:outcome==='failed'?safeCode(errorCode):null});
  return true;
 }
 summary(){
  const result={requests:0,completed:0,cancelled:0,failed:0,inflight:0,
   responseBytes:0,responseSamples:0,frames:0,providers:[]};
  const providers=new Map();
  for(const row of this.#requests.values()){
   result.requests++;result[row.outcome]++;
   result.responseBytes+=row.responseBytes;
   result.responseSamples+=row.responseBytes/2;result.frames+=row.frames;
   const key=row.provider+'/'+row.model;
   const p=providers.get(key)??{provider:row.provider,model:row.model,
    requests:0,responseBytes:0,frames:0};
   p.requests++;p.responseBytes+=row.responseBytes;p.frames+=row.frames;
   providers.set(key,p);
  }
  result.providers=[...providers.values()];
  result.measurement='provider-response-pcm-not-invoice';
  result.persistence='append-only-local-journal';
  return result;
 }
}
export class MeteredStreamingSpeechProvider{
 constructor({provider,journal}={}){
  if(typeof provider?.open!=='function'||typeof journal?.begin!=='function')
   throw Error('INVALID_METERED_SPEECH_PROVIDER');
  this.provider=provider;this.journal=journal;
  this.kind=provider.kind??'speech-provider';
  this.model=provider.model??'unknown';
 }
 async open(args={}){
  const id=this.journal.begin({provider:this.kind,model:this.model});
  let source;
  try{source=await this.provider.open(args);}
  catch(error){
   this.journal.finish(id,'failed',error?.message);
   throw error;
  }
  if(typeof source?.read!=='function'||typeof source?.close!=='function'){
   try{await source?.close?.();}catch{}
   this.journal.finish(id,'failed','INVALID_PROVIDER_SOURCE');
   throw Error('INVALID_PROVIDER_SOURCE');
  }
  let closed=false;
  const finish=(outcome,error)=>{if(closed)return false;
   const result=this.journal.finish(id,outcome,error);closed=true;return result;};
  return {
   format:source.format,
   read:async()=>{
    try{
     const block=await source.read();
     if(block?.done){finish('completed');return block;}
     if(Buffer.isBuffer(block?.pcm))this.journal.frame(id,block.pcm.length);
     return block;
    }catch(error){finish('failed',error?.message);throw error;}
   },
   close:async()=>{
    try{await source.close();}finally{finish('cancelled');}
   },
   stats:()=>source.stats?.()??null
  };
 }
}
