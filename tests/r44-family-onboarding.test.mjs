import test from 'node:test';
import assert from 'node:assert/strict';
import {familyOnboardingStatus} from '../scripts/family-onboarding.mjs';

const a='profile-00000000-0000-4000-8000-000000000001';
const b='profile-00000000-0000-4000-8000-000000000002';
const profile=id=>({id,nickname:'不需要输出',ageBand:'6-8',interests:[]});
const input=()=>({authMode:'local',profiles:[],learners:[],privacyRows:[]});
test('R44 首次使用空状态明确指向创建档案',()=>{
 const report=familyOnboardingStatus(input());
 assert.equal(report.status,'incomplete');
 assert.equal(report.nextStep,'create-profile');
 assert.equal(report.complete,false);
 assert.equal(report.deviceProvisioned,false);
 assert.equal(report.voiceVerified,false);
 assert.equal(report.readOnly,true);
});
test('R44 新建档案后必须单独创建孩子凭据及审查隐私',()=>{
 const state={...input(),profiles:[profile(a)]};
 assert.equal(familyOnboardingStatus(state).nextStep,'learner-credential');
 state.learners=[{profileId:a,code:'abc'}];
 assert.equal(familyOnboardingStatus(state).nextStep,'privacy-review');
 state.privacyRows=[{profileId:a,preferences:{
  voiceInputAllowed:false,voiceOutputAllowed:false,cloudTextAllowed:false,
  cloudAudioInputAllowed:false,cloudAudioOutputAllowed:false
 }}];
 const report=familyOnboardingStatus(state);
 assert.equal(report.status,'configured');
 assert.equal(report.complete,true);
 assert.equal(report.learners[0].hasCredential,true);
 assert.equal(report.learners[0].privacyReviewed,true);
 assert.equal(report.learners[0].anyCloudGrant,false);
});
test('R44 不允许其他孩子的隐私记录替代当前学习者审查',()=>{
 const state={...input(),profiles:[profile(a),profile(b)],
  learners:[{profileId:a}],privacyRows:[{profileId:b,preferences:{}}]};
 const report=familyOnboardingStatus(state);
 assert.equal(report.nextStep,'privacy-review');
 assert.equal(report.complete,false);
});
test('R44 上线演示模式不得宣称家庭初始化完成',()=>{
 const state={...input(),authMode:'demo',profiles:[profile(a)],
  learners:[{profileId:a}],privacyRows:[{profileId:a,preferences:{}}]};
 assert.equal(familyOnboardingStatus(state).nextStep,'parent-auth');
});
test('R44 输出不会泄露昵称、PIN、公开登录代码和任何儿童档案明文',()=>{
 const report=familyOnboardingStatus({...input(),profiles:[profile(a)],
  learners:[{profileId:a,code:'sensitive-login-code',digest:'private'}],
  privacyRows:[]});
 const json=JSON.stringify(report);
 for(const secret of ['不需要输出','sensitive-login-code','private'])
  assert.equal(json.includes(secret),false);
 assert.ok(json.includes(a));
});
test('R44 不完整状态拒绝生成看似成功的初始化报告',()=>{
 assert.throws(()=>familyOnboardingStatus(),/INVALID_FAMILY_ONBOARDING/);
 assert.throws(()=>familyOnboardingStatus({...input(),profiles:[null]}),
  /INVALID_FAMILY_ONBOARDING/);
});
