// R33 read-only usage projection. This is not a grant and never invokes a Skill.
import {PLAN_TEMPLATES} from './plan-orchestrator.mjs';
import {WORKFLOW_RECIPES} from './workflow-orchestrator.mjs';
import {courseCatalog} from './skill-curriculum.mjs';

const copy=structuredClone;
const ref=(kind,resourceId,skillId,details={})=>({kind,resourceId,skillId,...details});
export function projectSkillUsage({skills,plans,workflows,learningPlans,packages}={}){
 if(!skills||typeof skills.list!=='function'||!plans||!workflows||!learningPlans||!packages)
  throw Error('INVALID_SKILL_AUDIT_CONFIG');
 const installed=new Map(packages.installed.map(x=>[x.id,x.version]));
 const trusted=new Map(skills.list().map(s=>[s.id,s]));
 const refs=[];
 // Template relationships are declared code references, not runtime execution.
 for(const [templateId,nodes] of Object.entries(PLAN_TEMPLATES))
  for(const step of nodes.filter(s=>s.kind==='skill'))
   refs.push(ref('plan-template',templateId,step.skillId,{stepId:step.id,source:'declared'}));
 for(const [recipeId,recipe] of Object.entries(WORKFLOW_RECIPES))
  refs.push(ref('workflow-recipe',recipeId,recipe.skillId,{source:'declared'}));
 for(const course of courseCatalog())
  if(typeof course.skillId==='string')
   refs.push(ref('learning-course',course.id,course.skillId,{source:'declared'}));
 // Persisted records are real orchestration references; status is not proof of execution.
 for(const plan of plans.list()){
  const nodes=PLAN_TEMPLATES[plan.templateId]??[];
  for(const step of nodes.filter(s=>s.kind==='skill'))
   refs.push(ref('plan',plan.id,step.skillId,{status:plan.status,stepId:step.id,source:'persisted'}));
 }
 for(const workflow of workflows.list()){
  const recipe=WORKFLOW_RECIPES[workflow.recipe];
  if(recipe)refs.push(ref('workflow',workflow.id,recipe.skillId,{status:workflow.status,source:'persisted'}));
 }
 for(const plan of learningPlans.list('parent')){
  const course=courseCatalog().find(c=>c.id===plan.courseId);
  if(course?.skillId)
   refs.push(ref('learning',plan.id,course.skillId,{status:plan.status,source:'persisted'}));
 }
 // Explicit metadata associations from R32 are displayed separately from verified runtime references.
 const declared=packages.references.map(r=>ref('package-'+r.kind,r.resourceId,r.skillId,{
  version:r.version,source:'parent-declared-unverified'
 }));
 const annotate=r=>{
  const skill=trusted.get(r.skillId);
  const installedVersion=installed.get(r.skillId);
  return {...r,version:r.version??skill?.version??installedVersion??null,
   provenance:skill?'trusted-builtin':installedVersion?'metadata-installed':'unknown',
   enabled:skill?.enabled??false,
   executable:!!skill};
 };
 const runtime=refs.map(annotate);
 const explicit=declared.map(annotate);
 return copy({schemaVersion:1,generatedFrom:'current-server-state',
  runtime,explicit,
  counts:{runtime:runtime.length,explicit:explicit.length},
  note:'Declared templates and persisted job references are not evidence of execution. Metadata-only packages never execute.'});
}
