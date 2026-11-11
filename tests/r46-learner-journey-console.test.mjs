import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');

test('R46 独立学习者旅程界面只显示文字进度，不宣称音频或机器人验收',()=>{
 for(const id of ['learner-journey-title','learner-journey-refresh',
  'learner-journey-status','learner-journey-plans'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.ok(html.includes('不证明发音质量或机器人动作'));
 assert.ok(app.includes("fetch('/api/learning/journey',{cache:'no-store'})"));
 assert.ok(app.includes("authorizedActor!=='child'"));
 assert.ok(app.includes("identity?.startsWith('learner:')"));
 assert.ok(app.includes('learnerResume.current(identity,token)'));
 assert.ok(app.includes('learnerResume.acceptJourney(identity,token,report)'));
 assert.ok(app.includes('esc(plan.courseId)')===false);
});
test('R46 旅程 API 只接受受认证独立学习者或明确选择档案的家长',()=>{
 const at=server.indexOf("pathname==='/api/learning/journey'");
 assert.ok(at>0);
 const code=server.slice(at,at+1800);
 for(const fragment of ["auth.mode!=='local'","principalFor(req)",
  "principal!=='parent'&&requested!==null","principal==='child'",
  "profiles.list().some(","conversations.list(owner)","learningPlans.list(principal,",
  "conversations.progress("])assert.ok(code.includes(fragment),fragment);
 assert.ok(!code.includes('gateway.dispatch('));
});
