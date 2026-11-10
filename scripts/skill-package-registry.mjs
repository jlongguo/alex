// R32 metadata-only Skill package lifecycle. NEVER imports or executes package code.
import {JsonStateStore} from './state-store.mjs';
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {planAtomicSkillUpgrade} from './skill-upgrade-planner.mjs';
import {analyzeSkillDependencies,requireSkillDependencyIntegrity} from './skill-dependency-graph.mjs';
const idPattern=/^[a-z][a-z0-9.-]{2,79}$/;
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const allowedPermissions=new Set(['audio.input','audio.output','display.face','navigation.goto','navigation.dock']);
const allowedActors=new Set(['parent','child']);
const safeString=(v,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const key=(id,version)=>id+'@'+version;
const fail=(code)=>{throw Error(code);};
const checksum=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operationHash=entry=>checksum({seq:entry.seq,action:entry.action,target:entry.target,
 before:entry.before,after:entry.after,prevHash:entry.prevHash});
function checkHistory(history){
 if(!Array.isArray(history)||history.length>2000)fail('INVALID_SKILL_PACKAGE_HISTORY');
 let last='0'.repeat(64);
 for(let i=0;i<history.length;i++){
  const e=history[i];
  if(!e||Object.keys(e).sort().join(',')!=='action,after,before,hash,prevHash,seq,target'||
    !Number.isSafeInteger(e.seq)||e.seq!==i+1||typeof e.action!=='string'||
    !/^(submit|review|install|rollback|uninstall|reference|batch-install)$/.test(e.action)||
    typeof e.target!=='string'||e.target.length>200||
    ![e.before,e.after,e.prevHash,e.hash].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||
    e.prevHash!==last||operationHash(e)!==e.hash)
    fail('INVALID_SKILL_PACKAGE_HISTORY');
  last=e.hash;
 }
}
function manifestOf(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).some(k=>!['schemaVersion','id','version','name','description','permissions','allowedActors','dependencies','inputSchema','outputSchema'].includes(k))||
  value.schemaVersion!=='alex.skill/v1'||!idPattern.test(value.id)||
  !versionPattern.test(value.version)||!safeString(value.name,80)||
  !safeString(value.description,500)||
  !Array.isArray(value.permissions)||value.permissions.length>8||
  value.permissions.some(p=>!allowedPermissions.has(p))||
  new Set(value.permissions).size!==value.permissions.length||
  !Array.isArray(value.allowedActors)||!value.allowedActors.length||
  value.allowedActors.some(a=>!allowedActors.has(a))||
  new Set(value.allowedActors).size!==value.allowedActors.length||
  !Array.isArray(value.dependencies)||value.dependencies.length>20||
  value.dependencies.some(d=>!d||typeof d!=='object'||Object.keys(d).sort().join(',')!=='id,version'||
   !idPattern.test(d.id)||!versionPattern.test(d.version)||d.id===value.id)||
  new Set(value.dependencies.map(d=>key(d.id,d.version))).size!==value.dependencies.length||
  !schemaOf(value.inputSchema)||!schemaOf(value.outputSchema))fail('INVALID_SKILL_PACKAGE_MANIFEST');
 return structuredClone(value);
}
// Deliberately restricted declarative schemas: no remote refs, executable payloads or recursion.
function schemaOf(s){
 if(!s||typeof s!=='object'||Array.isArray(s)||s.type!=='object'||
  !s.properties||typeof s.properties!=='object'||Array.isArray(s.properties)||
  Object.keys(s).some(k=>!['type','properties','required','additionalProperties'].includes(k))||
  s.additionalProperties!==false||Object.keys(s.properties).length>32||
  !Array.isArray(s.required)||new Set(s.required).size!==s.required.length||
  s.required.some(k=>!Object.hasOwn(s.properties,k)))return false;
 return Object.entries(s.properties).every(([k,v])=>/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)&&
  v&&typeof v==='object'&&!Array.isArray(v)&&
  ['string','number','integer','boolean'].includes(v.type)&&Object.keys(v).length===1);
}
function compare(a,b){
 const x=a.split('.').map(Number),y=b.split('.').map(Number);
 for(let i=0;i<3;i++){if(x[i]>y[i])return 1;if(x[i]<y[i])return -1;}
 return 0;
}
export class SkillPackageRegistry{
 #queue=Promise.resolve();
 #state={schemaVersion:2,packages:[],installed:[],references:[],history:[]};
 #transactionContext=new AsyncLocalStorage();
 #transactionGuard=null;
 #additionalTransactionGuards=[];
 constructor({file,authorizePackage=()=>{}}={}){
  if(!safeString(file,4096))fail('INVALID_SKILL_PACKAGE_CONFIG');
  this.store=new JsonStateStore(file);
  if(typeof authorizePackage!=='function')fail('INVALID_SKILL_PACKAGE_CONFIG');
  this.authorizePackage=authorizePackage;
 }
 #snapshot(){return structuredClone(this.#state);}
 // Read-only audit checkpoint for WAL reconciliation; serialized registry mutations own writes.
 checkpoint(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  const s=this.#snapshot();
  return {historyLength:s.history.length,historyHash:s.history.at(-1)?.hash??'0'.repeat(64),
   snapshotHash:checksum({packages:s.packages,installed:s.installed,references:s.references}),
   installed:s.installed};
 }
 // The coordinator owns the transaction lock. Context propagates through serialized writes.
 // This is in-process isolation; a second process sharing files remains unsupported.
 addTransactionGuard(guard){
  if(typeof guard!=='function')fail('INVALID_SKILL_TRANSACTION_GUARD');
  this.#additionalTransactionGuards.push(guard);
 }
 setTransactionGuard(guard){
  // A new coordinator can replace an abandoned instance during in-process recovery.
  // Only the latest coordinator guard governs this single registry instance.
  if(typeof guard!=='function')fail('INVALID_SKILL_TRANSACTION_GUARD');
  this.#transactionGuard=guard;
 }
 withinTransaction(operationId,fn){
  if(typeof fn!=='function'||typeof operationId!=='string')fail('INVALID_SKILL_TRANSACTION_CONTEXT');
  return this.#transactionContext.run(operationId,fn);
 }
 list(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#snapshot();
 }
 dependencyGraph(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return analyzeSkillDependencies(this.#snapshot());
 }
 async load(){
  const saved=await this.store.load();
  if(!saved)return;
  if(!saved||![1,2].includes(saved.schemaVersion)||!Array.isArray(saved.packages)||
   !Array.isArray(saved.installed)||!Array.isArray(saved.references)||
   Object.keys(saved).sort().join(',')!==(saved.schemaVersion===1?
     'installed,packages,references,schemaVersion':'history,installed,packages,references,schemaVersion')||
   saved.packages.length>500||saved.installed.length>100||saved.references.length>1000)
   fail('INVALID_SKILL_PACKAGE_STATE');
  const seen=new Set();
  for(const p of saved.packages){
   manifestOf(p.manifest);
   if(Object.keys(p).sort().join(',')!=='manifest,status'||
    !['pending','approved','revoked'].includes(p.status)||
    seen.has(key(p.manifest.id,p.manifest.version)))fail('INVALID_SKILL_PACKAGE_STATE');
   seen.add(key(p.manifest.id,p.manifest.version));
  }
  const installed=new Set();
  for(const i of saved.installed){
   if(!i||Object.keys(i).sort().join(',')!=='id,version'||
    !seen.has(key(i.id,i.version))||installed.has(i.id)||
    saved.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(i.id,i.version)).status!=='approved')
    fail('INVALID_SKILL_PACKAGE_STATE');
   installed.add(i.id);
  }
  // Fail closed when persisted installed packages have missing dependency pins.
  for(const i of saved.installed){
   const pkg=saved.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(i.id,i.version));
   if(pkg.manifest.dependencies.some(d=>!saved.installed.some(j=>
    key(j.id,j.version)===key(d.id,d.version))))
    fail('INVALID_SKILL_PACKAGE_STATE');
  }
  for(const r of saved.references){
   if(!validReference(r)||!seen.has(key(r.skillId,r.version))||
    !installed.has(r.skillId)||saved.installed.find(i=>i.id===r.skillId).version!==r.version)
    fail('INVALID_SKILL_PACKAGE_STATE');
  }
  if(saved.schemaVersion===2){
   checkHistory(saved.history);
   // Detect torn, stale or tampered snapshots, not just a syntactically valid hash chain.
   if(saved.history.length&&saved.history.at(-1).after!==checksum({
     packages:saved.packages,installed:saved.installed,references:saved.references
   }))fail('INVALID_SKILL_PACKAGE_HISTORY');
  }
  const refKeys=new Set();
  for(const ref of saved.references){
   const k=ref.kind+':'+ref.resourceId+':'+ref.skillId;
   if(refKeys.has(k))fail('INVALID_SKILL_PACKAGE_STATE');
   refKeys.add(k);
  }
  try{requireSkillDependencyIntegrity(saved);}
  catch{fail('INVALID_SKILL_PACKAGE_STATE');}
  this.#state=structuredClone(saved.schemaVersion===1?
    {...saved,schemaVersion:2,history:[]}:saved);
 }
 #mutate(actor,action,target,fn){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  const job=this.#queue.catch(()=>{}).then(async()=>{
   const context={action,target,operationId:this.#transactionContext.getStore()??null};
   if(this.#transactionGuard)this.#transactionGuard(context);
   for(const guard of this.#additionalTransactionGuards)guard(context);
   const next=this.#snapshot();
   const before=checksum({packages:next.packages,installed:next.installed,
    references:next.references});
   const value=fn(next);
   requireSkillDependencyIntegrity(next);
   const after=checksum({packages:next.packages,installed:next.installed,
    references:next.references});
   if(next.history.length>=2000)fail('SKILL_PACKAGE_HISTORY_FULL');
   const entry={seq:next.history.length+1,action,target,
     before,after,prevHash:next.history.at(-1)?.hash??'0'.repeat(64)};
   next.history.push({...entry,hash:operationHash(entry)});
   await this.store.save(next);
   this.#state=next;
   return structuredClone(value);
  });
  this.#queue=job.catch(()=>{});
  return job;
 }
 submit(actor,manifest){
  const m=manifestOf(manifest);
  return this.#mutate(actor,'submit',key(m.id,m.version),s=>{
   if(s.packages.some(p=>key(p.manifest.id,p.manifest.version)===key(m.id,m.version)))
    fail('SKILL_PACKAGE_EXISTS');
   if(s.packages.filter(p=>p.manifest.id===m.id).some(p=>compare(p.manifest.version,m.version)>=0))
    fail('SKILL_VERSION_NOT_NEWER');
   s.packages.push({manifest:m,status:'pending'});
   return {id:m.id,version:m.version,status:'pending'};
  });
 }
 review(actor,{id,version,decision}={}){
  return this.#mutate(actor,'review',key(id,version),s=>{
   if(!idPattern.test(id)||!versionPattern.test(version)||!['approve','revoke'].includes(decision))
    fail('INVALID_SKILL_REVIEW');
   const pkg=s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(id,version));
   if(!pkg)fail('UNKNOWN_SKILL_PACKAGE');
   if(decision==='approve'){
    if(pkg.status!=='pending')fail('SKILL_REVIEW_CONFLICT');
    this.authorizePackage(pkg.manifest,'review');
    pkg.status='approved';
   }else{
    if(s.installed.some(i=>s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(i.id,i.version))
       ?.manifest.dependencies.some(d=>key(d.id,d.version)===key(id,version))))
      fail('SKILL_DEPENDENCY_IN_USE');
    pkg.status='revoked';
    // Revocation also removes installed package and its references.
    s.installed=s.installed.filter(i=>key(i.id,i.version)!==key(id,version));
    s.references=s.references.filter(r=>key(r.skillId,r.version)!==key(id,version));
   }
   return {id,version,status:pkg.status};
  });
 }
 preview(actor,{id,version,expectedCurrentVersion=null}={}){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  if(!idPattern.test(id)||!versionPattern.test(version)||
   (expectedCurrentVersion!==null&&!versionPattern.test(expectedCurrentVersion)))
   fail('INVALID_SKILL_INSTALL');
  const state=this.#snapshot(),candidate=state.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(id,version));
  if(!candidate)fail('UNKNOWN_SKILL_PACKAGE');
  const currentPin=state.installed.find(i=>i.id===id);
  const prior=currentPin&&state.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(id,currentPin.version));
  const priorManifest=prior?.manifest;
  const next=candidate.manifest;
  const addedPermissions=next.permissions.filter(p=>!priorManifest?.permissions.includes(p));
  const removedPermissions=(priorManifest?.permissions??[]).filter(p=>!next.permissions.includes(p));
  const addedActors=next.allowedActors.filter(a=>!priorManifest?.allowedActors.includes(a));
  const removedActors=(priorManifest?.allowedActors??[]).filter(a=>!next.allowedActors.includes(a));
  const missingDependencies=next.dependencies.filter(d=>!state.installed.some(i=>
   key(i.id,i.version)===key(d.id,d.version)));
  const impactedReferences=state.references.filter(r=>r.skillId===id&&r.version===currentPin?.version);
  const dependentPins=state.installed.filter(i=>i.id!==id&&state.packages.some(p=>
   key(p.manifest.id,p.manifest.version)===key(i.id,i.version)&&
   p.manifest.dependencies.some(d=>key(d.id,d.version)===key(id,currentPin?.version))));
  let trusted=false,trustError=null;
  try{this.authorizePackage(next,'preview');trusted=true;}
  catch(error){trustError=error instanceof Error?error.message:'SKILL_ATTESTATION_REQUIRED';}
  const graph=analyzeSkillDependencies(state);
  const stale=(currentPin?.version??null)!==expectedCurrentVersion;
  const downgrade=!!currentPin&&compare(version,currentPin.version)<0;
  const blockers=[
   ...(candidate.status!=='approved'?['SKILL_NOT_APPROVED']:[]),
   ...(stale?['SKILL_INSTALL_CONFLICT']:[]),
   ...(!trusted?[trustError]:[]),
   ...(missingDependencies.length?['SKILL_DEPENDENCY_MISSING']:[]),
   ...(impactedReferences.length?['SKILL_REFERENCES_PINNED']:[]),
   ...(dependentPins.length?['SKILL_DEPENDENCY_IN_USE']:[]),
   ...((addedPermissions.length||addedActors.length)&&currentPin?
    ['SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL']:[])
  ];
  return structuredClone({id,version,currentVersion:currentPin?.version??null,
   status:candidate.status,change:!currentPin?'install':downgrade?'rollback':'upgrade',
   addedPermissions,removedPermissions,addedActors,removedActors,
   missingDependencies,impactedReferences,dependentPins,graph,blocked:blockers.length>0,
   blockers,executable:false});
 }
 rollback(actor,{id,version,expectedCurrentVersion}={}){
  return this.#applyInstall(actor,{id,version,expectedCurrentVersion},'rollback');
 }
 install(actor,{id,version,expectedCurrentVersion=null}={}){
  return this.#applyInstall(actor,{id,version,expectedCurrentVersion},'install');
 }
 #applyInstall(actor,{id,version,expectedCurrentVersion=null}={},operation){
  return this.#mutate(actor,operation,key(id,version),s=>{
   if(!idPattern.test(id)||!versionPattern.test(version)||
    (expectedCurrentVersion!==null&&!versionPattern.test(expectedCurrentVersion)))
    fail('INVALID_SKILL_INSTALL');
   const pkg=s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(id,version));
   if(!pkg||pkg.status!=='approved')fail('SKILL_NOT_APPROVED');
   this.authorizePackage(pkg.manifest,'install');
   const old=s.installed.find(i=>i.id===id);
   if((old?.version??null)!==expectedCurrentVersion)fail('SKILL_INSTALL_CONFLICT');
   if(operation==='rollback'){
    if(!old||compare(version,old.version)>=0)fail('SKILL_ROLLBACK_NOT_OLDER');
   }else if(old&&compare(version,old.version)<0)fail('SKILL_ROLLBACK_REQUIRES_REVIEW');
   // All dependencies must be approved and installed exactly at pinned versions.
   for(const d of pkg.manifest.dependencies)
    if(!s.installed.some(i=>key(i.id,i.version)===key(d.id,d.version)))
     fail('SKILL_DEPENDENCY_MISSING');
   if(old){
    // Updating a package must not implicitly broaden permissions or actor access.
    const previous=s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(old.id,old.version)).manifest;
    if(pkg.manifest.permissions.some(p=>!previous.permissions.includes(p))||
     pkg.manifest.allowedActors.some(a=>!previous.allowedActors.includes(a)))
     fail('SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL');
    if(s.references.some(r=>r.skillId===id&&r.version===old.version))
     fail('SKILL_REFERENCES_PINNED');
    // Existing installed dependents pin the old version and must be moved first.
    if(s.installed.some(i=>i.id!==id&&s.packages.find(p=>
      key(p.manifest.id,p.manifest.version)===key(i.id,i.version))
      ?.manifest.dependencies.some(d=>key(d.id,d.version)===key(id,old.version))))
     fail('SKILL_DEPENDENCY_IN_USE');
    old.version=version;
   }else s.installed.push({id,version});
   return {id,version,executable:false};
  });
 }
 // One queued registry snapshot for all pin replacements. No intermediate dependency drift.
 // All approval, trust, permission and version checks run again INSIDE the queue.
 installBatch(actor,{targets,expectedPins}={}){
  if(!Array.isArray(expectedPins)||!Array.isArray(targets)||
   expectedPins.length>100||expectedPins.some(x=>!x||typeof x.id!=='string'||
   typeof x.version!=='string'))fail('INVALID_SKILL_BATCH');
  return this.#mutate(actor,'batch-install','batch:'+targets.length,s=>{
   const pins=new Map(s.installed.map(i=>[i.id,i.version]));
   const optimistic=new Map(expectedPins.map(x=>[x.id,x.version]));
   if(optimistic.size!==expectedPins.length||pins.size!==optimistic.size||
      [...pins].some(([id,v])=>optimistic.get(id)!==v))
    fail('SKILL_INSTALL_CONFLICT');
   const plan=planAtomicSkillUpgrade({registry:s,targets,
    verify:manifest=>this.authorizePackage(manifest,'install')});
   if(!plan.ready)fail(plan.blockers[0]?.reason??'SKILL_BATCH_UNSAFE');
   for(const entry of plan.changes){
    const installed=s.installed.find(i=>i.id===entry.id);
    if(installed)installed.version=entry.to;
    else s.installed.push({id:entry.id,version:entry.to});
   }
   return {changes:plan.changes,installed:s.installed,atomic:true,executable:false};
  });
 }
 uninstall(actor,{id,expectedVersion}={}){
  return this.#mutate(actor,'uninstall',key(id,expectedVersion),s=>{
   const index=s.installed.findIndex(i=>i.id===id&&i.version===expectedVersion);
   if(index<0)fail('SKILL_INSTALL_CONFLICT');
   if(s.references.some(r=>r.skillId===id))fail('SKILL_REFERENCES_PINNED');
   if(s.installed.some(i=>s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(i.id,i.version))
    ?.manifest.dependencies.some(d=>key(d.id,d.version)===key(id,expectedVersion))))
    fail('SKILL_DEPENDENCY_IN_USE');
   s.installed.splice(index,1);
   return {id,uninstalled:true};
  });
 }
 setReference(actor,{kind,resourceId,skillId,version,enabled}={}){
  return this.#mutate(actor,'reference',String(kind)+':'+String(resourceId),s=>{
   const r={kind,resourceId,skillId,version};
   if(!validReference(r)||typeof enabled!=='boolean')fail('INVALID_SKILL_REFERENCE');
   const existing=s.references.findIndex(x=>x.kind===kind&&x.resourceId===resourceId&&x.skillId===skillId);
   if(enabled){
    if(!s.installed.some(i=>key(i.id,i.version)===key(skillId,version)))
     fail('SKILL_NOT_INSTALLED');
    if(existing>=0)s.references[existing]=r;else s.references.push(r);
   }else{
    if(existing<0||s.references[existing].version!==version)fail('SKILL_REFERENCE_CONFLICT');
    s.references.splice(existing,1);
   }
   return {reference:r,enabled};
  });
 }
}
function validReference(r){
 return !!r&&Object.keys(r).sort().join(',')==='kind,resourceId,skillId,version'&&
  ['plan','workflow','learning'].includes(r.kind)&&safeString(r.resourceId,100)&&
  /^[a-zA-Z0-9._:-]+$/.test(r.resourceId)&&idPattern.test(r.skillId)&&versionPattern.test(r.version);
}
