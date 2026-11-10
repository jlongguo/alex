// R37 durable, metadata-only approval + install transaction coordinator.
// WAL saves intent before any registry change; restart reconciles by observed versions.
// Single local process only. Never loads third-party code or issues device commands.
import {createHash} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {canonicalJson} from './skill-package-trust.mjs';

const fail=code=>{throw Error(code);};
const digest=x=>createHash('sha256').update(canonicalJson(x)).digest('hex');
const opId=x=>typeof x==='string'&&/^[a-zA-Z0-9._:-]{8,100}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const version=x=>x===null||typeof x==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(x);
const validIntent=i=>!!i&&Object.keys(i).sort().join(',')===
 'artifactSha256,expectedCurrentVersion,id,manifestSha256,operationId,publisherId,version'&&
 opId(i.operationId)&&typeof i.id==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(i.id)&&
 version(i.version)&&i.version!==null&&version(i.expectedCurrentVersion)&&
 hex(i.manifestSha256)&&hex(i.artifactSha256)&&
 typeof i.publisherId==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(i.publisherId);
const hashRecord=r=>digest({seq:r.seq,phase:r.phase,intent:r.intent,
 requestHash:r.requestHash,prevHash:r.prevHash});
function validate(state){
 if(!state||state.schemaVersion!==1||!Array.isArray(state.records)||
  Object.keys(state).sort().join(',')!=='records,schemaVersion'||state.records.length>400)
  fail('INVALID_SKILL_TRANSACTION_STATE');
 let prev='0'.repeat(64);
 const ids=new Set();
 for(const r of state.records){
  if(!r||Object.keys(r).sort().join(',')!=='hash,intent,phase,prevHash,requestHash,seq'||
   !validIntent(r.intent)||!['prepared','committed','blocked'].includes(r.phase)||
   r.seq!==ids.size+1||ids.has(r.intent.operationId)||r.prevHash!==prev||
   r.requestHash!==digest(r.intent)||r.hash!==hashRecord(r))
   fail('INVALID_SKILL_TRANSACTION_STATE');
  prev=r.hash;ids.add(r.intent.operationId);
 }
}
export class SkillPackageTransactions {
 #state={schemaVersion:1,records:[]};
 #queue=Promise.resolve();
 constructor({file,registry,trust}={}){
  if(typeof file!=='string'||!file||!registry||!trust)fail('INVALID_SKILL_TRANSACTION_CONFIG');
  this.store=new JsonStateStore(file);this.registry=registry;this.trust=trust;
  registry.setTransactionGuard?.(({action,target,operationId})=>{
   const pending=this.#state.records.find(r=>r.phase==='prepared');
   if(!pending)return;
   if(operationId!==pending.intent.operationId||
      !['review','install'].includes(action)||
      target!==pending.intent.id+'@'+pending.intent.version)
    fail('SKILL_TRANSACTION_ISOLATED');
  });
 }
 async load(){
  const state=await this.store.load();
  if(!state)return;
  validate(state);this.#state=structuredClone(state);
 }
 list(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return structuredClone(this.#state);
 }
 #serialize(fn){
  const result=this.#queue.catch(()=>{}).then(fn);
  this.#queue=result.catch(()=>{});
  return result;
 }
 async #save(next){
  validate(next);await this.store.save(next);this.#state=next;
 }
 #findPackage(intent){
  const p=this.registry.list('parent').packages.find(p=>
   p.manifest.id===intent.id&&p.manifest.version===intent.version);
  if(!p)fail('UNKNOWN_SKILL_PACKAGE');
  const evidence=this.trust.assertTrusted(p.manifest);
  if(evidence.manifestSha256!==intent.manifestSha256||
   evidence.artifactSha256!==intent.artifactSha256||
   evidence.publisherId!==intent.publisherId)
   fail('SKILL_TRANSACTION_EVIDENCE_DRIFT');
  return p;
 }
 #preview(intent){
  const p=this.registry.preview('parent',{id:intent.id,version:intent.version,
   expectedCurrentVersion:intent.expectedCurrentVersion});
  const blockers=p.blockers.filter(b=>b!=='SKILL_NOT_APPROVED');
  if(blockers.length)fail(blockers[0]);
  return p;
 }
 // A parent-issued request binds exactly one manifest digest, artifact digest and CAS pin.
 // Pending packages can be approved by this transaction, then installed.
 apply(actor,{operationId,id,version,expectedCurrentVersion=null}={}){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#serialize(async()=>{
   if(!opId(operationId)||typeof id!=='string'||!versionRegex(version)||!versionRegex(expectedCurrentVersion,true))
    fail('INVALID_SKILL_TRANSACTION_INTENT');
   const registered=this.registry.list('parent').packages.find(p=>
    p.manifest.id===id&&p.manifest.version===version);
   if(!registered)fail('UNKNOWN_SKILL_PACKAGE');
   const proof=this.trust.assertTrusted(registered.manifest);
   const intent={operationId,id,version,expectedCurrentVersion,
    publisherId:proof.publisherId,manifestSha256:proof.manifestSha256,
    artifactSha256:proof.artifactSha256};
   const existing=this.#state.records.find(r=>r.intent.operationId===operationId);
   if(existing){
    if(existing.requestHash!==digest(intent))fail('SKILL_TRANSACTION_IDEMPOTENCY_CONFLICT');
    return this.#resume(existing);
   }
   if(this.#state.records.some(r=>r.phase==='prepared'))
    fail('SKILL_TRANSACTION_PENDING_RECOVERY');
   const candidate=this.#preview(intent);
   if(candidate.currentVersion===version)fail('SKILL_TRANSACTION_ALREADY_INSTALLED');
   if(candidate.change==='rollback')fail('SKILL_ROLLBACK_REQUIRES_REVIEW');
   if(registered.status!=='pending'&&registered.status!=='approved')
    fail('SKILL_NOT_APPROVED');
   const next=structuredClone(this.#state);
   if(next.records.length>=400)fail('SKILL_TRANSACTION_LIMIT');
   const record={seq:next.records.length+1,intent,phase:'prepared',
    requestHash:digest(intent),prevHash:next.records.at(-1)?.hash??'0'.repeat(64)};
   next.records.push({...record,hash:hashRecord(record)});
   await this.#save(next); // critical: durable intent before registry writes
   return this.#resume(record);
  });
 }
 async #resume(record){
  return this.registry.withinTransaction(record.intent.operationId,async()=>{
  let current=this.#state.records.find(r=>r.intent.operationId===record.intent.operationId);
  if(current.phase==='committed')return {operationId:current.intent.operationId,
   status:'committed',id:current.intent.id,version:current.intent.version,executable:false};
  if(current.phase==='blocked')fail('SKILL_TRANSACTION_REQUIRES_REVIEW');
  const intent=current.intent;
  // Re-check approval provenance and pins on every recovery attempt.
  const p=this.#findPackage(intent);
  const state=this.registry.list('parent');
  const installed=state.installed.find(i=>i.id===intent.id);
  if(installed?.version!==intent.version){
   this.#preview(intent);
   if(p.status==='pending')
    await this.registry.review('parent',{id:intent.id,version:intent.version,decision:'approve'});
   // Idempotence: on restart already-approved versions skip the review step.
   await this.registry.install('parent',{id:intent.id,version:intent.version,
    expectedCurrentVersion:intent.expectedCurrentVersion});
  }
  // Writes committed marker only after observing the desired installed pin.
  const verified=this.registry.list('parent').installed.some(i=>
   i.id===intent.id&&i.version===intent.version);
  if(!verified)fail('SKILL_TRANSACTION_NOT_COMMITTED');
  const next=structuredClone(this.#state);
  current=next.records.find(r=>r.intent.operationId===intent.operationId);
  current.phase='committed';
  // Re-hash entire chain, preserving the proof-bound immutable intent.
  let prev='0'.repeat(64);
  for(const row of next.records){row.prevHash=prev;row.hash=hashRecord(row);prev=row.hash;}
  await this.#save(next);
  return {operationId:intent.operationId,status:'committed',id:intent.id,
   version:intent.version,executable:false};
  });
 }
 // Parent may abandon only an untouched prepared intent. Partial approvals must be
 // recovered or manually investigated; the coordinator never silently rolls them back.
 abandon(actor,{operationId}={}){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#serialize(async()=>{
   const rec=this.#state.records.find(r=>r.intent.operationId===operationId);
   if(!rec||rec.phase!=='prepared')fail('SKILL_TRANSACTION_NOT_PENDING');
   const state=this.registry.list('parent');
   const pkg=state.packages.find(p=>p.manifest.id===rec.intent.id&&
     p.manifest.version===rec.intent.version);
   const current=state.installed.find(i=>i.id===rec.intent.id)?.version??null;
   if(!pkg||pkg.status!=='pending'||current!==rec.intent.expectedCurrentVersion)
    fail('SKILL_TRANSACTION_PARTIAL_EFFECTS');
   const next=structuredClone(this.#state);
   next.records.find(r=>r.intent.operationId===operationId).phase='blocked';
   let prev='0'.repeat(64);
   for(const item of next.records){item.prevHash=prev;item.hash=hashRecord(item);prev=item.hash;}
   await this.#save(next);
   return {operationId,status:'abandoned',executable:false};
  });
 }
 readiness(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  const pending=this.#state.records.filter(r=>r.phase==='prepared');
  return {pending:pending.map(r=>({operationId:r.intent.operationId,
    id:r.intent.id,version:r.intent.version,
    installed:this.registry.list('parent').installed.find(i=>i.id===r.intent.id)?.version??null,
    expectedCurrentVersion:r.intent.expectedCurrentVersion})),
    retained:this.#state.records.length,capacity:400,
    remaining:400-this.#state.records.length,
    archival:'no unsafe automatic pruning; export or migration required at capacity'};
 }
 recover(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#serialize(async()=>{
   const reports=[];
   for(const rec of this.#state.records.filter(r=>r.phase==='prepared')){
    try{reports.push(await this.#resume(rec));}
    catch(e){reports.push({operationId:rec.intent.operationId,
      status:'needs-review',error:e.message});}
   }
   return {reports,pending:this.#state.records.filter(r=>r.phase==='prepared').length};
  });
 }
}
const versionRegex=(value,nullable=false)=>nullable&&value===null||
 typeof value==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
