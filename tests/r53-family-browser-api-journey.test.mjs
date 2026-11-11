import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const cwd=resolve(import.meta.dirname,'..');
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const names={
 STATE_FILE:'state.json',AUDIT_FILE:'audit.jsonl',MEMORY_FILE:'memory.json',
 DEVICES_FILE:'devices.json',PROFILES_FILE:'profiles.json',
 LEARNER_CREDENTIALS_FILE:'learner-credentials.json',
 ALEX_LEARNER_PRIVACY_FILE:'learner-privacy.json',
 ALEX_LEARNING_PLANS_FILE:'learning-plans.json',
 ALEX_CONVERSATION_FILE:'conversations.json',
 ALEX_SKILL_GOVERNANCE_FILE:'governance.json',
 ALEX_SKILL_TRUST_FILE:'trust.json',
 ALEX_SKILL_PACKAGES_FILE:'packages.json',
 ALEX_SKILL_TRANSACTIONS_FILE:'transactions.json',
 ALEX_SKILL_BATCH_WAL_FILE:'batch-wal.json',
 GATEWAY_FILE:'gateway.json',WORKFLOW_FILE:'workflows.json',
 PLAN_FILE:'plans.json',PROPOSAL_FILE:'proposals.json'
};
function envFor(dir,port){
 return {
  PORT:String(port),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r53-browser-journey-test-parent',
  ALEX_CHILD_PIN:'882277',ALEX_CONVERSATION_PERSIST:'1',AGENT_PROVIDER:'rules',
  ALEX_CHAT_PROVIDER:'offline',ALEX_AUDIO_PROVIDER:'disabled',
  ALEX_REALTIME_PROVIDER:'disabled',ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ...Object.fromEntries(Object.entries(names).map(([key,name])=>[key,join(dir,name)]))
 };
}
async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd,env:{...process.env,...env},stdio:['ignore','ignore','pipe']
 });
 let stderr='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{stderr+=chunk.slice(0,1200);});
 const base='http://127.0.0.1:'+env.PORT;
 let error=null;
 for(let attempt=0;attempt<150;attempt++){
  if(child.exitCode!==null)throw Error('R53_SERVER_EXIT:'+stderr);
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}
  catch(cause){error=cause;}
  await wait(60);
 }
 child.kill('SIGTERM');
 throw Error('R53_SERVER_TIMEOUT:'+String(error?.message??'unknown'));
}
async function stop(instance){
 if(!instance||instance.child.exitCode!==null||instance.child.signalCode!==null)return;
 const exit=once(instance.child,'exit');
 instance.child.kill('SIGTERM');
 await exit;
 assert.equal(instance.child.exitCode,0);
}
async function api(base,path,{cookie,data}={}){
 const response=await fetch(base+path,{
  method:data?'POST':'GET',
  headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
  ...(data?{body:JSON.stringify(data)}:{})
 });
 return {status:response.status,json:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(base,role,secret,code){
 const response=await api(base,'/api/auth/login',{data:{
  role,secret,...(code?{code}:{})
 }});
 assert.equal(response.status,200,JSON.stringify(response.json));
 return response.cookie;
}
test('R53 真实 HTTP 浏览器流程接口：双儿童登录、对话、刷新式恢复、PIN 吊销及隔离',{timeout:75000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r53-journey-'));
 let running;
 try{
  const env=envFor(dir,60000+Math.floor(Math.random()*2500));
  running=await boot(env);
  const parent=await login(running.base,'parent',env.ALEX_PARENT_PASSWORD);
  const children=[];
  for(const [i,name] of ['甲同学','乙同学'].entries()){
   const created=await api(running.base,'/api/profiles',{cookie:parent,
    data:{nickname:name,ageBand:'6-8',interests:[]}});
   assert.equal(created.status,200);
   const id=created.json.profile.id,pin=String(732100+i);
   const credentials=await api(running.base,'/api/learners/set-pin',{cookie:parent,
    data:{profileId:id,pin}});
   assert.equal(credentials.status,200);
   children.push({id,pin,code:credentials.json.learner.code});
  }
  const [A,B]=children;
  const childA=await login(running.base,'learner',A.pin,A.code);
  const childB=await login(running.base,'learner',B.pin,B.code);
  const assigned=await api(running.base,'/api/learning/assign',{cookie:parent,data:{
   profileId:A.id,courseId:'english.a1.greetings',targetCompletions:2
  }});
  assert.equal(assigned.status,200);
  const opened=await api(running.base,'/api/companion/open',{cookie:childA,data:{
   mode:'english',lessonId:'english.a1.greetings'
  }});
  assert.equal(opened.status,200);
  const sessionId=opened.json.session.id;
  const turned=await api(running.base,'/api/companion/turn',{cookie:childA,
   data:{id:sessionId,text:'Hello Alex, I am learning English'}});
  assert.equal(turned.status,200,JSON.stringify(turned.json));
  const journey=await api(running.base,'/api/learning/journey',{cookie:childA});
  assert.equal(journey.status,200);
  assert.equal(journey.json.report.recentSessionId,sessionId);
  assert.equal(journey.json.report.principal,'learner:'+A.id);
  const restored=await api(running.base,'/api/companion/session?id='+encodeURIComponent(sessionId),
   {cookie:childA});
  assert.equal(restored.status,200);
  assert.ok(restored.json.session.messages.some(m=>m.text==='Hello Alex, I am learning English'));
  assert.notEqual((await api(running.base,'/api/companion/session?id='+sessionId,
   {cookie:childB})).status,200);
  assert.deepEqual((await api(running.base,'/api/learning/journey',
   {cookie:childB})).json.report.sessions,[]);
  const rotated=await api(running.base,'/api/learners/set-pin',{cookie:parent,
   data:{profileId:A.id,pin:'778899'}});
  assert.equal(rotated.status,200);
  assert.equal(rotated.json.runtimeStopped,true);
  assert.equal((await api(running.base,'/api/learning/journey',{cookie:childA})).status,401);
  assert.equal((await api(running.base,'/api/companion/session?id='+sessionId,
   {cookie:childA})).status,401);
  assert.equal((await api(running.base,'/api/auth/login',{data:{
   role:'learner',code:A.code,secret:A.pin}})).status!==200,true);
  const renewed=await login(running.base,'learner','778899',rotated.json.learner.code);
  assert.equal((await api(running.base,'/api/companion/session?id='+sessionId,
   {cookie:renewed})).status,200);
  assert.equal((await api(running.base,'/api/learning/journey',
   {cookie:childB})).status,200);
  const loggedOut=await api(running.base,'/api/auth/logout',{cookie:renewed,data:{}});
  assert.equal(loggedOut.status,200);
  assert.equal((await api(running.base,'/api/learning/journey',
   {cookie:renewed})).status,401);
  assert.equal((await api(running.base,'/api/learning/journey',
   {cookie:parent})).status,400);
 }finally{
  await stop(running);
  await rm(dir,{recursive:true,force:true});
 }
});
