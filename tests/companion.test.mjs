import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {CompanionConversations} from '../scripts/companion-conversations.mjs';
import {CompatibleCompanionProvider} from '../scripts/companion-provider.mjs';

const cwd=resolve(import.meta.dirname,'..');

test('offline A1 English actually checks answers and advances through multi-turn practice',async()=>{
  const hub=new CompanionConversations();
  const session=await hub.open('child','english');
  assert.match(session.messages[0].text,/nickname/i);
  let turn=await hub.turn('child',session.id,'Sunny');
  assert.equal(turn.session.step,1);
  assert.match(turn.assistant.text,/Sunny/);
  turn=await hub.turn('child',session.id,'apples');
  assert.equal(turn.session.step,1,'invalid sentence should not advance');
  assert.match(turn.assistant.text,/I like apples/);
  turn=await hub.turn('child',session.id,'I like noodles.');
  assert.equal(turn.session.step,2);
  turn=await hub.turn('child',session.id,'I like green.');
  assert.equal(turn.session.step,3);
  turn=await hub.turn('child',session.id,'I can sing.');
  assert.equal(turn.session.step,4);
  turn=await hub.turn('child',session.id,'I am happy.');
  assert.equal(turn.session.step,5);
  turn=await hub.turn('child',session.id,'restart');
  assert.equal(turn.session.step,0);
  assert.equal(turn.source,'offline');
  assert.ok(!('deviceJobId' in turn));
});

test('offline interactive story branches and does not invent skill/device execution',async()=>{
  const hub=new CompanionConversations();
  const s=await hub.open('child','story');
  assert.match(s.messages[0].text,/A.*B/);
  let out=await hub.turn('child',s.id,'I like cats');
  assert.equal(out.session.step,0);
  out=await hub.turn('child',s.id,'A');
  assert.equal(out.session.step,1);
  out=await hub.turn('child',s.id,'B');
  assert.equal(out.session.step,2);
  out=await hub.turn('child',s.id,'A');
  assert.equal(out.session.step,3);
  assert.match(out.assistant.text,/A → B → A/);
  const again=await hub.turn('child',s.id,'重新开始');
  assert.equal(again.session.step,0);
  assert.equal(hub.list('child').length,1);
});

