// R40 single-host durable multi-package metadata WAL.
// Separate from R37 single-package WAL. All writes are guarded, one registry snapshot only.
// The journal is not a distributed transaction, nor an executable artifact installer.
import {createHash} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {canonicalJson} from './skill-package-trust.mjs';
import {planAtomicSkillUpgrade} from './skill-upgrade-planner.mjs';

const fail=code=>{throw Error(code);};
const sha=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const opId=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{8,100}$/.test(value);
const validPin=p=>p&&Object.keys(p).sort().join(',')==='id,version'&&
 typeof p.id==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(p.id)&&
 typeof p.version==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(p.version);
const uniquePins=p=>Array.isArray(p)&&p.every(validPin)&&
 new Set(p.map(x=>x.id)).size===p.length;
const samePins=(x,y)=>x.length===y.length&&
 x.every(a=>y.some(b=>b.id===a.id&&b.version===a.version));
const recordHash=r=>sha({seq:r.seq,phase:r.phase,operationId:r.operationId,
 requestHash:r.requestHash,targets:r.targets,expectedPins:r.expectedPins,
 proofs:r.proofs,baseline:r.baseline,prevHash:r.prevHash});
function validate(state){
 if(!state||state.schemaVersion!==1||Object.keys(state).sort().join(',')!=='records,schemaVersion'||
  !Array.isArray(state.records)||state.records.length>400)fail('INVALID_SKILL_BATCH_WAL');
 let prev='0'.repeat(64),seq=0;const ids=new Set();
 for(const r of state.records){
  if(!r||Object.keys(r).sort().join(',')!==
   'baseline,expectedPins,hash,operationId,phase,prevHash,proofs,requestHash,seq,targets'||
   !opId(r.operationId)||ids.has(r.operationId)||
   !['prepared','committed','abandoned'].includes(r.phase)||
   !uniquePins(r.targets)||r.targets.length<1||r.targets.length>12||
   !uniquePins(r.expectedPins)||r.expectedPins.length>100||
   !Array.isArray(r.proofs)||r.proofs.length!==r.targets.length||
   r.proofs.some(p=>!p||Object.keys(p).sort().join(',')!==
    'artifactSha256,id,manifestSha256,publisherId,version'||
    !validPin({id:p.id,version:p.version})||!hex(p.artifactSha256)||
    !hex(p.manifestSha256)||typeof p.publisherId!=='string')||
   !r.baseline||Object.keys(r.baseline).sort().join(',')!==
    'historyHash,historyLength,snapshotHash'||
   !Number.isSafeInteger(r.baseline.historyLength)||r.baseline.historyLength<0||
   !hex(r.baseline.historyHash)||!hex(r.baseline.snapshotHash)||
   !hex(r.requestHash)||r.requestHash!==sha({targets:r.targets,expectedPins:r.expectedPins})||
   !hex(r.prevHash)||r.prevHash!==prev||r.seq!==++seq||
   !hex(r.hash)||r.hash!==recordHash(r))fail('INVALID_SKILL_BATCH_WAL');
  prev=r.hash;ids.add(r.operationId);
 }
}
function rehash(state){
 let previous='0'.repeat(64);
 for(const r of state.records){r.prevHash=previous;r.hash=recordHash(r);previous=r.hash;}
}
// 只读复用正式加载器校验：避免发布预检另造一套不一致的 WAL 协议。\nexport function inspectSkillBatchWalState(value){\n validate(value);\n return {records:value.records.length,pending:value.records.filter(r=>r.phase==='prepared').length};\n}\nexport class SkillBatchTransactions {
 #state={schemaVersion:1,records:[]};
 #queue=Promise.resolve();
 constructor({file,registry,trust}={}){
  if(typeof file!=='string'||!file||!registry||!trust)fail('INVALID_SKILL_BATCH_WAL_CONFIG');
  this.store=new JsonStateStore(file);this.registry=registry;this.trust=trust;
  registry.addTransactionGuard(({action,target,operationId})=>{
   const pending=this.#state.records.find(r=>r.phase==='prepared');
   if(!pending)return;
   if(action!=='batch-install'||operationId!==pending.operationId||
    target!=='batch:'+pending.targets.length)
    fail('SKILL_BATCH_TRANSACTION_ISOLATED');
  });
 }
 async load(){
  const state=await this.store.load();
  if(state){validate(state);this.#state=structuredClone(state);}
 }
 list(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return structuredClone(this.#state);
 }
 #serial(fn){
  const result=this.#queue.catch(()=>{}).then(fn);
  this.#queue=result.catch(()=>{});
  return result;
 }
 async #save(next){
  validate(next);
  await this.store.save(next);
  this.#state=next;
 }
 #verifyProofs(record){
  const catalog=this.registry.list('parent').packages;
  for(const evidence of record.proofs){
   const item=catalog.find(p=>p.manifest.id===evidence.id&&p.manifest.version===evidence.version);
   if(!item||item.status!=='approved')fail('SKILL_NOT_APPROVED');
   const trusted=this.trust.assertTrusted(item.manifest);
   if(trusted.publisherId!==evidence.publisherId||
    trusted.manifestSha256!==evidence.manifestSha256||
    trusted.artifactSha256!==evidence.artifactSha256)
    fail('SKILL_BATCH_EVIDENCE_DRIFT');
  }
 }
 #applied(record,checkpoint){
  const state=this.registry.list('parent');
  const event=state.history.at(-1);
  if(!event||checkpoint.historyLength!==record.baseline.historyLength+1||
   event.action!=='batch-install'||event.target!=='batch:'+record.targets.length||
   event.before!==record.baseline.snapshotHash||
   event.prevHash!==record.baseline.historyHash||
   checkpoint.historyHash!==event.hash)return false;
  const plan=planAtomicSkillUpgrade({registry:{
   ...state,installed:record.expectedPins},targets:record.targets,
   verify:()=>({})});
  return plan.ready&&samePins(checkpoint.installed,plan.finalPins);
 }
 #mark(record,phase){
  const next=structuredClone(this.#state);
  const current=next.records.find(x=>x.operationId===record.operationId);
  current.phase=phase;rehash(next);
  return this.#save(next);
 }
 async #resume(record){
  const current=this.#state.records.find(x=>x.operationId===record.operationId);
  if(!current)fail('SKILL_BATCH_TRANSACTION_NOT_FOUND');
  if(current.phase==='committed')return {operationId:current.operationId,status:'committed',atomic:true,executable:false};
  if(current.phase==='abandoned')fail('SKILL_BATCH_TRANSACTION_ABANDONED');
  return this.registry.withinTransaction(record.operationId,async()=>{
   this.#verifyProofs(record);
   const checkpoint=this.registry.checkpoint('parent');
   const identicalBase=checkpoint.historyLength===record.baseline.historyLength&&
    checkpoint.historyHash===record.baseline.historyHash&&
    checkpoint.snapshotHash===record.baseline.snapshotHash&&
    samePins(checkpoint.installed,record.expectedPins);
   if(identicalBase){
    const plan=planAtomicSkillUpgrade({registry:this.registry.list('parent'),
     targets:record.targets,verify:m=>this.trust.assertTrusted(m)});
    if(!plan.ready)fail(plan.blockers[0]?.reason??'SKILL_BATCH_UNSAFE');
    await this.registry.installBatch('parent',{
     targets:record.targets,expectedPins:record.expectedPins});
   }else if(!this.#applied(record,checkpoint)){
    fail('SKILL_BATCH_RECOVERY_CONFLICT');
   }
   const after=this.registry.checkpoint('parent');
   if(!this.#applied(record,after))fail('SKILL_BATCH_RECOVERY_CONFLICT');
   await this.#mark(record,'committed');
   return {operationId:record.operationId,status:'committed',atomic:true,executable:false};
  });
 }
 apply(actor,{operationId,targets,expectedPins}={}){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#serial(async()=>{
   if(!opId(operationId)||!uniquePins(targets)||targets.length<1||targets.length>12||
    !uniquePins(expectedPins)||expectedPins.length>100)
    fail('INVALID_SKILL_BATCH_TRANSACTION');
   const requestHash=sha({targets,expectedPins});
   const existing=this.#state.records.find(r=>r.operationId===operationId);
   if(existing){
    if(existing.requestHash!==requestHash)fail('SKILL_BATCH_IDEMPOTENCY_CONFLICT');
    return this.#resume(existing);
   }
   if(this.#state.records.some(r=>r.phase==='prepared'))
    fail('SKILL_BATCH_TRANSACTION_PENDING');
   if(this.#state.records.length>=400)fail('SKILL_BATCH_WAL_FULL');
   const checkpoint=this.registry.checkpoint('parent');
   if(!samePins(checkpoint.installed,expectedPins))fail('SKILL_INSTALL_CONFLICT');
   const catalog=this.registry.list('parent').packages;
   const proofs=targets.map(({id,version})=>{
    const item=catalog.find(p=>p.manifest.id===id&&p.manifest.version===version);
    if(!item||item.status!=='approved')fail('SKILL_NOT_APPROVED');
    return {id,version,...this.trust.assertTrusted(item.manifest)};
   });
   const plan=planAtomicSkillUpgrade({registry:this.registry.list('parent'),
    targets,verify:m=>this.trust.assertTrusted(m)});
   if(!plan.ready)fail(plan.blockers[0]?.reason??'SKILL_BATCH_UNSAFE');
   if(!plan.changes.length)fail('SKILL_BATCH_NO_CHANGES');
   const next=structuredClone(this.#state);
   const r={seq:next.records.length+1,operationId,phase:'prepared',
    targets:structuredClone(targets),expectedPins:structuredClone(expectedPins),
    proofs,requestHash,baseline:{historyLength:checkpoint.historyLength,
     historyHash:checkpoint.historyHash,snapshotHash:checkpoint.snapshotHash},
    prevHash:next.records.at(-1)?.hash??'0'.repeat(64)};
   next.records.push({...r,hash:recordHash(r)});
   await this.#save(next); // durable intent before batch registry commit
   return this.#resume(r);
  });
 }
 recover(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#serial(async()=>{
   const reports=[];
   for(const r of this.#state.records.filter(r=>r.phase==='prepared')){
    try{reports.push(await this.#resume(r));}
    catch(e){reports.push({operationId:r.operationId,status:'needs-review',error:e.message});}
   }
   return {reports,pending:this.#state.records.filter(r=>r.phase==='prepared').length};
  });
 }
 abandon(actor,{operationId}={}){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#serial(async()=>{
   const record=this.#state.records.find(r=>r.operationId===operationId);
   if(!record||record.phase!=='prepared')fail('SKILL_BATCH_TRANSACTION_NOT_PENDING');
   const checkpoint=this.registry.checkpoint('parent');
   if(checkpoint.historyLength!==record.baseline.historyLength||
    checkpoint.historyHash!==record.baseline.historyHash||
    checkpoint.snapshotHash!==record.baseline.snapshotHash||
    !samePins(checkpoint.installed,record.expectedPins))
    fail('SKILL_BATCH_RECOVERY_CONFLICT');
   await this.#mark(record,'abandoned');
   return {operationId,status:'abandoned',executable:false};
  });
 }
 readiness(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return {capacity:400,remaining:400-this.#state.records.length,
   pending:this.#state.records.filter(r=>r.phase==='prepared').map(r=>r.operationId),
   archival:'no pruning of request IDs; fail closed at capacity'};
 }
}
