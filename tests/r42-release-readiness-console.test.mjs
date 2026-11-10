import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
const server=readFileSync(resolve(root,'scripts/server.mjs'),'utf8');

test('R42 发布检查仅在家长区域显示，不提供自动发布动作',()=>{
 const privateStart=html.indexOf('id="family-private"');
 for(const id of ['release-readiness-title','release-readiness-refresh',
  'release-readiness-status','release-readiness-checks','release-readiness-robot-status']){
  const pos=html.indexOf('id="'+id+'"');
  assert.ok(pos>privateStart,id);
 }
 assert.ok(html.includes('静态配置可满足时也必须完成真实语音'));
 assert.ok(!html.includes('id="release-readiness-approve"'));
});
test('R42 前端安全展示阻断和人工实测，不渲染未经转义的服务端内容',()=>{
 assert.ok(app.includes("fetch('/api/release/readiness',{cache:'no-store'})"));
 assert.ok(app.includes("authorizedActor!=='parent'"));
 assert.ok(app.includes("report.releaseApproved")===false); // 前端不暴露发布审批控制
 for(const fragment of ['esc(item.id)','esc(item.detail)','esc(item.status==='])
  assert.ok(app.includes(fragment),fragment);
 assert.ok(app.includes("report.robotCandidate.check.status"));
});
test('R42 后端只有本地家长能够读取检查报告，所有检查均使用真实状态',()=>{
 const at=server.indexOf("pathname==='/api/release/readiness'");
 assert.ok(at>0);
 const code=server.slice(at,at+1700);
 for(const fragment of ["auth.mode!=='local'","auth.actor(req)!=='parent'",
  "profiles.list().length","skillTransactions.readiness('parent')",
  "skillBatchTransactions.readiness('parent')",
  "reconcileSkillStores(","evaluateReleaseReadiness(","writerLockHeld:!!writerLease"])
  assert.ok(code.includes(fragment),fragment);
 assert.ok(!code.includes("voiceEndToEndVerified:true"));
 assert.ok(!code.includes("rosRuntimeVerified:true"));
});
