import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {courseCatalog,courseById,coursesForMode,resolveCourse,exerciseReply} from '../scripts/skill-curriculum.mjs';
import {CompanionConversations} from '../scripts/companion-conversations.mjs';
import {LearningPlans} from '../scripts/learning-plans.mjs';

const a='learner:profile-11111111-1111-4111-8111-111111111111';
const b='learner:profile-22222222-2222-4222-8222-222222222222';

test('R4 trusted Skill curriculum is versioned, filtered and cannot execute untrusted lesson IDs',()=>{
 const courses=courseCatalog();
 assert.equal(courses.length,5);
 assert.equal(coursesForMode('english').length,3);
 assert.equal(coursesForMode('story').length,1);
 assert.equal(coursesForMode('quiz').length,1);
 for(const item of courses){
  assert.match(item.version,/^\d+\.\d+\.\d+$/);
  assert.ok(item.targetStep>=3);
  assert.ok(item.objectives.length>=1);
  assert.ok(item.description);
  assert.equal(resolveCourse(item.mode,item.id).id,item.id);
  assert.equal(courseById(item.id).skillId,item.skillId);
 }
 courses[0].title='Poisoned client copy';
 assert.notEqual(courseCatalog()[0].title,'Poisoned client copy');
 assert.throws(()=>resolveCourse('english','story.library.choice'),/INVALID_LESSON_SELECTION/);
 assert.throws(()=>resolveCourse('chat','english.a1.intro'),/CHAT_HAS_NO_LESSON/);
 assert.throws(()=>resolveCourse('english','javascript:alert(1)'),/INVALID_LESSON_SELECTION/);
});

test('R4 English greetings and daily routine really require the expected text steps',async()=>{
 const hub=new CompanionConversations();
 const g=await hub.open(a,'english',{lessonId:'english.a1.greetings'});
 assert.match(g.messages[0].text,/Hello, Alex/i);
 assert.equal(g.lessonId,'english.a1.greetings');
 let turn=await hub.turn(a,g.id,'Hi there');
 assert.equal(turn.session.step,0);
 turn=await hub.turn(a,g.id,'Hello Alex');
 assert.equal(turn.session.step,1);
 turn=await hub.turn(a,g.id,'fine');
 assert.equal(turn.session.step,1);
 turn=await hub.turn(a,g.id,'I am fine.');
 assert.equal(turn.session.step,2);
 turn=await hub.turn(a,g.id,'Thank you.');
 assert.equal(turn.session.step,3);
 assert.equal(turn.learningEvidence.lessonId,'english.a1.greetings');
 assert.equal(turn.learningEvidence.kind,'english_a1_text');
 assert.equal(hub.progress(a).byCourse['english.a1.greetings'],1);
 await hub.turn(a,g.id,'other');
 assert.equal(hub.progress(a).byCourse['english.a1.greetings'],1);
 await hub.turn(a,g.id,'restart');
 for(const answer of ['Hello!','I am good','thank you']){
  const event=await hub.turn(a,g.id,answer);
  assert.ok(event.assistant.text.length>2);
 }
 assert.equal(hub.progress(a).byCourse['english.a1.greetings'],2);
 const d=await hub.open(a,'english',{lessonId:'english.a1.daily'});
 assert.match(d.messages[0].text,/wake up early/);
 for(const answer of ['I wake up early','I eat breakfast','I go to school','I go to bed']){
  const event=await hub.turn(a,d.id,answer);
  assert.equal(event.source,'offline');
 }
 assert.equal(hub.progress(a).byCourse['english.a1.daily'],1);
 assert.equal(hub.progress(b).englishTextExercisesCompleted,0);
 assert.equal(hub.progress('child').englishTextExercisesCompleted,0);
 assert.equal(hub.progress('parent','child').englishTextExercisesCompleted,3);
});

