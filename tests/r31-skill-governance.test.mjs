import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HomeCore} from '../dist/index.js';
import {SkillGovernance} from '../scripts/skill-governance.mjs';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r31-skill-'));
 const file=join(dir,'nested','governance.json');
 const core=new HomeCore();
 const control=new SkillGovernance({file,registry:core.skills});
 return {dir,file,core,control,close:()=>rm(dir,{recursive:true,force:true})};
}
test('R31 parent disables trusted skill durably and Plan/Skill invocation denies it',async()=>{
 const f=await fixture();try{
  const first=await f.control.set('parent',{id:'learning.english',
   enabled:false,expectedVersion:'0.2.0'});
  assert.equal(first.changed,true);
  assert.equal(first.skill.enabled,false);
  assert.equal(f.core.invokeSkill('learning.english','child').ok,false);
  assert.match(f.core.invokeSkill('learning.english','parent').message,/disabled/);
  const after=new HomeCore();
  const restored=new SkillGovernance({file:f.file,registry:after.skills});
  await restored.load();
  assert.equal(after.skills.list().find(x=>x.id==='learning.english').enabled,false);
  assert.equal(after.invokeSkill('learning.english','child').ok,false);
  await restored.set('parent',{id:'learning.english',
   enabled:true,expectedVersion:'0.2.0'});
  assert.equal(after.invokeSkill('learning.english','child').ok,true);
 }finally{await f.close();}
});
test('R31 child and invalid manifests cannot modify durable permission',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.control.set('child',{id:'learning.english',
   enabled:false,expectedVersion:'0.2.0'}),/PARENT_REQUIRED/);
  await assert.rejects(f.control.set('parent',{id:'learning.english',
   enabled:false,expectedVersion:'0.1.0'}),/SKILL_VERSION_REVIEW_REQUIRED/);
  await assert.rejects(f.control.set('parent',{id:'nonexistent.skill',
   enabled:false,expectedVersion:'1.0.0'}),/UNKNOWN_SKILL/);
  assert.throws(()=>f.control.set('parent',{id:'learning.english',
   enabled:'false',expectedVersion:'0.2.0'}),/INVALID_SKILL_GOVERNANCE_UPDATE/);
  assert.equal(f.core.skills.list().find(x=>x.id==='learning.english').enabled,true);
 }finally{await f.close();}
});
test('R31 repeated and concurrently queued parent updates retain last decision',async()=>{
 const f=await fixture();try{
  const results=await Promise.all([
   f.control.set('parent',{id:'story.interactive',enabled:false,expectedVersion:'0.2.0'}),
   f.control.set('parent',{id:'story.interactive',enabled:true,expectedVersion:'0.2.0'}),
   f.control.set('parent',{id:'story.interactive',enabled:false,expectedVersion:'0.2.0'})
  ]);
  assert.deepEqual(results.map(r=>r.changed),[true,true,true]);
  const data=JSON.parse(await readFile(f.file,'utf8'));
  assert.equal(data.entries.find(e=>e.id==='story.interactive').enabled,false);
  assert.equal(f.core.skills.list().find(e=>e.id==='story.interactive').enabled,false);
 }finally{await f.close();}
});
test('R31 corrupt or mismatched persisted Skill version fails closed on boot',async()=>{
 const f=await fixture();try{
  await f.control.set('parent',{id:'quiz.science',enabled:false,expectedVersion:'0.1.0'});
  const doc=JSON.parse(await readFile(f.file,'utf8'));
  doc.entries[0].version='99.0.0';
  await writeFile(f.file,JSON.stringify(doc));
  const core=new HomeCore(),restarted=new SkillGovernance({file:f.file,registry:core.skills});
  await assert.rejects(restarted.load(),/SKILL_VERSION_REVIEW_REQUIRED/);
  assert.equal(core.skills.list().every(s=>s.enabled),true);
  doc.entries[0].version='0.2.0';doc.entries[1].id=doc.entries[0].id;
  await writeFile(f.file,JSON.stringify(doc));
  await assert.rejects(restarted.load(),/INVALID_SKILL_GOVERNANCE_STATE/);
 }finally{await f.close();}
});
test('R31 registry rejects untrusted upgrade downgrades and preserves disabled policy',()=>{
 const core=new HomeCore(),skills=core.skills;
 skills.setEnabled('story.interactive',false,'parent');
 const manifest={...skills.list().find(s=>s.id==='story.interactive'),version:'0.3.0'};
 const upgraded=skills.upgradeTrusted({manifest,execute:()=>({ok:true,message:'new trusted version'})},'parent');
 assert.equal(upgraded.version,'0.3.0');assert.equal(upgraded.enabled,false);
 assert.equal(skills.invoke('story.interactive','parent').ok,false);
 assert.throws(()=>skills.upgradeTrusted({manifest:{...manifest,version:'0.2.0'},
  execute:()=>({ok:true,message:'downgrade'})},'parent'),/SKILL_VERSION_NOT_NEWER/);
 assert.throws(()=>skills.upgradeTrusted({manifest:{...manifest,version:'1.0.0'},
  execute:()=>({ok:true,message:'child'})},'child'),/PARENT_REQUIRED/);
});
