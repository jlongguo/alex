import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
const schema={type:'object',properties:{prompt:{type:'string'}},required:[],additionalProperties:false};
const m=(id,version,permissions=[])=>({schemaVersion:'alex.skill/v1',id,version,
 name:'Safe metadata',description:'No executable code',permissions,
 allowedActors:['parent'],dependencies:[],inputSchema:schema,outputSchema:schema});
async function fixture(authorizePackage=()=>{}){
 const dir=await mkdtemp(join(tmpdir(),'alex-r35-'));
 const file=join(dir,'registry.json');
 return {dir,file,reg:new SkillPackageRegistry({file,authorizePackage}),
  close:()=>rm(dir,{recursive:true,force:true})};
}
async function approve(reg,manifest){
 await reg.submit('parent',manifest);
 await reg.review('parent',{id:manifest.id,version:manifest.version,decision:'approve'});
}
test('R35 atomic metadata journal stores ordered operations and recovers across restart',async()=>{
 const f=await fixture();try{
  const r=f.reg;
  await approve(r,m('family.alpha','1.0.0'));
  await r.install('parent',{id:'family.alpha',version:'1.0.0'});
  await r.setReference('parent',{kind:'plan',resourceId:'p-1',skillId:'family.alpha',version:'1.0.0',enabled:true});
  const entries=r.list('parent').history;
  assert.deepEqual(entries.map(x=>x.action),['submit','review','install','reference']);
  assert.deepEqual(entries.map(x=>x.seq),[1,2,3,4]);
  assert.equal(entries[3].prevHash,entries[2].hash);
  assert.notEqual(entries[3].before,entries[3].after);
  const restarted=new SkillPackageRegistry({file:f.file});await restarted.load();
  assert.deepEqual(restarted.list('parent'),r.list('parent'));
  const corrupted=JSON.parse(await readFile(f.file,'utf8'));
  corrupted.history[2].target='forged';
  await writeFile(f.file,JSON.stringify(corrupted));
  await assert.rejects(new SkillPackageRegistry({file:f.file}).load(),/INVALID_SKILL_PACKAGE_HISTORY/);
 }finally{await f.close();}
});
test('R35 legacy schema v1 migrates without losing installed metadata and writes v2',async()=>{
 const f=await fixture();try{
  const old={schemaVersion:1,packages:[{manifest:m('family.legacy','1.0.0'),status:'approved'}],
   installed:[{id:'family.legacy',version:'1.0.0'}],references:[]};
  await writeFile(f.file,JSON.stringify(old));
  const r=new SkillPackageRegistry({file:f.file});await r.load();
  assert.equal(r.list('parent').schemaVersion,2);
  assert.deepEqual(r.list('parent').history,[]);
  await r.uninstall('parent',{id:'family.legacy',expectedVersion:'1.0.0'});
  const persisted=JSON.parse(await readFile(f.file,'utf8'));
  assert.equal(persisted.schemaVersion,2);
  assert.equal(persisted.history[0].action,'uninstall');
 }finally{await f.close();}
});
test('R35 preview shows permission diff and dependency/reference blockers without changing state',async()=>{
 const f=await fixture();try{
  const r=f.reg;
  await approve(r,m('family.alpha','1.0.0',['audio.output']));
  await r.install('parent',{id:'family.alpha',version:'1.0.0'});
  await r.setReference('parent',{kind:'plan',resourceId:'plan-1',
   skillId:'family.alpha',version:'1.0.0',enabled:true});
  await approve(r,m('family.alpha','1.1.0',['navigation.goto']));
  const before=r.list('parent');
  const preview=r.preview('parent',{id:'family.alpha',version:'1.1.0',expectedCurrentVersion:'1.0.0'});
  assert.equal(preview.blocked,true);
  assert.deepEqual(preview.addedPermissions,['navigation.goto']);
  assert.deepEqual(preview.removedPermissions,['audio.output']);
  assert.equal(preview.impactedReferences.length,1);
  assert.ok(preview.blockers.includes('SKILL_REFERENCES_PINNED'));
  assert.ok(preview.blockers.includes('SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL'));
  assert.deepEqual(r.list('parent'),before);
  assert.throws(()=>r.preview('child',{id:'family.alpha',version:'1.1.0'}),/PARENT_REQUIRED/);
 }finally{await f.close();}
});
test('R35 explicit rollback honors exact CAS version and preserves journal lineage',async()=>{
 const f=await fixture();try{
  const r=f.reg;
  await approve(r,m('family.alpha','1.0.0'));
  await approve(r,m('family.alpha','1.1.0'));
  await r.install('parent',{id:'family.alpha',version:'1.1.0'});
  await assert.rejects(r.install('parent',{id:'family.alpha',version:'1.0.0',
   expectedCurrentVersion:'1.1.0'}),/SKILL_ROLLBACK_REQUIRES_REVIEW/);
  await assert.rejects(r.install('parent',{id:'family.alpha',version:'1.0.0',
   expectedCurrentVersion:'1.1.0',operation:'rollback'}),/SKILL_ROLLBACK_REQUIRES_REVIEW/);
  const prior=r.list('parent').history.length;
  await r.rollback('parent',{id:'family.alpha',version:'1.0.0',expectedCurrentVersion:'1.1.0'});
  assert.equal(r.list('parent').installed[0].version,'1.0.0');
  assert.equal(r.list('parent').history.at(-1).action,'rollback');
  assert.equal(r.list('parent').history.length,prior+1);
  await assert.rejects(r.rollback('parent',{id:'family.alpha',version:'1.1.0',
   expectedCurrentVersion:'1.0.0'}),/SKILL_ROLLBACK_NOT_OLDER/);
 }finally{await f.close();}
});
test('R35 failed trust or conflict cannot append journal or mutate installed state',async()=>{
 let allowed=true;
 const f=await fixture(()=>{if(!allowed)throw Error('PUBLISHER_NOT_ACTIVE');});
 try{
  const r=f.reg;
  await approve(r,m('family.alpha','1.0.0'));
  const before=r.list('parent');
  allowed=false;
  await assert.rejects(r.install('parent',{id:'family.alpha',version:'1.0.0'}),/PUBLISHER_NOT_ACTIVE/);
  assert.deepEqual(r.list('parent'),before);
  allowed=true;
  await r.install('parent',{id:'family.alpha',version:'1.0.0'});
  const installed=r.list('parent');
  await assert.rejects(r.install('parent',{id:'family.alpha',version:'1.0.0',
   expectedCurrentVersion:null}),/SKILL_INSTALL_CONFLICT/);
  assert.deepEqual(r.list('parent'),installed);
 }finally{await f.close();}
});
