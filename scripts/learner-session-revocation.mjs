// R45 独立学习者凭据撤销：在注销会话的同一请求中终止所有已知活动。
// 仅针对指定 profile；共享儿童、其他孩子及家长不受影响。
export function revokeLearnerRuntime({
 profileId,auth,abortCompanion,audioGate,audioIngress,realtimeSessions,
 speechPlayback,voiceTurns
}={}){
 if(typeof profileId!=='string'||!/^profile-[0-9a-f-]{36}$/.test(profileId))
  throw Error('INVALID_LEARNER_PROFILE');
 if(typeof auth?.revokeLearner!=='function'||
  typeof abortCompanion!=='function'||
  typeof audioGate?.cancel!=='function'||
  typeof audioIngress?.erasePrincipal!=='function')
  throw Error('INVALID_LEARNER_REVOCATION_CONFIG');
 const principal='learner:'+profileId;
 const revokedSessions=auth.revokeLearner(profileId);
 // 先取消正在进行的模型请求，再销毁录音及播放上下文。
 abortCompanion(principal);
 audioGate.cancel(principal);
 audioIngress.erasePrincipal(principal);
 realtimeSessions?.erasePrincipal(principal);
 speechPlayback?.erasePrincipal(principal);
 voiceTurns?.erasePrincipal(principal);
 return {revokedSessions,principalStopped:true};
}
