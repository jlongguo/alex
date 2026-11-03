import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const root=resolve(import.meta.dirname,'..');
const [html,app,css,guide]=await Promise.all([
  'public/index.html','public/app.js','public/styles.css','docs/PARENT_AUTH.md'
].map(path=>readFile(join(root,path),'utf8')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function launch(mode,dir){
  const port=41000+Math.floor(Math.random()*12000);
  const base='http://127.0.0.1:'+port;
  const proc=spawn(process.execPath,['scripts/server.mjs'],{
    cwd:root,stdio:'ignore',
    env:{...process.env,AUTH_MODE:mode,PORT:String(port),AGENT_PROVIDER:'rules',
      ALEX_PARENT_PASSWORD:'a-private-testing-password-123',ALEX_CHILD_PIN:'581946',
      STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
      MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),
      PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
      WORKFLOW_FILE:join(dir,'workflow.json'),PLAN_FILE:join(dir,'plan.json'),
      PROPOSAL_FILE:join(dir,'proposal.json')}
  });
  for(let i=0;i<80;i++){
    if(proc.exitCode!==null)throw Error('Server exited before ready');
    try{if((await fetch(base+'/api/health')).ok)return {proc,base};}catch{}
    await sleep(75);
  }
  proc.kill('SIGTERM');
  throw Error('Server timeout');
}
async function stop(proc){
  if(proc?.exitCode===null){
    proc.kill('SIGTERM');
    await Promise.race([once(proc,'exit'),sleep(1000)]);
  }
}
async function post(base,path,body,cookie){
  const res=await fetch(base+path,{
    method:'POST',
    headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    body:JSON.stringify(body)
  });
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

test('Parent authorization is discoverable from the header and restricted workspaces',()=>{
  for(const id of ['auth-entry','auth-session-status','auth-demo-guide','auth-demo-close'])
    assert.ok(html.includes('id="'+id+'"'),id+' missing');
  assert.equal((html.match(/data-parent-auth-entry/g)||[]).length,3);
  assert.match(css,/#auth-entry\{/);
  assert.match(app,/document\.querySelectorAll\('\[data-parent-auth-entry\]'\)/);
});

test('Demo role is never a validated parent and setup guide is explicit',()=>{
  assert.match(app,/演示模式 · 无家长授权/);
  assert.match(app,/session\.mode==='local'&&session\.authenticated/);
  assert.match(app,/if\(session\.mode==='demo'\)\{openAuthDialog\(session\);return;/);
  assert.match(guide,/演示角色切换不是已认证的家长会话/);
});

test('Child-to-parent switching logs out the child session before reloading',()=>{
  assert.match(app,/session\.actor==='child'/);
  assert.match(app,/fetch\('\/api\/auth\/logout',\{method:'POST'\}\)/);
  assert.match(app,/location\.reload\(\)/);
  assert.match(app,/openAuthDialog\(session\)/);
});

test('Local startup validates secret strength and child PIN before launching',{timeout:8000},()=>{
  const file=join(root,'scripts/start-local.sh');
  const syntax=spawnSync('bash',['-n',file],{encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  for(const [password,pin] of [['',''],['short',''],['a-strong-password-123','invalid']]){
    const res=spawnSync('bash',[file],{
      cwd:root,input:'',encoding:'utf8',timeout:3000,
      env:{...process.env,ALEX_PARENT_PASSWORD:password,ALEX_CHILD_PIN:pin}
    });
    assert.equal(res.status,2,res.stderr);
  }
});

test('Local HTTP auth enforces parent session, logout, and child read boundaries',{timeout:17000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-auth-entry-'));
  let proc;
  try{
    const server=await launch('local',dir);proc=server.proc;const {base}=server;
    const getSession=async cookie=>{
      const r=await fetch(base+'/api/auth/session',{headers:cookie?{Cookie:cookie}:{}});
      return r.json();
    };
    assert.deepEqual(await getSession(),{mode:'local',authenticated:false,actor:null});
    assert.equal((await post(base,'/api/auth/login',{role:'parent',secret:'bad'})).status,401);
    const parent=await post(base,'/api/auth/login',{role:'parent',secret:'a-private-testing-password-123'});
    assert.equal(parent.status,200);
    assert.deepEqual(await getSession(parent.cookie),{mode:'local',authenticated:true,actor:'parent'});
    assert.equal((await fetch(base+'/api/audit',{headers:{Cookie:parent.cookie}})).status,200);
    assert.equal((await post(base,'/api/auth/logout',{},parent.cookie)).status,200);
    assert.equal((await getSession(parent.cookie)).authenticated,false);
    const child=await post(base,'/api/auth/login',{role:'child',secret:'581946'});
    assert.equal(child.status,200);
    assert.deepEqual(await getSession(child.cookie),{mode:'local',authenticated:true,actor:'child'});
    assert.equal((await fetch(base+'/api/audit',{headers:{Cookie:child.cookie}})).status,403);
  }finally{await stop(proc);await rm(dir,{recursive:true,force:true});}
});

test('Demo HTTP rejects parent login rather than manufacturing an authenticated parent',{timeout:15000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-demo-entry-'));
  let proc;
  try{
    const server=await launch('demo',dir);proc=server.proc;const {base}=server;
    const current=await (await fetch(base+'/api/auth/session')).json();
    assert.equal(current.mode,'demo');assert.equal(current.actor,null);
    const login=await post(base,'/api/auth/login',{role:'parent',secret:'a-private-testing-password-123'});
    assert.equal(login.status,400);
    assert.equal(login.data.error,'AUTH_NOT_ENABLED');
    assert.notEqual((await fetch(base+'/api/audit')).status,200);
  }finally{await stop(proc);await rm(dir,{recursive:true,force:true});}
});
