import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HomeCore,RuleAgentProvider,CompatibleAgentProvider,validateProposal,SkillRegistry,PolicyEngine} from '../dist/index.js';
import {JsonStateStore} from '../scripts/state-store.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const nav=(c,d,requestId,timeoutSeconds)=>c.navigate({actor:'parent',capability:d==='dock'?'navigation.dock':'navigation.goto',params:{destination:d},requestId,timeoutSeconds});

test('v0.2: provider proposal validation rejects arbitrary tools and invalid destinations',()=>{
  assert.deepEqual(validateProposal({type:'navigate',destination:'sofa'}),{type:'navigate',destination:'sofa'});
  assert.throws(()=>validateProposal({type:'executeShell',command:'rm -rf /'}),/INVALID_AGENT_PROPOSAL/);
  assert.throws(()=>validateProposal({type:'navigate',destination:'outside'}),/INVALID_AGENT_PROPOSAL/);
});

test('v0.2: mock agent cannot bypass child policies or execute invalid proposals',async()=>{
  const h=new HomeCore({kind:'openai-compatible',propose:async()=>({type:'navigate',destination:'dock'})});
  const denied=await h.commandAsync('please go dock','child');
  assert.equal(denied.ok,false);
  assert.equal(h.listTasks().length,0);
  const unsafe=new HomeCore({kind:'openai-compatible',propose:async()=>({type:'unsafeTool',command:'move'})});
  assert.equal((await unsafe.commandAsync('unsafe','parent')).ok,false);
  assert.equal(unsafe.listTasks().length,0);
});

test('v0.2: remote agent adapter sends bounded request and validates response',async()=>{
  let called=0;
  const provider=new CompatibleAgentProvider({baseUrl:'https://example.test/v1',apiKey:'test-key',model:'test-model',fetchFn:async(url,opts)=>{
    called++;
    assert.match(String(url),/\/v1\/chat\/completions$/);
    assert.match(opts.headers.authorization,/test-key/);
    return new Response(JSON.stringify({choices:[{message:{content:'{"type":"navigate","destination":"sofa"}'}}]}),{status:200});
  }});
  assert.deepEqual(await provider.propose('go sofa'),{type:'navigate',destination:'sofa'});
  assert.equal(called,1);
  assert.throws(()=>new CompatibleAgentProvider({baseUrl:'http://example.test/v1',apiKey:'key',model:'m'}),/INVALID_AGENT_URL/);
});

test('v0.2: agent upstream failure fails closed, no movement',async()=>{
  const core=new HomeCore({kind:'openai-compatible',propose:async()=>{throw new Error('upstream down');}});
  const response=await core.commandAsync('go desk','parent');
  assert.equal(response.ok,false);
  assert.equal(core.listTasks().length,0);
  assert.equal(core.state().robot.movement,'idle');
});

test('v0.2: navigation requestId is idempotent and conflicting target rejected',()=>{
  const c=new HomeCore();
  const a=nav(c,'study_desk','request_0001');
  const b=nav(c,'study_desk','request_0001');
  assert.equal(a.task.id,b.task.id);
  assert.equal(c.listTasks().length,1);
  assert.equal(nav(c,'sofa','request_0001').message,'IDEMPOTENCY_CONFLICT');
  assert.equal(c.state().activeTaskId,a.task.id);
  assert.throws(()=>nav(c,'sofa','x'),/INVALID_REQUEST_ID/);
});

test('v0.2: navigation timeout is terminal and stops simulation',()=>{
  const c=new HomeCore();
  nav(c,'story_corner','request_0002',1);
  c.tick(1);
  assert.equal(c.listTasks()[0].status,'failed');
  assert.match(c.listTasks()[0].reason,/timed out/);
  assert.equal(c.state().activeTaskId,null);
  assert.equal(c.state().robot.movement,'stopped');
});

