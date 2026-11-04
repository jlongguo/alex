import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const cwd=resolve(import.meta.dirname,'..');
async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{
   cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw new Error('Alex failed to start: '+child.exitCode);
  try{const res=await fetch(base+'/api/health');if(res.ok)return {base,child};}catch{}
  await new Promise(resolve=>setTimeout(resolve,70));
 }
 child.kill('SIGTERM');throw new Error('Alex startup timeout');
}
async function post(base,path,payload,cookie){
 const res=await fetch(base+path,{method:'POST',
  headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
  body:JSON.stringify(payload)});
 return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const res=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{},cache:'no-store'});
 return {status:res.status,data:await res.json()};
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('R4 live HTTP: parent assigns versioned course, child has isolated goals, completes quiz and parent sees result', {timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r4-http-'));
 const env={
  PORT:String(50000+Math.floor(Math.random()*7500)),
  AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'some-very-long-parent-test-password',
  ALEX_CHILD_PIN:'698726',AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_CONVERSATION_PERSIST:'1',ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning-plans.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);
  const base=server.base;
  assert.equal((await get(base,'/api/learning/catalog')).status,401);
  const parent=(await post(base,'/api/auth/login',{
    role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const legacy=(await post(base,'/api/auth/login',{
    role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
  const courses=await get(base,'/api/learning/catalog',legacy);
  assert.equal(courses.status,200);
  assert.equal(courses.data.courses.length,5);
  assert.ok(courses.data.courses.some(x=>x.id==='science.everyday.discovery'));
  const profileA=(await post(base,'/api/profiles',{
    nickname:'Reader',ageBand:'6-8',interests:[]},parent)).data.profile;
  const profileB=(await post(base,'/api/profiles',{
    nickname:'Explorer',ageBand:'9-12',interests:[]},parent)).data.profile;
  const aCred=(await post(base,'/api/learners/set-pin',{
    profileId:profileA.id,pin:'538291'},parent)).data.learner;
  const bCred=(await post(base,'/api/learners/set-pin',{
    profileId:profileB.id,pin:'618291'},parent)).data.learner;
  const learnerA=(await post(base,'/api/auth/login',{
    role:'learner',code:aCred.code,secret:'538291'})).cookie;
  const learnerB=(await post(base,'/api/auth/login',{
    role:'learner',code:bCred.code,secret:'618291'})).cookie;
  const req={profileId:profileA.id,courseId:'science.everyday.discovery',targetCompletions:2};
  assert.equal((await post(base,'/api/learning/assign',req,learnerA)).status,403);
  assert.equal((await post(base,'/api/learning/assign',req,legacy)).status,403);
  assert.equal((await post(base,'/api/learning/assign',
    {...req,courseId:'unknown-course'},parent)).status,400);
  const saved=await post(base,'/api/learning/assign',req,parent);
  assert.equal(saved.status,200);
  assert.equal(saved.data.plan.targetCompletions,2);
  const planId=saved.data.plan.id;
  assert.equal((await get(base,'/api/learning/plans',learnerA)).data.plans.length,1);
  assert.equal((await get(base,'/api/learning/plans',learnerB)).data.plans.length,0);
  assert.equal((await get(base,'/api/learning/plans',legacy)).data.plans.length,0);
  assert.equal((await get(base,'/api/learning/plans?profileId='+profileA.id,learnerB)).status,403);
  assert.equal((await get(base,'/api/learning/overview?profileId='+profileA.id,learnerB)).status,403);
  assert.equal((await get(base,'/api/learning/overview',learnerA)).data.overview[0].completed,0);
  const open=await post(base,'/api/skills/invoke',{
    id:'quiz.science',lessonId:'science.everyday.discovery'},learnerA);
  assert.equal(open.status,200);
  assert.equal(open.data.session.mode,'quiz');
  const id=open.data.session.id;
  assert.equal(open.data.session.principal,'learner:'+profileA.id);
  assert.equal((await post(base,'/api/companion/turn',{id,text:'B'},learnerA)).data.session.step,0);
  for(const text of ['A','A','A']){
   const answer=await post(base,'/api/companion/turn',{id,text},learnerA);
   assert.equal(answer.status,200);
  }
  const progressA=await get(base,'/api/companion/progress?scope=self',learnerA);
  assert.equal(progressA.data.progress.scienceTextQuizzesCompleted,1);
  assert.equal(progressA.data.progress.byCourse['science.everyday.discovery'],1);
  assert.equal((await get(base,'/api/companion/progress?scope=self',learnerB)).data.progress.scienceTextQuizzesCompleted,0);
  const view=(await get(base,'/api/learning/overview?profileId='+profileA.id,parent)).data.overview;
  assert.equal(view.length,1);
  assert.equal(view[0].completed,1);
  assert.equal(view[0].remaining,1);
  assert.equal(view[0].goalReached,false);
  assert.equal(view[0].textExerciseOnly,true);
  // Repeat the same script from the same learner. A second verified
  // completion reaches the plan without claiming an actual science grade.
  await post(base,'/api/companion/turn',{id,text:'重新开始'},learnerA);
  for(const text of ['A','A','A'])
   assert.equal((await post(base,'/api/companion/turn',{id,text},learnerA)).status,200);
  assert.equal((await get(base,'/api/learning/overview?profileId='+profileA.id,parent)).data.overview[0].goalReached,true);
  assert.equal((await get(base,'/api/learning/overview?profileId='+profileA.id,parent)).data.overview[0].remaining,0);
  const denied=await get(base,'/api/companion/session?id='+id,learnerB);
  assert.equal(denied.status,400);
  const legacyCross=await get(base,'/api/companion/session?id='+id,legacy);
  assert.equal(legacyCross.status,400);
  const paused=await post(base,'/api/learning/change',{id:planId,status:'paused'},parent);
  assert.equal(paused.data.plan.status,'paused');
  assert.equal((await post(base,'/api/learning/change',{id:planId,status:'active'},learnerA)).status,403);
  const exported=await get(base,'/api/privacy/export',parent);
  assert.equal(exported.status,200);
  assert.equal(exported.data.learningEvidence.length,2);
  assert.equal(exported.data.learningPlans.length,1);
  assert.ok(exported.data.learningEvidence.every(x=>x.principal==='learner:'+profileA.id));
  assert.equal((await get(base,'/api/privacy/export',learnerB)).status,403);
  const jobs=await get(base,'/api/gateway/jobs',parent);
  assert.equal(jobs.data.jobs.length,0,'scripted quiz must never dispatch virtual-device jobs');

  server.child.kill('SIGTERM');await once(server.child,'exit');server=null;
  const next=await boot(env);server=next;
  const newParent=(await post(next.base,'/api/auth/login',{
    role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  assert.equal((await get(next.base,'/api/learning/overview',newParent)).data.overview[0].completed,2);
  const erase=await post(next.base,'/api/privacy/erase',{scope:'child'},newParent);
  assert.equal(erase.status,200);
  assert.equal(erase.data.deletedLearningPlans,1);
  assert.equal((await get(next.base,'/api/learning/plans',newParent)).data.plans.length,0);
  assert.equal((await get(next.base,'/api/companion/progress?scope=child',newParent)).data.progress.scienceTextQuizzesCompleted,0);
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});

test('R4 live HTTP: parent profile deletion removes assigned goals and learner evidence', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r4-delete-'));
 const env={
  PORT:String(50000+Math.floor(Math.random()*7500)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'another-long-parent-test-password',ALEX_CHILD_PIN:'123456',
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning.json'),
  ALEX_CONVERSATION_PERSIST:'1',ALEX_CONVERSATION_FILE:join(dir,'chat.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credential.json'),AGENT_PROVIDER:'rules',
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);
  const base=server.base;
  const parent=(await post(base,'/api/auth/login',{
    role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const profile=(await post(base,'/api/profiles',{
    nickname:'Learner',ageBand:'6-8',interests:[]},parent)).data.profile;
  await post(base,'/api/learning/assign',{profileId:profile.id,
    courseId:'english.a1.greetings',targetCompletions:2},parent);
  const credential=(await post(base,'/api/learners/set-pin',{
    profileId:profile.id,pin:'123456'},parent)).data.learner;
  const child=(await post(base,'/api/auth/login',{
    role:'learner',code:credential.code,secret:'123456'})).cookie;
  const opened=await post(base,'/api/companion/open',{mode:'english',lessonId:'english.a1.greetings'},child);
  assert.equal(opened.status,200);
  for(const text of ['Hello Alex','I am fine','Thank you'])
   assert.equal((await post(base,'/api/companion/turn',{id:opened.data.session.id,text},child)).status,200);
  assert.equal((await get(base,'/api/learning/overview',parent)).data.overview[0].completed,1);
  assert.equal((await post(base,'/api/profiles/delete',{id:profile.id},parent)).status,200);
  assert.equal((await get(base,'/api/learning/plans',parent)).data.plans.length,0);
  assert.equal((await get(base,'/api/companion/progress?scope=child',parent)).data.progress.englishTextExercisesCompleted,0);
  assert.equal((await get(base,'/api/auth/session',child)).data.authenticated,false);
  assert.equal((await get(base,'/api/learning/overview',parent)).data.overview.length,0);
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
