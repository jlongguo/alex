// R31 durable, parent-only control of *trusted built-in* Skill manifests.
// The store contains enabled flags and version pins, never executable code.
import {JsonStateStore} from './state-store.mjs';
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(id);
const validVersion=version=>typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version);
export class SkillGovernance{
 #queue=Promise.resolve();
 constructor({file,registry}={}){
  if(typeof file!=='string'||!file||typeof registry?.list!=='function'
   ||typeof registry?.setEnabled!=='function')
   throw Error('INVALID_SKILL_GOVERNANCE_CONFIG');
  this.store=new JsonStateStore(file);
  this.registry=registry;
 }
 list(){
  return this.registry.list().map(m=>({
   id:m.id,version:m.version,name:m.name,description:m.description,
   enabled:m.enabled,capabilities:[...m.capabilities],
   allowedActors:[...m.allowedActors],
   conversationMode:m.conversationMode??null,
   source:'trusted-builtin',sandboxed:false,
   executableUploadSupported:false
  }));
 }
 async load(){
  const saved=await this.store.load();
  if(!saved)return;
  const known=new Map(this.registry.list().map(m=>[m.id,m]));
  if(saved.schemaVersion!==1||!Array.isArray(saved.entries)
   ||saved.entries.length>known.size)throw Error('INVALID_SKILL_GOVERNANCE_STATE');
  const ids=new Set();
  for(const item of saved.entries){
   if(!item||!validId(item.id)||!validVersion(item.version)
    ||typeof item.enabled!=='boolean'||ids.has(item.id)
    ||Object.keys(item).sort().join(',')!=='enabled,id,version')
    throw Error('INVALID_SKILL_GOVERNANCE_STATE');
   ids.add(item.id);
   if(!known.has(item.id)||known.get(item.id).version!==item.version)
    throw Error('SKILL_VERSION_REVIEW_REQUIRED');
  }
  for(const item of saved.entries)this.registry.setEnabled(item.id,item.enabled,'parent');
 }
 set(actor,{id,enabled,expectedVersion}={}){
  if(actor!=='parent')throw Error('PARENT_REQUIRED');
  if(!validId(id)||typeof enabled!=='boolean'||!validVersion(expectedVersion))
   throw Error('INVALID_SKILL_GOVERNANCE_UPDATE');
  const operation=this.#queue.catch(()=>{}).then(async()=>{
   const current=this.registry.list();
   const target=current.find(m=>m.id===id);
   if(!target)throw Error('UNKNOWN_SKILL');
   if(target.version!==expectedVersion)throw Error('SKILL_VERSION_REVIEW_REQUIRED');
   if(target.enabled===enabled)return {changed:false,skill:this.list().find(m=>m.id===id)};
   // Durability first: failed writes must not grant new permissions.
   await this.store.save({schemaVersion:1,entries:current.map(m=>({
    id:m.id,version:m.version,enabled:m.id===id?enabled:m.enabled
   }))});
   this.registry.setEnabled(id,enabled,'parent');
   return {changed:true,skill:this.list().find(m=>m.id===id)};
  });
  this.#queue=operation.catch(()=>{});
  return operation;
 }
}