test('v0.2: restore preserves task IDs and history but never resumes movement',()=>{
  const c=new HomeCore();
  const initial=nav(c,'story_corner','request_0003');
  c.tick(.2);
  const snapshot=c.snapshot();
  const resumed=new HomeCore();resumed.restore(snapshot);
  assert.equal(resumed.listTasks()[0].id,initial.task.id);
  assert.equal(resumed.listTasks()[0].status,'stopped');
  assert.equal(resumed.state().robot.movement,'idle');
  assert.equal(resumed.state().activeTaskId,null);
  assert.equal(nav(resumed,'sofa','request_0004').task.id,'task-2');
  assert.equal(nav(resumed,'story_corner','request_0003').task.status,'stopped');
  assert.throws(()=>resumed.restore({schemaVersion:1,tasks:[{}],taskSeq:1,sequence:1,events:[]}),/INVALID_SNAPSHOT/);
});

test('v0.2: trusted skill manifests validate capabilities and child permissions',()=>{
  const registry=new SkillRegistry(new PolicyEngine());
  registry.register({manifest:{id:'custom.parent',name:'Custom',description:'test',version:'1.0.0',enabled:true,capabilities:[],allowedActors:['parent']},execute:()=>({ok:true,message:'done'})});
  assert.equal(registry.invoke('custom.parent','parent').ok,true);
  assert.equal(registry.invoke('custom.parent','child').ok,false);
  registry.register({manifest:{id:'custom.motor',name:'Motor',description:'test',version:'1.0.0',enabled:true,capabilities:['navigation.goto'],allowedActors:['parent']},execute:()=>({ok:true,message:'done'})});
  assert.equal(registry.invoke('custom.motor','parent').ok,false);
  assert.throws(()=>registry.register({manifest:{id:'custom.parent',name:'Duplicate',description:'',version:'1.0.0',enabled:true,capabilities:[],allowedActors:['parent']},execute:()=>({ok:true,message:'x'})}),/INVALID_SKILL_MANIFEST/);
});

test('v0.2: file store writes atomically and reloads snapshot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-persist-'));
  try{
    const path=join(dir,'nested','state.json');
    const store=new JsonStateStore(path);
    assert.equal(await store.load(),null);
    const c=new HomeCore();nav(c,'sofa','request_0005');
    await Promise.all([store.save(c.snapshot()),store.save(c.snapshot())]);
    assert.equal((await readFile(path,'utf8')).includes('request_0005'),true);
    const next=new HomeCore();next.restore(await store.load());
    assert.equal(next.listTasks()[0].status,'stopped');
  }finally{await rm(dir,{recursive:true,force:true});}
});

async function waitHealth(base,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('SERVER_EXITED');try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('NOT_READY');}
async function shut(child){child.kill('SIGTERM');if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,1000))]);}

test('v0.2 HTTP: persisted task returns stopped after restart and replays requestId', {timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-http-'));
  const port=36000+Math.floor(Math.random()*10000);
  const base=`http://127.0.0.1:${port}`;
  const env={...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),AGENT_PROVIDER:'rules'};
  const start=()=>spawn(process.execPath,['scripts/server.mjs'],{cwd:repo,env,stdio:'ignore'});
  let child=start();
  try{
    await waitHealth(base,child);
    const post=(p,v)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)}).then(r=>r.json());
    const a=await post('/api/tasks',{actor:'parent',capability:'navigation.goto',params:{destination:'story_corner'},requestId:'request_http1'});
    assert.equal(a.ok,true);
    assert.equal(a.task.id,'task-1');
    await shut(child);child=start();await waitHealth(base,child);
    const s=await (await fetch(base+'/api/state')).json();
    assert.equal(s.tasks[0].status,'stopped');
    assert.equal(s.activeTaskId,null);
    const replay=await post('/api/tasks',{actor:'parent',capability:'navigation.goto',params:{destination:'story_corner'},requestId:'request_http1'});
    assert.equal(replay.task.id,'task-1');
    assert.equal(replay.task.status,'stopped');
    const next=await post('/api/tasks',{actor:'parent',capability:'navigation.goto',params:{destination:'sofa'},requestId:'request_http2'});
    assert.equal(next.task.id,'task-2');
  }finally{await shut(child);await rm(dir,{recursive:true,force:true});}
});
