import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateReleaseReadiness} from '../scripts/release-readiness.mjs';

const base=()=>({
 authMode:'local',childLoginEnabled:true,profileCount:1,
 skillReconciliation:{status:'consistent',findings:[]},
 singleWal:{pending:0,remaining:400},batchWal:{pending:0,remaining:400},
 audioConfigured:true,conversationProvider:'offline',writerLockHeld:true
});
test('R42 软件内测发布门槛区分静态通过与真实用户旅程未验证',()=>{
 const report=evaluateReleaseReadiness(base());
 assert.equal(report.status,'manual-validation-required');
 assert.equal(report.releaseApproved,false);
 assert.deepEqual(report.blockers,[]);
 assert.ok(report.manual.includes('CHILD_JOURNEY_ACCEPTANCE'));
 assert.ok(report.manual.includes('VOICE_END_TO_END_ACCEPTANCE'));
 assert.equal(report.robotCandidate.physicalSafetyCertified,false);
 assert.equal(report.robotCandidate.check.status,'manual-required');
 assert.equal(report.readOnly,true);
 assert.equal(report.executable,false);
});
test('R42 demo、缺儿童入口、缺档案、缺语音和待恢复 WAL 都必须阻断试用',()=>{
 const input=base();
 Object.assign(input,{authMode:'demo',childLoginEnabled:false,profileCount:0,
  audioConfigured:false,singleWal:{pending:2,remaining:0},
  batchWal:{pending:1,remaining:12}});
 const report=evaluateReleaseReadiness(input);
 assert.equal(report.status,'blocked');
 for(const name of ['AUTH_LOCAL_REQUIRED','CHILD_LOGIN_REQUIRED',
  'LEARNER_PROFILE_REQUIRED','AUDIO_PROVIDER_CONFIGURED',
  'SINGLE_WAL_RECOVERY_CLEAR','BATCH_WAL_RECOVERY_CLEAR','SINGLE_WAL_CAPACITY'])
  assert.ok(report.blockers.includes(name),name);
 assert.equal(report.releaseApproved,false);
});
test('R42 已安装技能的跨存储异常必须阻断且不能被其他通过项掩盖',()=>{
 const report=evaluateReleaseReadiness({...base(),
  skillReconciliation:{status:'needs-review',findings:[{kind:'publisher-revoked'}]}});
 assert.ok(report.blockers.includes('SKILL_STORE_INTEGRITY'));
 assert.equal(report.status,'blocked');
});
test('R42 即使人工验收标志全部为真，报告也不自动批准正式发布',()=>{
 const report=evaluateReleaseReadiness({...base(),rosRuntimeVerified:true,
  voiceEndToEndVerified:true,childJourneyVerified:true,recoveryDrillVerified:true});
 assert.equal(report.status,'checks-complete');
 assert.equal(report.releaseApproved,false);
 assert.equal(report.robotCandidate.status,'manual-release-review');
 assert.equal(report.robotCandidate.physicalSafetyCertified,false);
});
test('R42 不完整或伪造的上下文必须拒绝生成通过报告',()=>{
 assert.throws(()=>evaluateReleaseReadiness(),/INVALID_RELEASE_READINESS_CONTEXT/);
 assert.throws(()=>evaluateReleaseReadiness({...base(),profileCount:-1}),
  /INVALID_RELEASE_READINESS_CONTEXT/);
 assert.throws(()=>evaluateReleaseReadiness({...base(),
  batchWal:{pending:'0',remaining:400}}),/INVALID_RELEASE_READINESS_CONTEXT/);
});
test('R42 检查报告不泄露用户档案、密钥或原始签名内容',()=>{
 const report=evaluateReleaseReadiness(base());
 assert.deepEqual(Object.keys(report).sort(),[
  'blockers','checks','executable','manual','note','readOnly',
  'releaseApproved','robotCandidate','schemaVersion','status','target'].sort());
 assert.equal(JSON.stringify(report).includes('publicKeyPem'),false);
 assert.ok(report.checks.every(c=>['pass','blocked','manual-required'].includes(c.status)));
});