test('R4 independent completion evidence survives 16-session rotation and opt-in restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r4-ledger-'));
 const file=join(dir,'sessions.json');
 try{
  const hub=new CompanionConversations({persist:true,file});
  const first=await hub.open(a,'english',{lessonId:'english.a1.greetings'});
  for(const text of ['Hello Alex','I am fine','Thank you'])
   await hub.turn(a,first.id,text);
  assert.equal(hub.progress(a).englishTextExercisesCompleted,1);
  for(let i=0;i<22;i++)await hub.open(a,'story');
  assert.equal(hub.list(a).length,16);
  assert.equal(hub.list(a).some(x=>x.id===first.id),false);
  assert.equal(hub.progress(a).englishTextExercisesCompleted,1,
    'auto rotating transcripts must not erase independent progress');
  const restored=new CompanionConversations({persist:true,file});
  await restored.load();
  assert.equal(restored.progress(a).byCourse['english.a1.greetings'],1);
  assert.equal(restored.list(a).length,16);
  await restored.eraseLearner('parent',a.slice('learner:'.length));
  assert.equal(restored.progress(a).englishTextExercisesCompleted,0);
  const erased=new CompanionConversations({persist:true,file});
  await erased.load();
  assert.equal(erased.progress('parent','child').englishTextExercisesCompleted,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R4 explicit delete removes its evidence, while model prose never generates evidence',async()=>{
 const hub=new CompanionConversations();
 const s=await hub.open(a,'story');
 for(const text of ['A','B','A'])await hub.turn(a,s.id,text);
 assert.equal(hub.progress(a).storyBranchesCompleted,1);
 await hub.remove(a,s.id);
 assert.equal(hub.progress(a).storyBranchesCompleted,0);
 const provider={reply:async()=> 'You completed all lessons successfully!'};
 const online=new CompanionConversations({provider});
 const l=await online.open(a,'english',{lessonId:'english.a1.greetings'});
 for(let i=0;i<8;i++)await online.turn(a,l.id,'Hello');
 assert.deepEqual(online.progress(a).byCourse,{});
 assert.equal(online.progress(a).englishTextExercisesCompleted,0);
});

