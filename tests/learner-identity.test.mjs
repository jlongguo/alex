import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {LearnerCredentials} from '../scripts/learner-credentials.mjs';
import {FamilyAuth} from '../scripts/family-security.mjs';
import {CompanionConversations} from '../scripts/companion-conversations.mjs';

const cwd=resolve(import.meta.dirname,'..');
const p1='profile-11111111-1111-4111-8111-111111111111';
const p2='profile-22222222-2222-4222-8222-222222222222';
const pinA='738291',pinB='748291';

test('LearnerCredentials persist only per-learner salted hash; rotate and revoke serially',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-learners-unit-'));
  const file=join(dir,'learner-pins.json');
  try{
    const credentials=new LearnerCredentials(file);
    await assert.rejects(()=>credentials.setPin('child',p1,pinA,()=>true),/PARENT_REQUIRED/);
    await assert.rejects(()=>credentials.setPin('parent',p1,'hello',()=>true),/INVALID_LEARNER_PIN/);
    await assert.rejects(()=>credentials.setPin('parent',p1,pinA,()=>false),/UNKNOWN_LEARNER_PROFILE/);
    const a=await credentials.setPin('parent',p1,pinA,()=>true);
    const b=await credentials.setPin('parent',p2,pinB,()=>true);
    assert.match(a.code,/^[a-f0-9]{12}$/);
    assert.notEqual(a.code,b.code);
    assert.equal(credentials.verify(a.code,pinA),p1);
    assert.equal(credentials.verify(b.code,pinB),p2);
    assert.equal(credentials.verify(a.code,'111111'),null);
    assert.equal(credentials.verify('unknown-code',pinA),null);
    const disk=await readFile(file,'utf8');
    assert.equal(disk.includes(pinA),false);
    assert.equal(disk.includes(pinB),false);
    assert.equal(JSON.parse(disk).records[0].digest.length,64);
    assert.throws(()=>credentials.listForParent('child'),/PARENT_REQUIRED/);
    const restored=new LearnerCredentials(file);await restored.load();
    assert.equal(restored.verify(a.code,pinA),p1);
    const rotated=await restored.setPin('parent',p1,'839291',()=>true);
    assert.equal(rotated.code,a.code,'rotating PIN must not alter separate login code');
    assert.equal(restored.verify(a.code,pinA),null);
    assert.equal(restored.verify(a.code,'839291'),p1);
    await restored.revoke('parent',p1);
    assert.equal(restored.verify(a.code,'839291'),null);
    assert.equal(restored.verify(b.code,pinB),p2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('FamilyAuth learner sessions are parent/child roles with verified profile ID, revoked on reset',()=>{
 const auth=new FamilyAuth({mode:'local',parentPassword:'long-parent-password-123',childPin:'123456'});
 const req={socket:{remoteAddress:'127.0.0.41'},headers:{}};
 const {cookie,learnerId,actor}=auth.login(req,{role:'learner',secret:pinA,code:'a'.repeat(12)},
   (code,pin)=>code==='a'.repeat(12)&&pin===pinA?p1:null);
 assert.equal(actor,'child');
 assert.equal(learnerId,p1);
 const authenticated={socket:req.socket,headers:{cookie:cookie.split(';')[0]}};
 assert.deepEqual(auth.current(authenticated),{learnerId:p1,authenticated:true,actor:'child',mode:'local'});
 assert.equal(auth.actor(authenticated,'parent'),'child');
 assert.equal(auth.revokeLearner(p1),1);
 assert.equal(auth.current(authenticated).authenticated,false);
 assert.equal(auth.login(req,{role:'child',secret:'123456'}).actor,'child','old shared PIN stays a separate legacy identity');
});

test('CompanionConversations prevent cross-learner and legacy PIN transcript access',async()=>{
 const data=new CompanionConversations();
 const A='learner:'+p1,B='learner:'+p2;
 const a=await data.open(A,'english');
 const b=await data.open(B,'english');
 assert.equal(a.actor,'child');
 assert.equal(a.principal,A);
 assert.equal(data.list(A).length,1);
 assert.equal(data.list(B).length,1);
 assert.equal(data.list('child').length,0);
 await assert.rejects(()=>data.turn(B,a.id,'Hi'),/UNKNOWN_CONVERSATION/);
 await assert.rejects(()=>data.remove('child',a.id),/UNKNOWN_CONVERSATION/);
 assert.throws(()=>data.get('parent',a.id),/UNKNOWN_CONVERSATION/);
 for(const answer of ['Sunny','I like apples','I like blue','I can run','I am happy'])
   await data.turn(A,a.id,answer);
 assert.equal(data.progress(A).englishTextExercisesCompleted,1);
 assert.equal(data.progress(B).englishTextExercisesCompleted,0);
 assert.equal(data.progress('child').englishTextExercisesCompleted,0);
 assert.equal(data.progress('parent','child').englishTextExercisesCompleted,1);
 assert.equal(data.progress('parent',A).englishTextExercisesCompleted,1);
 assert.throws(()=>data.progress(A,'child'),/PARENT_REQUIRED/);
 assert.throws(()=>data.progress(A,B),/PARENT_REQUIRED/);
 assert.equal(await data.eraseLearner('parent',p1),1);
 assert.equal(data.progress('parent',A).englishTextExercisesCompleted,0);
 assert.equal(data.list(B).length,1);
});

async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw new Error('Alex server exited early: '+child.exitCode);
  try{const res=await fetch(base+'/api/health');if(res.ok)return {child,base};}catch{}
  await new Promise(done=>setTimeout(done,70));
 }
 child.kill('SIGTERM');throw new Error('Timed out waiting for Alex server');
}
async function json(base,path,body,cookie){
 const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',
   ...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
 return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function get(base,path,cookie){
 const res=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
 return {status:res.status,data:await res.json()};
}

test('HTTP full child-identity lifecycle: login, privacy, progress, PIN rotation, deletion, restart', {timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-learners-http-'));
 const env={
  PORT:String(48000+Math.floor(Math.random()*12000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'safe-parent-credential-testing',ALEX_CHILD_PIN:'123456',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_CONVERSATION_PERSIST:'1',ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'learners.json'),
  STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let server;
 try{
  server=await boot(env);
  const parentLogin=await json(server.base,'/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD});
  const parent=parentLogin.cookie;
  assert.equal(parentLogin.status,200);
  const A=(await json(server.base,'/api/profiles',{nickname:'First',ageBand:'6-8',interests:['stories']},parent)).data.profile;
  const B=(await json(server.base,'/api/profiles',{nickname:'Second',ageBand:'9-12',interests:['science']},parent)).data.profile;
  assert.equal((await json(server.base,'/api/learners/set-pin',{profileId:A.id,pin:pinA})).status,401);
  const deniedParent=(await json(server.base,'/api/learners/set-pin',{profileId:B.id,pin:pinB},parent));
  assert.equal(deniedParent.status,200);
  const aRes=await json(server.base,'/api/learners/set-pin',{profileId:A.id,pin:pinA},parent);
  assert.equal(aRes.status,200);
  const codeA=aRes.data.learner.code,codeB=deniedParent.data.learner.code;
  assert.notEqual(codeA,codeB);
  const legacy=(await json(server.base,'/api/auth/login',{role:'child',secret:'123456'})).cookie;
  const bad=(await json(server.base,'/api/auth/login',{role:'learner',code:'0'.repeat(12),secret:pinA}));
  assert.equal(bad.status,401);
  const loginA=await json(server.base,'/api/auth/login',{role:'learner',code:codeA,secret:pinA});
  const loginB=await json(server.base,'/api/auth/login',{role:'learner',code:codeB,secret:pinB});
  assert.equal(loginA.data.learnerId,A.id);
  assert.equal(loginB.data.learnerId,B.id);
  const learnerA=loginA.cookie,learnerB=loginB.cookie;
  const sessionA=await get(server.base,'/api/auth/session',learnerA);
  assert.deepEqual({actor:sessionA.data.actor,learnerId:sessionA.data.learnerId},
    {actor:'child',learnerId:A.id});
  assert.deepEqual((await get(server.base,'/api/profiles',learnerA)).data.profiles.map(x=>x.id),[A.id]);
  assert.deepEqual((await get(server.base,'/api/profiles',learnerB)).data.profiles.map(x=>x.id),[B.id]);
  assert.equal((await get(server.base,'/api/profiles',legacy)).data.profiles.length,0);
  assert.equal((await get(server.base,'/api/learners/access',learnerA)).status,403);
  const creds=await get(server.base,'/api/learners/access',parent);
  assert.equal(creds.data.learners.length,2);
  assert.ok(!JSON.stringify(creds.data).includes(pinA));
  const convA=(await json(server.base,'/api/companion/open',{mode:'english'},learnerA)).data.session;
  const convB=(await json(server.base,'/api/companion/open',{mode:'english'},learnerB)).data.session;
  assert.equal(convA.principal,'learner:'+A.id);
  assert.equal(convB.principal,'learner:'+B.id);
  assert.equal((await get(server.base,'/api/companion/session?id='+convA.id,learnerB)).status,400);
  assert.equal((await get(server.base,'/api/companion/session?id='+convA.id,legacy)).status,400);
  assert.equal((await json(server.base,'/api/companion/turn',{id:convB.id,text:'spy'},learnerA)).status,409===1?409:400);
  for(const answer of ['Sunny','I like apples','I like red','I can run','I am fine']){
   const turn=await json(server.base,'/api/companion/turn',{id:convA.id,text:answer},learnerA);
   assert.equal(turn.status,200);
  }
  const progressA=(await get(server.base,'/api/companion/progress?scope=self',learnerA)).data.progress;
  assert.equal(progressA.englishTextExercisesCompleted,1);
  assert.equal((await get(server.base,'/api/companion/progress?scope=self',learnerB)).data.progress.englishTextExercisesCompleted,0);
  assert.equal((await get(server.base,'/api/companion/progress?scope=child',learnerA)).status,403);
  assert.equal((await get(server.base,'/api/companion/progress?scope=child',parent)).data.progress.englishTextExercisesCompleted,1);
  assert.equal((await get(server.base,'/api/companion/progress?scope=learner:'+A.id,parent)).data.progress.englishTextExercisesCompleted,1);
  assert.equal((await get(server.base,'/api/companion/progress?scope=learner:'+B.id,parent)).data.progress.englishTextExercisesCompleted,0);
  const changed=await json(server.base,'/api/learners/set-pin',{profileId:A.id,pin:'392817'},parent);
  assert.equal(changed.status,200);
  assert.equal(changed.data.learner.code,codeA);
  assert.equal((await get(server.base,'/api/auth/session',learnerA)).data.authenticated,false);
  const restoredA=await json(server.base,'/api/auth/login',{role:'learner',code:codeA,secret:'392817'});
  assert.equal(restoredA.status,200);
  const nextCookie=restoredA.cookie;
  assert.equal((await get(server.base,'/api/companion/session?id='+convA.id,nextCookie)).status,200);
  const revoked=await json(server.base,'/api/learners/revoke',{profileId:B.id},parent);
  assert.equal(revoked.status,200);
  assert.equal((await get(server.base,'/api/auth/session',learnerB)).data.authenticated,false);
  const deleted=await json(server.base,'/api/profiles/delete',{id:A.id},parent);
  assert.equal(deleted.status,200);
  assert.equal((await get(server.base,'/api/auth/session',nextCookie)).data.authenticated,false);
  assert.equal((await get(server.base,'/api/companion/progress?scope=learner:'+A.id,parent)).data.progress.englishTextExercisesCompleted,0);
  assert.equal((await get(server.base,'/api/learners/access',parent)).data.learners.length,0);
  assert.equal((await get(server.base,'/api/companion/sessions',parent)).data.sessions.length,0);
  const credentialFile=await readFile(env.LEARNER_CREDENTIALS_FILE,'utf8');
  assert.equal(credentialFile.includes(pinA),false);
  server.child.kill('SIGTERM');await once(server.child,'exit');server=null;
  const restarted=await boot(env);server=restarted;
  const newParent=(await json(server.base,'/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  assert.equal((await get(server.base,'/api/learners/access',newParent)).data.learners.length,0);
  assert.equal((await get(server.base,'/api/companion/progress?scope=child',newParent)).data.progress.englishTextExercisesCompleted,0);
 }finally{
  if(server){server.child.kill('SIGTERM');await once(server.child,'exit').catch(()=>{});}
  await rm(dir,{recursive:true,force:true});
 }
});
