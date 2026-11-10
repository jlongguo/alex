import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {planAtomicSkillUpgrade} from '../scripts/skill-upgrade-planner.mjs';
const schema={type:'object',properties:{},required:[],additionalProperties:false};
const m=(id,version,dependencies=[],permissions=[])=>({
 schemaVersion:'alex.skill/v1',id,version,name:'Safe metadata',description:'No executable code',
 dependencies,permissions,allowedActors:['parent'],inputSchema:schema,outputSchema:schema
});
const d=(id,version)=>({id,version});
async function fixture(authorizePackage=()=>{}){
 const dir=await mkdtemp(join(tmpdir(),'alex-r39-'));
 const file=join(dir,'packages.json');
 const registry=new SkillPackageRegistry({file,authorizePackage});
 return {registry,file,close:()=>rm(dir,{recursive:true,force:true})};
}
async function approved(r,manifest){
 await r.submit('parent',manifest);
 await r.review('parent',{id:manifest.id,version:manifest.version,decision:'approve'});
}
test('R39 atomic batch can upgrade mutually pinned packages without invalid intermediate states',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await approved(r,m('family.a','1.0.0',[d('family.b','1.0.0')]));
  await approved(r,m('family.b','1.0.0'));
  await r.install('parent',{id:'family.b',version:'1.0.0'});
  await r.install('parent',{id:'family.a',version:'1.0.0'});
  await approved(r,m('family.a','2.0.0',[d('family.b','2.0.0')]));
  await approved(r,m('family.b','2.0.0'));
  const before=r.list('parent'),targets=[d('family.a','2.0.0'),d('family.b','2.0.0')];
  const plan=planAtomicSkillUpgrade({registry:before,targets});
  assert.equal(plan.ready,true);
  assert.equal(plan.changes.length,2);
  const done=await r.installBatch('parent',{targets,expectedPins:before.installed});
  assert.equal(done.atomic,true);assert.equal(done.executable,false);
  const state=r.list('parent');
  assert.equal(state.history.length,before.history.length+1);
  assert.equal(state.history.at(-1).action,'batch-install');
  assert.deepEqual(state.installed.map(i=>i.version),['2.0.0','2.0.0']);
  const restarted=new SkillPackageRegistry({file:f.file});await restarted.load();
  assert.deepEqual(restarted.list('parent'),state);
 }finally{await f.close();}
});
test('R39 failed CAS or missing signature leaves entire installed state and history untouched',async()=>{
 let trusted=true;
 const f=await fixture(()=>{if(!trusted)throw Error('PUBLISHER_NOT_ACTIVE');});
 try{
  const r=f.registry;
  await approved(r,m('family.a','1.0.0'));
  await r.install('parent',{id:'family.a',version:'1.0.0'});
  await approved(r,m('family.a','2.0.0'));
  const before=r.list('parent');
  await assert.rejects(r.installBatch('parent',{targets:[d('family.a','2.0.0')],expectedPins:[]}),
   /SKILL_INSTALL_CONFLICT/);
  trusted=false;
  await assert.rejects(r.installBatch('parent',{targets:[d('family.a','2.0.0')],
   expectedPins:before.installed}),/PUBLISHER_NOT_ACTIVE/);
  assert.deepEqual(r.list('parent'),before);
 }finally{await f.close();}
});
test('R39 injected snapshot persistence failure cannot partially mutate memory or saved state',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await approved(r,m('family.a','1.0.0'));
  const original=r.store.save.bind(r.store);
  const before=r.list('parent');
  r.store.save=async()=>{throw Error('INJECTED_STORAGE_FAILURE');};
  await assert.rejects(r.installBatch('parent',{targets:[d('family.a','1.0.0')],
   expectedPins:[]}),/INJECTED_STORAGE_FAILURE/);
  assert.deepEqual(r.list('parent'),before);
  const restarted=new SkillPackageRegistry({file:f.file});await restarted.load();
  assert.deepEqual(restarted.list('parent'),before);
  r.store.save=original;
 }finally{await f.close();}
});
test('R39 atomic planner blocks active references, privilege expansion and cyclic final graph',async()=>{
 const catalog=[
  {manifest:m('family.a','1.0.0'),status:'approved'},
  {manifest:m('family.a','2.0.0',[d('family.b','2.0.0')],['audio.input']),status:'approved'},
  {manifest:m('family.b','2.0.0',[d('family.a','2.0.0')]),status:'approved'}
 ];
 const state={packages:catalog,installed:[d('family.a','1.0.0')],
  references:[{skillId:'family.a',version:'1.0.0'}]};
 const plan=planAtomicSkillUpgrade({registry:state,targets:[d('family.a','2.0.0'),d('family.b','2.0.0')]});
 assert.equal(plan.ready,false);assert.deepEqual(plan.changes,[]);
 assert.ok(plan.blockers.some(x=>x.reason==='SKILL_DEPENDENCY_CYCLE'));
 assert.ok(plan.blockers.some(x=>x.reason==='SKILL_REFERENCES_PINNED'));
 assert.ok(plan.blockers.some(x=>x.reason==='SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL'));
});
test('R39 atomic batch validation rejects duplicate targets and stale parent request',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await approved(r,m('family.a','1.0.0'));
  await assert.rejects(r.installBatch('parent',{targets:[d('family.a','1.0.0'),d('family.a','1.0.0')],expectedPins:[]}),/INVALID_SKILL_UPGRADE_TARGET/);
  await assert.rejects(r.installBatch('child',{targets:[d('family.a','1.0.0')],expectedPins:[]}),/PARENT_REQUIRED/);
  assert.deepEqual(r.list('parent').installed,[]);
 }finally{await f.close();}
});