test('verified-role conversation boundary and explicit local persistence opt-in',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'alex-companion-'));
  const path=join(folder,'conversations.json');
  try{
    const volatile=new CompanionConversations({persist:false,file:path});
    const s=await volatile.open('child','english');
    await volatile.turn('child',s.id,'A temporary nickname');
    await assert.rejects(async()=>volatile.turn('parent',s.id,'steal'),/UNKNOWN_CONVERSATION/);
    assert.equal(volatile.list('parent').length,0);
    assert.equal(volatile.list('child').length,1);
    assert.deepEqual(volatile.exportForParent('parent').map(x=>x.id),[s.id]);
    await assert.rejects(async()=>volatile.erase('child','all'),/PARENT_REQUIRED/);
    assert.equal(await readFile(path,'utf8').then(()=>true,()=>false),false,'default must not write transcripts');
    const persistent=new CompanionConversations({persist:true,file:path});
    const p=await persistent.open('parent','story');
    await persistent.turn('parent',p.id,'A');
    const restored=new CompanionConversations({persist:true,file:path});
    await restored.load();
    assert.equal(restored.get('parent',p.id).step,1);
    await restored.erase('parent','parent');
    assert.equal(restored.list('parent').length,0);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('invalid input and unsupported offline general chat do not mutate history',async()=>{
  const hub=new CompanionConversations();
  const chat=await hub.open('child','chat');
  assert.match(chat.messages[0].text,/尚未启用模型/);
  await assert.rejects(async()=>hub.turn('child',chat.id,'hello'),/CHAT_MODEL_REQUIRED/);
  assert.equal(hub.get('child',chat.id).messages.length,1);
  await assert.rejects(async()=>hub.turn('child',chat.id,'a'.repeat(501)),/INVALID_COMPANION_INPUT/);
  await assert.rejects(async()=>hub.open('parent','robot_motors'),/INVALID_COMPANION_MODE/);
});

test('compatible chat uses bounded history, accepts only user-visible text and no tool calls',async()=>{
  let seen=null;
  const provider=new CompatibleCompanionProvider({
    baseUrl:'https://example.invalid/v1',apiKey:'test-secret',model:'demo-chat',
    fetchFn:async(url,req)=>{
      seen={url:String(url),request:req,body:JSON.parse(req.body)};
      return {ok:true,status:200,json:async()=>({choices:[{message:{content:'Hello! I can help you learn.'}}]})};
    }
  });
  const service=new CompanionConversations({provider});
  const session=await service.open('child','chat');
  const turn=await service.turn('child',session.id,'Hi');
  assert.equal(turn.source,'model');
  assert.equal(turn.assistant.text,'Hello! I can help you learn.');
  assert.equal(seen.url,'https://example.invalid/v1/chat/completions');
  assert.equal(seen.request.redirect,'error');
  assert.equal(seen.body.messages[0].role,'system');
  assert.ok(!('tools' in seen.body));
  assert.ok(!('tool_choice' in seen.body));
  assert.equal(seen.body.messages.at(-1).content,'Hi');
  assert.match(seen.body.messages[0].content,/Never claim to have executed actions/);
  assert.ok(!JSON.stringify(turn).includes('test-secret'));
  assert.throws(()=>new CompatibleCompanionProvider({baseUrl:'http://example.com',apiKey:'secret',model:'test'}),/INVALID_CHAT_PROVIDER_URL/);
  const failed=new CompanionConversations({provider:{reply:async()=>{throw new Error('CHAT_PROVIDER_UNAVAILABLE');}}});
  const f=await failed.open('child','chat');
  await assert.rejects(async()=>failed.turn('child',f.id,'hello'),/CHAT_PROVIDER_UNAVAILABLE/);
  assert.equal(failed.get('child',f.id).messages.length,1);
});

async function startServer(env) {
  const proc=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,...env},stdio:'ignore'});
  const base='http://127.0.0.1:'+env.PORT;
  for(let i=0;i<80;i++){
    if(proc.exitCode!==null)throw new Error('server exited unexpectedly: '+proc.exitCode);
    try{const r=await fetch(base+'/api/health');if(r.ok)return {proc,base,health:await r.json()};}
    catch{}
    await new Promise(resolve=>setTimeout(resolve,70));
  }
  proc.kill('SIGTERM');
  throw new Error('server did not start');
}

