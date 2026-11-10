// R44 家庭首次使用状态投影：只读，不返回儿童昵称、PIN 或身份密钥。
const fail=code=>{throw Error(code);};
export function familyOnboardingStatus({authMode,profiles,learners,privacyRows}={}){
 if(!['local','demo'].includes(authMode)||!Array.isArray(profiles)||
  !Array.isArray(learners)||!Array.isArray(privacyRows))fail('INVALID_FAMILY_ONBOARDING');
 const credentials=new Set(learners.map(x=>x.profileId));
 const privacy=new Map(privacyRows.map(x=>[x.profileId,x.preferences]));
 const learnersState=profiles.map(profile=>{
  if(!profile||typeof profile.id!=='string')fail('INVALID_FAMILY_ONBOARDING');
  const prefs=privacy.get(profile.id);
  const granted=prefs&&[prefs.voiceInputAllowed,prefs.voiceOutputAllowed,
   prefs.cloudTextAllowed,prefs.cloudAudioInputAllowed,prefs.cloudAudioOutputAllowed].some(Boolean);
  return {profileId:profile.id,hasCredential:credentials.has(profile.id),
   privacyReviewed:privacy.has(profile.id),anyCloudGrant:!!(prefs&&[
    prefs.cloudTextAllowed,prefs.cloudAudioInputAllowed,prefs.cloudAudioOutputAllowed].some(Boolean)),
   hasAnyConsent:!!granted};
 });
 const steps=[
  {id:'parent-auth',done:authMode==='local',
   detail:'使用本地家长身份；演示模式不可完成真实家庭初始化'},
  {id:'create-profile',done:learnersState.length>0,
   detail:'至少建立一个年龄段档案，不需要收集生日'},
  {id:'learner-credential',done:learnersState.some(x=>x.hasCredential),
   detail:'为学习者设置独立 PIN，保存登录代码'},
  {id:'privacy-review',done:learnersState.some(x=>x.hasCredential&&x.privacyReviewed),
   detail:'核对学习语言、节奏及隐私授权，云端权限默认拒绝'}
 ];
 const next=steps.find(x=>!x.done)?.id??null;
 return structuredClone({schemaVersion:'alex.dev/family-onboarding/v1',
  status:next?'incomplete':'configured',nextStep:next,
  steps,learners:learnersState,complete:next===null,
  readOnly:true,deviceProvisioned:false,voiceVerified:false,
  note:'完成本地配置不证明云端语音、儿童使用旅程或实体设备通过验收'});
}
