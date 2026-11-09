import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
const schema={type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false};
const manifest=(id,version)=>({schemaVersion:'alex.skill/v1',id,version,
 name:'Trusted metadata',description:'Metadata only',permissions:[],
 allowedActors:['parent'],dependencies:[],inputSchema:schema,outputSchema:schema});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r33-pins-'));
 const file=join(dir,'nested','packages.json');
 return {dir,file,registry:new SkillPackageRegistry({file}),close:()=>rm(dir,{recursive:true,force:true})};
}
test('R33 installed dependents block version replacement and tampered persistence fails closed',async()=>{
 const f=await fixture();try{
  const r=f.registry;
  await r.submit('parent',manifest('family.base','1.0.0'));
  await r.review('parent',{id:'family.base',version:'1.0.0',decision:'approve'});
  await r.install('parent',{id:'family.base',version:'1.0.0'});
  const child={...manifest('family.child','1.0.0'),dependencies:[{id:'family.base',version:'1.0.0'}]};
  await r.submit('parent',child);
  await r.review('parent',{id:'family.child',version:'1.0.0',decision:'approve'});
  await r.install('parent',{id:'family.child',version:'1.0.0'});
  await r.submit('parent',manifest('family.base','1.1.0'));
  await r.review('parent',{id:'family.base',version:'1.1.0',decision:'approve'});
  await assert.rejects(r.install('parent',{id:'family.base',version:'1.1.0',
   expectedCurrentVersion:'1.0.0'}),/SKILL_DEPENDENCY_IN_USE/);
  const saved=JSON.parse(await readFile(f.file,'utf8'));
  saved.installed=saved.installed.filter(i=>i.id!=='family.base');
  await writeFile(f.file,JSON.stringify(saved));
  await assert.rejects(new SkillPackageRegistry({file:f.file}).load(),/INVALID_SKILL_PACKAGE_STATE/);
 }finally{await f.close();}
});