test('real HTTP: child role isolation, dialog turns, parent privacy export/erasure and restart', {timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-companion-http-'));
  const port=46000+Math.floor(Math.random()*11000);
  const env={
    PORT:String(port),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'safe-parent-password-for-test',
    ALEX_CHILD_PIN:'654321',AGENT_PROVIDER:'rules',
    ALEX_CHAT_PROVIDER:'offline',ALEX_CONVERSATION_PERSIST:'1',
    ALEX_CONVERSATION_FILE:join(dir,'conversation.json'),
    STATE_FILE:join(dir,'state.json'),MEMORY_FILE:join(dir,'memory.json'),
    DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),
    AUDIT_FILE:join(dir,'audit.jsonl'),GATEWAY_FILE:join(dir,'gateway.json'),
    WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
    PROPOSAL_FILE:join(dir,'proposals.json')
  };
  let service;
  try{
    service=await startServer(env);
    assert.equal(service.health.companion.provider,'offline');
    assert.equal(service.health.companion.transcriptsPersisted,true);
    const post=async(path,body,cookie)=>fetch(service.base+path,{
      method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
      body:JSON.stringify(body)}).then(async response=>({status:response.status,body:await response.json()}));
    const login=async(role,secret)=>{
      const response=await fetch(service.base+'/api/auth/login',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({role,secret})});
      assert.equal(response.status,200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const guest=await post('/api/companion/open',{mode:'english'},null);
    assert.equal(guest.status,401);
    const child=await login('child','654321');
    const parent=await login('parent','safe-parent-password-for-test');
    const opened=await post('/api/companion/open',{mode:'english'},child);
    assert.equal(opened.status,200);
    const id=opened.body.session.id;
    assert.equal((await post('/api/companion/turn',{id,text:'Sparrow'},child)).body.session.step,1);
    const childGet=await fetch(service.base+'/api/companion/session?id='+id,{headers:{Cookie:child}});
    assert.equal(childGet.status,200);
    const parentGet=await fetch(service.base+'/api/companion/session?id='+id,{headers:{Cookie:parent}});
    assert.notEqual(parentGet.status,200,'parent direct GET must not list child private conversations');
    const parentList=await fetch(service.base+'/api/companion/sessions',{headers:{Cookie:parent}});
    assert.equal((await parentList.json()).sessions.length,0);
    const before=await fetch(service.base+'/api/privacy/export',{headers:{Cookie:parent}});
    assert.ok((await before.json()).companionConversations.some(x=>x.id===id));
    const erased=await post('/api/privacy/erase',{scope:'child'},parent);
    assert.equal(erased.status,200);
    assert.equal(erased.body.deletedConversations,1);
    const gone=await fetch(service.base+'/api/companion/session?id='+id,{headers:{Cookie:child}});
    assert.notEqual(gone.status,200);

    // Real SkillRegistry invocation now creates an actual interactive
    // dialogue session; the existing role/capability gate runs first.
    const skillsResponse=await fetch(service.base+'/api/skills',{headers:{Cookie:child}});
    const skills=(await skillsResponse.json()).skills;
    assert.equal(skills.find(x=>x.id==='learning.english').conversationMode,'english');
    assert.equal(skills.find(x=>x.id==='story.interactive').conversationMode,'story');
    const launched=await post('/api/skills/invoke',{id:'learning.english'},child);
    assert.equal(launched.status,200);
    assert.equal(launched.body.session.mode,'english');
    assert.equal(launched.body.session.actor,'child');
    const skillTurn=await post('/api/companion/turn',{id:launched.body.session.id,text:'Panda'},child);
    assert.equal(skillTurn.status,200);
    assert.equal(skillTurn.body.session.step,1);
    const deniedSkill=await post('/api/skills/invoke',{id:'home.status'},child);
    assert.equal(deniedSkill.status,409);
    assert.equal(deniedSkill.body.ok,false);
    const keep=await post('/api/companion/open',{mode:'story'},parent);
    assert.equal(keep.status,200);
    const savedId=keep.body.session.id;
    service.proc.kill('SIGTERM');await once(service.proc,'exit');service=null;
    const restarted=await startServer(env);service=restarted;
    const parentAfter=await loginAgainst(restarted.base,'parent','safe-parent-password-for-test');
    const after=await fetch(restarted.base+'/api/companion/session?id='+savedId,{headers:{Cookie:parentAfter}});
    assert.equal(after.status,200,'opt-in transcript should survive restart');
  }finally{
    if(service){service.proc.kill('SIGTERM');await once(service.proc,'exit').catch(()=>{});}
    await rm(dir,{recursive:true,force:true});
  }
});

async function loginAgainst(base,role,secret){
  const r=await fetch(base+'/api/auth/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({role,secret})});
  assert.equal(r.status,200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('UI includes accessible companion flow without mixing device commands into chat',async()=>{
  const [html,js]=await Promise.all([
    readFile(join(cwd,'public/index.html'),'utf8'),
    readFile(join(cwd,'public/app.js'),'utf8')
  ]);
  for(const id of ['companion-form','companion-mode','companion-messages','companion-microphone','companion-privacy'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/body.textContent=message.text/);
  assert.match(js,/\/api\/companion\/turn/);
  assert.match(js,/const CompanionSpeechRecognition=window.SpeechRecognition\|\|window.webkitSpeechRecognition/);
  assert.match(js,/recognition.onresult/);
  assert.doesNotMatch(js,/recognition.onresult=.*requestSubmit/);
});

test('conversation permission callback blocks both opening and continuing a revoked Skill',async()=>{
  const grants=new Set(['english']);
  const service=new CompanionConversations({authorizeMode:(actor,mode)=>{
    if(mode!=='chat'&&!grants.has(mode))throw new Error('COMPANION_SKILL_UNAVAILABLE');
  }});
  await assert.rejects(async()=>service.open('child','story'),/COMPANION_SKILL_UNAVAILABLE/);
  const session=await service.open('child','english');
  grants.clear();
  await assert.rejects(async()=>service.turn('child',session.id,'Hello'),/COMPANION_SKILL_UNAVAILABLE/);
  assert.equal(service.get('child',session.id).messages.length,1);
});
