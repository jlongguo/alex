import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');

test('R44 家长私有区域内有首次使用入口且 PIN 只使用密码输入框',()=>{
 const at=html.indexOf('id="onboarding-title"');
 assert.ok(at>html.indexOf('id="family-private"'));
 assert.ok(html.includes('type="password" id="onboarding-pin"'));
 for(const id of ['onboarding-form','onboarding-refresh','onboarding-status','onboarding-steps',
  'onboarding-result'])assert.ok(html.includes('id="'+id+'"'),id);
 assert.ok(html.includes('云端 AI、短录音上传和云端朗读等权限默认全部关闭'));
});
test('R44 浏览器复用现有服务 API，默认拒绝五项语音与云权限',()=>{
 for(const endpoint of ["api('/api/profiles'","api('/api/learners/set-pin'",
  "api('/api/learner/privacy'"])assert.ok(app.includes(endpoint));
 for(const item of ['voiceInputAllowed:false','voiceOutputAllowed:false',
  'cloudTextAllowed:false','cloudAudioInputAllowed:false','cloudAudioOutputAllowed:false'])
  assert.ok(app.includes(item),item);
 assert.ok(app.includes("$('onboarding-pin').value=''"));
 assert.ok(app.includes('refreshFamilyOnboarding()'));
 assert.ok(app.includes("if(familyBusy||authorizedActor!=='parent')return"));
 assert.ok(app.includes(String.raw`/^\d{6,12}$/`));
});
test('R44 状态 API 仅本地家长可读，不能获取 PIN 或儿童档案昵称',()=>{
 const at=server.indexOf("pathname==='/api/family/onboarding'");
 assert.ok(at>0);
 const route=server.slice(at,at+700);
 assert.ok(route.includes("auth.mode!=='local'"));
 assert.ok(route.includes("auth.actor(req)!=='parent'"));
 assert.ok(route.includes('learnerCredentials.listForParent'));
 assert.ok(route.includes("learnerPrivacy.list('parent')"));
 assert.ok(!route.includes('pin:'));
});
