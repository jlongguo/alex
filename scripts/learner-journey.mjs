// R46 学习旅程只读投影：复用已有会话、计划和证据账本，不复制原文。
const profile=/^profile-[0-9a-f-]{36}$/;
export function projectLearnerJourney({principal,sessions,plans,progress}={}){
 if(typeof principal!=='string'||!/^learner:profile-[0-9a-f-]{36}$/.test(principal)||
  !Array.isArray(sessions)||!Array.isArray(plans)||
  !progress||!progress.byCourse||typeof progress.byCourse!=='object')
  throw Error('INVALID_LEARNER_JOURNEY');
 const id=principal.slice('learner:'.length);
 const ownPlans=plans.map(p=>{
  if(!p||p.profileId!==id||typeof p.courseId!=='string'||
   !Number.isSafeInteger(p.targetCompletions)||p.targetCompletions<1)
   throw Error('LEARNER_JOURNEY_SCOPE_MISMATCH');
  const count=progress.byCourse[p.courseId]??0;
  if(!Number.isSafeInteger(count)||count<0)throw Error('INVALID_LEARNER_JOURNEY');
  return {courseId:p.courseId,status:p.status,
   targetCompletions:p.targetCompletions,completed:count,
   remaining:Math.max(0,p.targetCompletions-count),
   goalReached:count>=p.targetCompletions};
 });
 const ownSessions=sessions.map(s=>{
  if(!s||typeof s.id!=='string'||typeof s.mode!=='string'||
   typeof s.updatedAt!=='string'||!Number.isSafeInteger(s.turns)||
   s.turns<0)throw Error('INVALID_LEARNER_JOURNEY');
  return {id:s.id,mode:s.mode,updatedAt:s.updatedAt,turns:s.turns};
 });
 ownSessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const active=ownPlans.filter(p=>p.status==='active'&&!p.goalReached);
 return structuredClone({
  schemaVersion:'alex.dev/learner-journey/v1',principal,
  sessions:ownSessions.slice(0,16),plans:ownPlans,
  recentSessionId:ownSessions[0]?.id??null,
  nextCourseId:active[0]?.courseId??null,
  completedTextExercises:ownPlans.reduce((n,p)=>n+p.completed,0),
  textOnly:true,deviceControlAllowed:false,
  audioEvidenceVerified:false,physicalMovementVerified:false,
  readOnly:true,
  note:'仅记录文字练习、会话和任务元数据，不代表口语熟练度或真实机器人动作'
 });
}
