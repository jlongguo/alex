// R32 metadata-only Skill package lifecycle. NEVER imports or executes package code.
import {JsonStateStore} from './state-store.mjs';
const idPattern=/^[a-z][a-z0-9.-]{2,79}$/;
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const allowedPermissions=new Set(['audio.input','audio.output','display.face','navigation.goto','navigation.dock']);
const allowedActors=new Set(['parent','child']);
const safeString=(v,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const key=(id,version)=>id+'@'+version;
const fail=(code)=>{throw Error(code);};
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
 #state={schemaVersion:1,packages:[],installed:[],references:[]};
 constructor({file}={}){
  if(!safeString(file,4096))fail('INVALID_SKILL_PACKAGE_CONFIG');
  this.store=new JsonStateStore(file);
 }
 #snapshot(){return structuredClone(this.#state);}
 list(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return this.#snapshot();
 }
 async load(){
  const saved=await this.store.load();
  if(!saved)return;
  if(!saved||saved.schemaVersion!==1||!Array.isArray(saved.packages)||
   !Array.isArray(saved.installed)||!Array.isArray(saved.references)||
   Object.keys(saved).sort().join(',')!=='installed,packages,references,schemaVersion'||
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
  for(const r of saved.references){
   if(!validReference(r)||!seen.has(key(r.skillId,r.version))||
    !installed.has(r.skillId)||saved.installed.find(i=>i.id===r.skillId).version!==r.version)
    fail('INVALID_SKILL_PACKAGE_STATE');
  }
  this.#state=structuredClone(saved);
 }
 #mutate(actor,fn){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  const job=this.#queue.catch(()=>{}).then(async()=>{
   const next=this.#snapshot();
   const value=fn(next);
   await this.store.save(next);
   this.#state=next;
   return structuredClone(value);
  });
  this.#queue=job.catch(()=>{});
  return job;
 }
 submit(actor,manifest){
  const m=manifestOf(manifest);
  return this.#mutate(actor,s=>{
   if(s.packages.some(p=>key(p.manifest.id,p.manifest.version)===key(m.id,m.version)))
    fail('SKILL_PACKAGE_EXISTS');
   if(s.packages.filter(p=>p.manifest.id===m.id).some(p=>compare(p.manifest.version,m.version)>=0))
    fail('SKILL_VERSION_NOT_NEWER');
   s.packages.push({manifest:m,status:'pending'});
   return {id:m.id,version:m.version,status:'pending'};
  });
 }
 review(actor,{id,version,decision}={}){
  return this.#mutate(actor,s=>{
   if(!idPattern.test(id)||!versionPattern.test(version)||!['approve','revoke'].includes(decision))
    fail('INVALID_SKILL_REVIEW');
   const pkg=s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(id,version));
   if(!pkg)fail('UNKNOWN_SKILL_PACKAGE');
   if(decision==='approve'){
    if(pkg.status!=='pending')fail('SKILL_REVIEW_CONFLICT');
    const prior=s.packages.filter(p=>p.manifest.id===id&&p.status==='approved');
    for(const old of prior){
     if(old.manifest.permissions.some(p=>!pkg.manifest.permissions.includes(p))||
      old.manifest.allowedActors.some(a=>!pkg.manifest.allowedActors.includes(a))){}
    }
    pkg.status='approved';
   }else{
    pkg.status='revoked';
    // Revocation also removes installed package and its references.
    s.installed=s.installed.filter(i=>key(i.id,i.version)!==key(id,version));
    s.references=s.references.filter(r=>key(r.skillId,r.version)!==key(id,version));
   }
   return {id,version,status:pkg.status};
  });
 }
 install(actor,{id,version,expectedCurrentVersion=null}={}){
  return this.#mutate(actor,s=>{
   if(!idPattern.test(id)||!versionPattern.test(version)||
    (expectedCurrentVersion!==null&&!versionPattern.test(expectedCurrentVersion)))
    fail('INVALID_SKILL_INSTALL');
   const pkg=s.packages.find(p=>key(p.manifest.id,p.manifest.version)===key(id,version));
   if(!pkg||pkg.status!=='approved')fail('SKILL_NOT_APPROVED');
   const old=s.installed.find(i=>i.id===id);
   if((old?.version??null)!==expectedCurrentVersion)fail('SKILL_INSTALL_CONFLICT');
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
    old.version=version;
   }else s.installed.push({id,version});
   return {id,version,executable:false};
  });
 }
 uninstall(actor,{id,expectedVersion}={}){
  return this.#mutate(actor,s=>{
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
  return this.#mutate(actor,s=>{
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
