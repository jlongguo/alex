// R53 浏览器学习会话恢复状态机：不保存对话原文，也不调用设备接口。
// 所有异步结果在提交 DOM 前必须验证身份代际，防止切换儿童后旧响应回写。
(function initializeLearnerResume(global){
 'use strict';
 const ownerPattern=/^learner:profile-[0-9a-f-]{36}$/;
 function createLearnerResumeState(){
  let owner=null,revision=0,recentId=null;
  const sessionIds=new Set();
  const current=(identity,token)=>identity===owner&&token===revision&&
   ownerPattern.test(identity);
  return Object.freeze({
   switchOwner(identity){
    const next=ownerPattern.test(identity??'')?identity:null;
    if(next!==owner){
     owner=next;revision++;recentId=null;sessionIds.clear();
    }
    return revision;
   },
   token(){return revision;},
   current,
   acceptJourney(identity,token,report){
    if(!current(identity,token)||!report||report.principal!==identity||
     !Array.isArray(report.sessions)||report.sessions.length>16)return false;
    const ids=new Set();
    for(const s of report.sessions){
     if(!s||typeof s.id!=='string'||s.id.length>128||
      !/^[a-zA-Z0-9_-]+$/.test(s.id)||ids.has(s.id))return false;
     ids.add(s.id);
    }
    if(report.recentSessionId!==null&&!ids.has(report.recentSessionId))return false;
    recentId=report.recentSessionId;
    sessionIds.clear();
    for(const id of ids)sessionIds.add(id);
    return true;
   },
   latest(identity,token){return current(identity,token)?recentId:null;},
   owns(identity,token,id){return current(identity,token)&&sessionIds.has(id);},
   forget(){
    // 不再允许之前发出的任何异步请求提交会话或学习进度。
    revision++;recentId=null;sessionIds.clear();
   }
  });
 }
 global.AlexLearnerResume=Object.freeze({createLearnerResumeState});
})(window);
