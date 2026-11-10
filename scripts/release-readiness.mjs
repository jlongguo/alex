// R42 只读发布候选检查：既不修改配置，也不将静态检查冒充真实验收。
// 报告不包含密码、密钥、会话、学习档案或任何儿童个人信息。
const fail=code=>{throw Error(code);};
const nonNegative=v=>Number.isSafeInteger(v)&&v>=0;
const check=(id,category,status,detail)=>({id,category,status,detail});
export function evaluateReleaseReadiness({
 authMode,childLoginEnabled,profileCount,skillReconciliation,
 singleWal,batchWal,audioConfigured,conversationProvider,
 writerLockHeld,rosRuntimeVerified=false,
 voiceEndToEndVerified=false,childJourneyVerified=false,
 recoveryDrillVerified=false
}={}){
 if(!['local','demo'].includes(authMode)||typeof childLoginEnabled!=='boolean'||
  !nonNegative(profileCount)||!skillReconciliation||
  !['consistent','needs-review'].includes(skillReconciliation.status)||
  !Array.isArray(skillReconciliation.findings)||
  !singleWal||!batchWal||
  !nonNegative(singleWal.pending)||!nonNegative(batchWal.pending)||
  !nonNegative(singleWal.remaining)||!nonNegative(batchWal.remaining)||
  typeof audioConfigured!=='boolean'||
  typeof conversationProvider!=='string'||!conversationProvider||
  typeof writerLockHeld!=='boolean'||
  [rosRuntimeVerified,voiceEndToEndVerified,childJourneyVerified,recoveryDrillVerified]
   .some(value=>typeof value!=='boolean'))
  fail('INVALID_RELEASE_READINESS_CONTEXT');

 const findings=[
  check('AUTH_LOCAL_REQUIRED','security',authMode==='local'?'pass':'blocked',
   '正式家庭试用必须使用本地认证；demo 只能用于开发演示'),
  check('CHILD_LOGIN_REQUIRED','onboarding',childLoginEnabled?'pass':'blocked',
   '必须配置独立儿童登录凭据，并验证家长/儿童权限边界'),
  check('LEARNER_PROFILE_REQUIRED','onboarding',profileCount>0?'pass':'blocked',
   '至少创建一个年龄段档案，不读取儿童档案内容'),
  check('WRITER_OWNERSHIP_REQUIRED','storage',writerLockHeld?'pass':'blocked',
   '检查本实例是否持有本地独占写入租约'),
  check('SKILL_STORE_INTEGRITY','storage',skillReconciliation.status==='consistent'&&
   skillReconciliation.findings.length===0?'pass':'blocked',
   '跨存储发现 '+skillReconciliation.findings.length+' 项一致性问题'),
  check('SINGLE_WAL_RECOVERY_CLEAR','storage',singleWal.pending===0?'pass':'blocked',
   '单包 WAL 待处理 '+singleWal.pending+' 项'),
  check('BATCH_WAL_RECOVERY_CLEAR','storage',batchWal.pending===0?'pass':'blocked',
   '批量 WAL 待处理 '+batchWal.pending+' 项'),
  check('SINGLE_WAL_CAPACITY','storage',singleWal.remaining>0?'pass':'blocked',
   '单包 WAL 剩余 '+singleWal.remaining+' 条记录'),
  check('BATCH_WAL_CAPACITY','storage',batchWal.remaining>0?'pass':'blocked',
   '批量 WAL 剩余 '+batchWal.remaining+' 条记录'),
  check('AUDIO_PROVIDER_CONFIGURED','voice',audioConfigured?'pass':'blocked',
   '软件语音试用需配置可用的音频供应商；配置不代表云端实测成功'),
  check('CONVERSATION_PROVIDER_CONFIGURED','voice',
   conversationProvider!=='disabled'?'pass':'blocked',
   '对话供应商必须启用；离线规则模式可用于功能内测，但不能冒充真实大模型'),
  check('VOICE_END_TO_END_ACCEPTANCE','acceptance',
   voiceEndToEndVerified?'pass':'manual-required','真实录音→识别→回复→语音播放尚需独立验收'),
  check('CHILD_JOURNEY_ACCEPTANCE','acceptance',
   childJourneyVerified?'pass':'manual-required','儿童登录、学习、权限拒绝及家长撤销需真实用户旅程验收'),
  check('DATA_RECOVERY_DRILL','acceptance',
   recoveryDrillVerified?'pass':'manual-required','尚需执行备份恢复、异常退出和迁移演练')
 ];
 const blockers=findings.filter(f=>f.status==='blocked').map(f=>f.id);
 const manual=findings.filter(f=>f.status==='manual-required').map(f=>f.id);
 const base={schemaVersion:'alex.dev/release-readiness/v1',target:'software-pilot',
  status:blockers.length?'blocked':manual.length?'manual-validation-required':'checks-complete',
  checks:findings,blockers,manual,readOnly:true,executable:false,
  releaseApproved:false,note:'自动检查通过不能替代人工验收、隐私审核或上线审批'};
 const robot=check('ROS_NAV2_RUNTIME_ACCEPTANCE','robotics',
  rosRuntimeVerified?'pass':'manual-required',
  '真实 Gazebo/Nav2 时钟、TF、导航目标和急停运行验收不属于静态预检');
 return structuredClone({...base,
  robotCandidate:{status:robot.status==='pass'&&
    base.status==='checks-complete'?'manual-release-review':'blocked',
    check:robot,physicalSafetyCertified:false}});
}
