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
 // 取消处理器彼此独立：一个供应商出错不能阻止其他音频和模型任务终止。
 // 收集全部失败并抛出 AggregateError，既执行完整清理，也不吞掉异常。
 const steps=[
  ['auth',()=>auth.revokeLearner(profileId)],
  ['chat',()=>abortCompanion(principal)],
  ['audio-gate',()=>audioGate.cancel(principal)],
  ['audio-ingress',()=>audioIngress.erasePrincipal(principal)],
  ...(realtimeSessions?[['realtime',()=>realtimeSessions.erasePrincipal(principal)]]:[]),
  ...(speechPlayback?[['speech',()=>speechPlayback.erasePrincipal(principal)]]:[]),
  ...(voiceTurns?[['voice-turn',()=>voiceTurns.erasePrincipal(principal)]]:[])
 ];
 let revokedSessions=0;
 const errors=[];
 for(const [name,run] of steps){
  try{const result=run();if(name==='auth')revokedSessions=result;}
  catch(error){errors.push({name,error});}
 }
 if(errors.length)throw new AggregateError(errors.map(x=>x.error),
  'LEARNER_RUNTIME_REVOCATION_INCOMPLETE');
 return {revokedSessions,principalStopped:true};
}
