import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSkillUsage} from '../scripts/skill-usage-audit.mjs';

const skills={list:()=>[
 {id:'learning.english',version:'0.2.0',enabled:false},
 {id:'story.interactive',version:'0.2.0',enabled:true},
 {id:'quiz.science',version:'0.1.0',enabled:true}
]};
const stub=x=>({list:()=>structuredClone(x)});
test('R33 discovers declared templates, workflow recipes and learning courses without claiming execution',()=>{
 const a=projectSkillUsage({skills,plans:stub([]),workflows:stub([]),learningPlans:stub([]),
  packages:{installed:[],references:[]}});
 assert.ok(a.runtime.some(x=>x.kind==='plan-template'&&x.skillId==='learning.english'&&x.source==='declared'));
 assert.ok(a.runtime.some(x=>x.kind==='workflow-recipe'&&x.skillId==='story.interactive'));
 assert.ok(a.runtime.some(x=>x.kind==='learning-course'&&x.skillId==='quiz.science'));
 assert.ok(a.runtime.some(x=>x.skillId==='learning.english'&&x.enabled===false));
 assert.ok(a.runtime.every(x=>x.executable&&x.provenance==='trusted-builtin'));
});
test('R33 distinguishes persisted job references from manually claimed package metadata references',()=>{
 const a=projectSkillUsage({
  skills,
  plans:stub([{id:'plan-1',templateId:'learn.at.desk',status:'stopped'}]),
  workflows:stub([{id:'wf-1',recipe:'story.corner',status:'succeeded'}]),
  learningPlans:stub([{id:'lp-1',courseId:'english.a1.intro',status:'paused'}]),
  packages:{installed:[{id:'vendor.catalog',version:'1.0.0'}],
   references:[{kind:'plan',resourceId:'plan-claimed',skillId:'vendor.catalog',version:'1.0.0'}]}
 });
 assert.ok(a.runtime.some(x=>x.kind==='plan'&&x.resourceId==='plan-1'&&x.status==='stopped'));
 assert.ok(a.runtime.some(x=>x.kind==='workflow'&&x.resourceId==='wf-1'&&x.status==='succeeded'));
 assert.ok(a.runtime.some(x=>x.kind==='learning'&&x.resourceId==='lp-1'));
 const fake=a.explicit[0];
 assert.equal(fake.source,'parent-declared-unverified');
 assert.equal(fake.provenance,'metadata-installed');
 assert.equal(fake.executable,false);
 assert.equal(a.runtime.some(x=>x.skillId==='vendor.catalog'),false);
});
test('R33 rejects missing audit dependencies rather than synthesizing usage',()=>{
 assert.throws(()=>projectSkillUsage({skills}),/INVALID_SKILL_AUDIT_CONFIG/);
});
