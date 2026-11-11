import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';

const source=readFileSync(resolve(import.meta.dirname,'../public/learner-resume.js'),'utf8');
function state(){
 const win={};
 runInNewContext(source,{window:win},{timeout:2000});
 return win.AlexLearnerResume.createLearnerResumeState();
}
const A='learner:profile-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='learner:profile-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const journey=(principal,ids)=>({principal,
 sessions:ids.map(id=>({id})),recentSessionId:ids[0]??null});

test('R53 只有独立孩子才可以绑定最近会话，家长和共享儿童不能读取',()=>{
 const s=state();
 s.switchOwner('parent');
 assert.equal(s.acceptJourney('parent',s.token(),journey('parent',['session_1'])),false);
 assert.equal(s.latest('parent',s.token()),null);
 s.switchOwner('child');
 assert.equal(s.acceptJourney('child',s.token(),journey('child',['session_1'])),false);
 s.switchOwner(A);
 assert.equal(s.acceptJourney(A,s.token(),journey(A,['session_1'])),true);
 assert.equal(s.latest(A,s.token()),'session_1');
});
test('R53 一旦从孩子甲切到乙，甲的在途异步结果不得回写',()=>{
 const s=state();const old=s.switchOwner(A);
 s.switchOwner(B);
 assert.equal(s.current(A,old),false);
 assert.equal(s.acceptJourney(A,old,journey(A,['session_1'])),false);
 const now=s.token();
 assert.equal(s.acceptJourney(B,now,journey(B,['session_2'])),true);
 assert.equal(s.owns(B,now,'session_1'),false);
 assert.equal(s.latest(B,now),'session_2');
});
test('R53 拒绝把另一个学习者的 report 冒充当前身份',()=>{
 const s=state();const token=s.switchOwner(A);
 assert.equal(s.acceptJourney(A,token,journey(B,['session_1'])),false);
 assert.equal(s.latest(A,token),null);
});
test('R53 最近会话必须实际存在于由服务端返回的有界列表',()=>{
 const s=state();const token=s.switchOwner(A);
 assert.equal(s.acceptJourney(A,token,{
  principal:A,sessions:[{id:'session_1'}],recentSessionId:'session_other'}),false);
 assert.equal(s.latest(A,token),null);
});
test('R53 恶意、重复、过长会话 ID 不可成为恢复目标',()=>{
 const s=state();const token=s.switchOwner(A);
 for(const id of ['<script>','../outside','x'.repeat(129)]){
  assert.equal(s.acceptJourney(A,token,journey(A,[id])),false);
 }
 assert.equal(s.acceptJourney(A,token,journey(A,['same','same'])),false);
 assert.equal(s.acceptJourney(A,token,journey(A,Array.from({length:17},(_,i)=>'session_'+i))),false);
 assert.equal(s.latest(A,token),null);
});
test('R53 撤销/登出导致 forget 后，旧异步令牌永远失效',()=>{
 const s=state();const token=s.switchOwner(A);
 assert.equal(s.acceptJourney(A,token,journey(A,['session_1'])),true);
 s.forget();
 assert.equal(s.latest(A,token),null);
 assert.equal(s.owns(A,token,'session_1'),false);
 assert.equal(s.acceptJourney(A,token,journey(A,['session_1'])),false);
 assert.equal(s.acceptJourney(A,s.token(),journey(A,[])),true);
 assert.equal(s.latest(A,s.token()),null);
});
test('R53 相同身份的多次 refresh 不会抹去已验证的会话所有权',()=>{
 const s=state();const token=s.switchOwner(A);
 assert.equal(s.acceptJourney(A,token,journey(A,['session_1','session_2'])),true);
 assert.equal(s.switchOwner(A),token);
 assert.equal(s.owns(A,token,'session_2'),true);
 assert.equal(s.acceptJourney(A,token,journey(A,['session_2'])),true);
 assert.equal(s.owns(A,token,'session_1'),false);
 assert.equal(s.latest(A,token),'session_2');
});
test('R53 前端脚本加载顺序、显式按钮、双异步边界与身份归属检查存在',()=>{
 const html=readFileSync(resolve(import.meta.dirname,'../public/index.html'),'utf8');
 const app=readFileSync(resolve(import.meta.dirname,'../public/app.js'),'utf8');
 assert.ok(html.indexOf('/learner-resume.js')<html.indexOf('/app.js'));
 assert.match(html,/id="learner-journey-resume" disabled/);
 assert.match(app,/learnerResume\.acceptJourney\(identity,token,report\)/);
 assert.match(app,/learnerResume\.owns\(identity,token,id\)/);
 assert.match(app,/companionIdentityEpoch\+\+/);
 assert.match(app,/if\(identity!==companionActor\|\|epoch!==companionIdentityEpoch\|\|!authorizedActor\)/);
 assert.match(app,/session\.id!==id/);
});

test('R53 历史列表与课程进度响应必须在身份未变化时才更新页面',()=>{
 const app=readFileSync(resolve(import.meta.dirname,'../public/app.js'),'utf8');
 const start=app.indexOf('async function refreshCompanionProgress(){');
 const end=app.indexOf('async function restoreCompanion(',start);
 assert.ok(start>0&&end>start);
 const section=app.slice(start,end);
 assert.match(section,/const identity=companionActor,epoch=companionIdentityEpoch/);
 assert.match(section,/if\(!stillCurrent\(\)\)return/);
 assert.match(section,/if\(identity!==companionActor\|\|epoch!==companionIdentityEpoch\|\|!authorizedActor\)return/);
 assert.match(section,/if\(loaded\?\.id===companionSessionId\)showCompanion\(loaded\)/);
});
test('R53 HTTP 静态文件映射包含恢复脚本，且没有开放任意路径读取',()=>{
 const server=readFileSync(resolve(import.meta.dirname,'../scripts/server.mjs'),'utf8');
 assert.ok(server.includes("'/learner-resume.js':'learner-resume.js'"));
 assert.match(server,/if\(req.method!=='GET'\|\|!\(pathname in assets\)\)/);
});
