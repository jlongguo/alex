import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLearnerJourney} from '../scripts/learner-journey.mjs';
const A='profile-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='profile-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const principal='learner:'+A;
const base=()=>({principal,sessions:[],plans:[],progress:{byCourse:{}}});
test('R46 空学习者历史不构成已完成任务，更不代表设备安全验收',()=>{
 const report=projectLearnerJourney(base());
 assert.equal(report.recentSessionId,null);
 assert.equal(report.nextCourseId,null);
 assert.equal(report.completedTextExercises,0);
 assert.equal(report.deviceControlAllowed,false);
 assert.equal(report.audioEvidenceVerified,false);
 assert.equal(report.physicalMovementVerified,false);
 assert.equal(report.readOnly,true);
});
test('R46 按真实文字证据计算剩余目标，保留近期可恢复会话 ID',()=>{
 const data={...base(),sessions:[
  {id:'older',mode:'english',updatedAt:'2026-01-01T00:00:00Z',turns:3},
  {id:'newer',mode:'english',updatedAt:'2026-03-01T00:00:00Z',turns:4}],
  plans:[{profileId:A,courseId:'english.a1.intro',status:'active',targetCompletions:3}],
  progress:{byCourse:{'english.a1.intro':2}}};
 const r=projectLearnerJourney(data);
 assert.equal(r.recentSessionId,'newer');
 assert.equal(r.nextCourseId,'english.a1.intro');
 assert.equal(r.plans[0].remaining,1);
 assert.equal(r.completedTextExercises,2);
 assert.ok(!JSON.stringify(r).includes('transcript'));
});
test('R46 已达标或暂停计划不能错误推荐继续学习',()=>{
 const data={...base(),plans:[
  {profileId:A,courseId:'english.a1.intro',status:'active',targetCompletions:2},
  {profileId:A,courseId:'story.library.choice',status:'paused',targetCompletions:3}],
  progress:{byCourse:{'english.a1.intro':3}}};
 const r=projectLearnerJourney(data);
 assert.equal(r.nextCourseId,null);
 assert.equal(r.plans[0].goalReached,true);
 assert.equal(r.plans[0].remaining,0);
});
test('R46 拒绝跨孩子计划与非独立儿童访问',()=>{
 assert.throws(()=>projectLearnerJourney({...base(),principal:'child'}),
  /INVALID_LEARNER_JOURNEY/);
 assert.throws(()=>projectLearnerJourney({...base(),plans:[
  {profileId:B,courseId:'english.a1.intro',status:'active',targetCompletions:1}]}),
  /LEARNER_JOURNEY_SCOPE_MISMATCH/);
});
test('R46 不允许凭无效进度生成正向学习结果',()=>{
 assert.throws(()=>projectLearnerJourney({...base(),plans:[
  {profileId:A,courseId:'english.a1.intro',status:'active',targetCompletions:2}],
  progress:{byCourse:{'english.a1.intro':-1}}}),/INVALID_LEARNER_JOURNEY/);
});