test('R4 old session milestones migrate exactly once into new separate evidence ledger',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r4-migrate-'));
 const file=join(dir,'sessions.json');
 try{
  const old=new CompanionConversations({persist:true,file});
  const session=await old.open(a,'english');
  for(const text of ['Nickname','I like pizza','I like green','I can swim','I am fine'])
   await old.turn(a,session.id,text);
  const snapshot=JSON.parse(await readFile(file,'utf8'));
  delete snapshot.evidence;
  for(const entry of snapshot.sessions){delete entry.lessonId;delete entry.lessonVersion;}
  await writeFile(file,JSON.stringify(snapshot),'utf8');
  const migrated=new CompanionConversations({persist:true,file});
  await migrated.load();
  assert.equal(migrated.progress(a).byCourse['english.a1.intro'],1);
  const extras=await migrated.open(a,'story');
  assert.equal(extras.lessonId,'story.library.choice');
  const again=new CompanionConversations({persist:true,file});
  await again.load();
  assert.equal(again.progress(a).byCourse['english.a1.intro'],1);
  await again.turn(a,session.id,'again'); // restart, not additional completion
  assert.equal(again.progress(a).byCourse['english.a1.intro'],1);
  const invalid=JSON.parse(await readFile(file,'utf8'));
  invalid.evidence[0].principal=b;
  await writeFile(file,JSON.stringify(invalid),'utf8');
  const poisoned=new CompanionConversations({persist:true,file});
  // A forged child owner must not receive another learner's evidence even
  // though both principals have the same generic "child" role.
  await assert.rejects(()=>poisoned.load(),/INVALID_LEARNING_EVIDENCE_FILE/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R4 parent learning plans are typed, per learner and survive restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r4-plans-'));
 const file=join(dir,'plans.json');
 try{
  const store=new LearningPlans(file);
  const profile=a.slice('learner:'.length),profileB=b.slice('learner:'.length);
  await assert.rejects(()=>store.assign('child',{profileId:profile,courseId:'english.a1.greetings'},()=>true),/PARENT_REQUIRED/);
  await assert.rejects(()=>store.assign('parent',{profileId:profile,courseId:'wrong'},()=>true),/UNKNOWN_COURSE/);
  await assert.rejects(()=>store.assign('parent',{profileId:profile,courseId:'english.a1.greetings'},()=>false),/UNKNOWN_LEARNER_PROFILE/);
  await assert.rejects(()=>store.assign('parent',{profileId:profile,courseId:'english.a1.greetings',targetCompletions:0},()=>true),/INVALID_LEARNING_TARGET/);
  const one=await store.assign('parent',{profileId:profile,courseId:'english.a1.greetings',targetCompletions:3},()=>true);
  const two=await store.assign('parent',{profileId:profileB,courseId:'english.a1.daily',targetCompletions:2},()=>true);
  assert.notEqual(one.id,two.id);
  const changed=await store.assign('parent',{profileId:profile,courseId:'english.a1.greetings',targetCompletions:4},()=>true);
  assert.equal(one.id,changed.id);
  assert.equal(store.list(a).length,1);
  assert.equal(store.list(b).length,1);
  assert.equal(store.list('parent').length,2);
  assert.throws(()=>store.list(a,profileB),/LEARNING_PLANS_FORBIDDEN/);
  assert.throws(()=>store.list('child'),/LEARNING_PLANS_AUTH_REQUIRED/);
  await store.changeStatus('parent',one.id,'paused');
  assert.equal(store.list(a)[0].status,'paused');
  const restored=new LearningPlans(file);
  await restored.load();
  assert.equal(restored.list(a)[0].targetCompletions,4);
  await restored.changeStatus('parent',one.id,'active');
  assert.equal(restored.list(a)[0].status,'active');
  assert.equal(await restored.removeProfile('parent',profile),1);
  assert.equal(restored.list(a).length,0);
  assert.equal(await restored.eraseForPrivacy('parent','child'),1);
  assert.equal(restored.list('parent').length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R4 transcript/evidence atomic snapshot stays unchanged on persistence failure',async()=>{
 const hub=new CompanionConversations({persist:true,file:join(tmpdir(),randomUUID(),'sessions.json')});
 const session=await hub.open(a,'english',{lessonId:'english.a1.greetings'});
 const previous=hub.get(a,session.id);
 hub.store.save=async()=>{throw new Error('SIMULATED_DISK_FAILURE');};
 await assert.rejects(()=>hub.turn(a,session.id,'Hello Alex'),/SIMULATED_DISK_FAILURE/);
 assert.deepEqual(hub.get(a,session.id),previous);
 assert.equal(hub.progress(a).englishTextExercisesCompleted,0);
});


test('R4 quiz is a separate safe text Skill with checked choices and evidence',async()=>{
 const hub=new CompanionConversations();
 const s=await hub.open(a,'quiz',{lessonId:'science.everyday.discovery'});
 assert.equal(s.mode,'quiz');
 assert.equal(s.lessonId,'science.everyday.discovery');
 assert.match(s.messages[0].text,/植物/);
 let step=await hub.turn(a,s.id,'B');
 assert.equal(step.session.step,0);
 for(const answer of ['A','选A','左']){
   step=await hub.turn(a,s.id,answer);
   assert.equal(step.source,'offline');
 }
 assert.equal(step.session.step,3);
 assert.equal(step.learningEvidence.kind,'science_quiz_text');
 assert.equal(hub.progress(a).scienceTextQuizzesCompleted,1);
 assert.equal(hub.progress(a).englishTextExercisesCompleted,0);
 await hub.turn(a,s.id,'重新开始');
 assert.equal(hub.get(a,s.id).step,0);
 await hub.remove(a,s.id);
 assert.equal(hub.progress(a).scienceTextQuizzesCompleted,0);
});
