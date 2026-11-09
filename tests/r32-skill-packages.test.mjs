import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';

const schema={type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false};
const manifest=(id='family.learning',version='1.0.0',permissions=[])=>({
 schemaVersion:'alex.skill/v1',id,version,name:'Safe metadata',description:'Declarative only',
 permissions,allowedActors:['parent'],dependencies:[],inputSchema:schema,outputSchema:schema
});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r32-'));
 const file=join(dir,'nested','packages.json');
 const registry=new SkillPackageRegistry({file});
 return {dir,file,registry,close:()=>rm(dir,{force:true,recursive:true})};
}
test('R32 parent review, version-pinned install and reference survives restart',async()=>{
 const f=await fixture();
 try{
  const r=f.registry;
  await r.submit('parent',manifest());
  assert.equal(r.list('parent').packages[0].status,'pending');
  await assert.rejects(r.install('parent',{id:'family.learning',version:'1.0.0'}),/SKILL_NOT_APPROVED/);
  await r.review('parent',{id:'family.learning',version:'1.0.0',decision:'approve'});
  assert.deepEqual(await r.install('parent',{id:'family.learning',version:'1.0.0'}),{id:'family.learning',version:'1.0.0',executable:false});
  await r.setReference('parent',{kind:'learning',resourceId:'course-a',skillId:'family.learning',version:'1.0.0',enabled:true});
  const restarted=new SkillPackageRegistry({file:f.file});await restarted.load();
  assert.equal(restarted.list('parent').references.length,1);
  await assert.rejects(restarted.uninstall('parent',{id:'family.learning',expectedVersion:'1.0.0'}),/SKILL_REFERENCES_PINNED/);
  await restarted.setReference('parent',{kind:'learning',resourceId:'course-a',skillId:'family.learning',version:'1.0.0',enabled:false});
  await restarted.uninstall('parent',{id:'family.learning',expectedVersion:'1.0.0'});
  assert.equal(restarted.list('parent').installed.length,0);
 }finally{await f.close();}
});
test('R32 child and invalid manifests cannot register, approve or view packages',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  assert.throws(()=>r.list('child'),/PARENT_REQUIRED/);
  await assert.rejects(r.submit('child',manifest()),/PARENT_REQUIRED/);
  await assert.rejects(r.submit('parent',{...manifest(),execute:'process.exit(0)'}),/INVALID_SKILL_PACKAGE_MANIFEST/);
  await assert.rejects(r.submit('parent',{...manifest(),inputSchema:{$ref:'https://example.org/manifest'}}),/INVALID_SKILL_PACKAGE_MANIFEST/);
  await r.submit('parent',manifest());
  await assert.rejects(r.review('child',{id:'family.learning',version:'1.0.0',decision:'approve'}),/PARENT_REQUIRED/);
  await assert.rejects(r.submit('parent',manifest()),/SKILL_PACKAGE_EXISTS/);
 }finally{await f.close();}
});
test('R32 install does not auto-approve expanded permission or erase pinned references',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await r.submit('parent',manifest());await r.review('parent',{id:'family.learning',version:'1.0.0',decision:'approve'});
  await r.install('parent',{id:'family.learning',version:'1.0.0'});
  await r.submit('parent',manifest('family.learning','1.1.0',['navigation.goto']));
  await r.review('parent',{id:'family.learning',version:'1.1.0',decision:'approve'});
  await assert.rejects(r.install('parent',{id:'family.learning',version:'1.1.0',expectedCurrentVersion:'1.0.0'}),/SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL/);
  assert.equal(r.list('parent').installed[0].version,'1.0.0');
  await r.review('parent',{id:'family.learning',version:'1.0.0',decision:'revoke'});
  assert.equal(r.list('parent').installed.length,0);
 }finally{await f.close();}
});
test('R32 pinned package dependencies prevent premature installs and removals',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  const dependent={...manifest('family.dependent'),dependencies:[{id:'family.learning',version:'1.0.0'}]};
  await r.submit('parent',manifest());await r.submit('parent',dependent);
  await r.review('parent',{id:'family.learning',version:'1.0.0',decision:'approve'});
  await r.review('parent',{id:'family.dependent',version:'1.0.0',decision:'approve'});
  await assert.rejects(r.install('parent',{id:'family.dependent',version:'1.0.0'}),/SKILL_DEPENDENCY_MISSING/);
  await r.install('parent',{id:'family.learning',version:'1.0.0'});
  await r.install('parent',{id:'family.dependent',version:'1.0.0'});
  await assert.rejects(r.uninstall('parent',{id:'family.learning',expectedVersion:'1.0.0'}),/SKILL_DEPENDENCY_IN_USE/);
 }finally{await f.close();}
});
test('R32 durable failed modifications do not mutate in-memory state; corrupted restart fails closed',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await r.submit('parent',manifest());
  await assert.rejects(r.review('parent',{id:'family.learning',version:'1.0.0',decision:'invalid'}),/INVALID_SKILL_REVIEW/);
  assert.equal(r.list('parent').packages[0].status,'pending');
  const data=JSON.parse(await readFile(f.file,'utf8'));
  data.packages[0].manifest.execute='untrusted';
  await writeFile(f.file,JSON.stringify(data));
  await assert.rejects(new SkillPackageRegistry({file:f.file}).load(),/INVALID_SKILL_PACKAGE_MANIFEST/);
 }finally{await f.close();}
});
test('R32 serialized concurrent approvals maintain deterministic last valid state',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await r.submit('parent',manifest());
  const attempts=await Promise.allSettled([
   r.review('parent',{id:'family.learning',version:'1.0.0',decision:'approve'}),
   r.review('parent',{id:'family.learning',version:'1.0.0',decision:'approve'})
  ]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(r.list('parent').packages[0].status,'approved');
 }finally{await f.close();}
});
