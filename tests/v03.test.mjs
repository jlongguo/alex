import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FamilyAuth,AuditLog} from '../scripts/family-security.mjs';
import {FamilyMemory} from '../scripts/family-memory.mjs';

const cwd=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitHealth(base,proc){for(let i=0;i<60;i++){if(proc.exitCode!==null)throw new Error('server exited');try{if((await fetch(base+'/api/health')).ok)return;}catch{}await delay(80);}throw new Error('server not ready');}
async function stop(proc){if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([once(proc,'exit'),delay(1500)]);}}

test('v0.3: local auth validates parent secret, child PIN, expiry and ignores spoofed actor',()=>{
 const a=new FamilyAuth({mode:'local',parentPassword:'very-long-test-password',childPin:'778899'});
 assert.throws(()=>new FamilyAuth({mode:'local',parentPassword:'tiny'}),/PARENT_PASSWORD_REQUIRED/);
 const req={socket:{remoteAddress:'::1'},headers:{cookie:''}};
 assert.equal(a.current(req).authenticated,false);
 assert.throws(()=>a.login(req,{role:'parent',secret:'wrong'}),/INVALID_CREDENTIALS/);
 const parent=a.login(req,{role:'parent',secret:'very-long-test-password'});
 req.headers.cookie=parent.cookie.split(';')[0];
 assert.equal(a.actor(req,'child'),'parent');
 a.logout(req);
 assert.equal(a.current(req).authenticated,false);
 const child=a.login(req,{role:'child',secret:'778899'});
 req.headers.cookie=child.cookie.split(';')[0];
 assert.equal(a.actor(req,'parent'),'child');
});

test('v0.3: rate-limits repeated bad credentials',()=>{
 const a=new FamilyAuth({mode:'local',parentPassword:'very-long-test-password'});
 const req={socket:{remoteAddress:'127.0.0.8'},headers:{}};
 for(let i=0;i<5;i++)assert.throws(()=>a.login(req,{role:'parent',secret:'bad'}),/INVALID_CREDENTIALS/);
 assert.throws(()=>a.login(req,{role:'parent',secret:'very-long-test-password'}),/TOO_MANY_ATTEMPTS/);
});

test('v0.3: scoped family memory persists, child is read-only and cannot see parent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-memory-'));
 try{
  const file=join(dir,'memory.json'),memory=new FamilyMemory(file);
  await memory.add('parent','parent','private parent note');
  const kid=await memory.add('parent','child','likes dinosaur stories');
  await memory.add('parent','family','family board game on Sunday');
  assert.equal(memory.list('child').length,2);
  assert.equal(memory.list('child').some(x=>x.text.includes('private')),false);
  await assert.rejects(()=>memory.add('child','child','should fail'),/PARENT_REQUIRED/);
  const loaded=new FamilyMemory(file);await loaded.load();
  assert.equal(loaded.list('parent').length,3);
  assert.equal(await loaded.remove('parent',kid.id),true);
  assert.equal(loaded.list('child').length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('v0.3: audit persists metadata without raw password or utterance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-audit-'));
 try{
  const file=join(dir,'audit.jsonl'),log=new AuditLog(file);
  await log.record({actor:'parent',action:'/api/command',outcome:'allowed'});
  const rows=await log.recent();
  assert.equal(rows.length,1);
  assert.deepEqual(Object.keys(rows[0]).sort(),['action','actor','outcome','requestId','timestamp']);
  assert.equal((await readFile(file,'utf8')).includes('password'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('v0.3 HTTP: auth guards state, actor spoofing, audit and memory survive restart',{timeout:25000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-v03-http-'));
 const port=39000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'local-strong-password-123',ALEX_CHILD_PIN:'654321',AGENT_PROVIDER:'rules'};
 const start=()=>spawn(process.execPath,['scripts/server.mjs'],{cwd,env,stdio:'ignore'});
 let proc=start();
 const post=async(path,data,cookie)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const get=async(path,cookie)=>{const r=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});return {status:r.status,data:await r.json()};};
 try{
  await waitHealth(base,proc);
  assert.equal((await get('/api/state')).status,401);
  assert.equal((await get('/api/events')).status,401);
  assert.equal((await post('/api/tasks',{actor:'parent',capability:'navigation.goto',params:{destination:'sofa'}})).status,401);
  const bad=await post('/api/auth/login',{role:'parent',secret:'bad'});
  assert.equal(bad.status,401);
  const childLogin=await post('/api/auth/login',{role:'child',secret:'654321'});
  assert.equal(childLogin.status,200);
  const kid=childLogin.cookie;
  const spoofed=await post('/api/skills/invoke',{actor:'parent',id:'home.status'},kid);
  assert.equal(spoofed.status,409);
  const childMove=await post('/api/tasks',{actor:'parent',capability:'navigation.dock',params:{destination:'dock'}},kid);
  assert.equal(childMove.status,409);
  assert.equal((await get('/api/audit',kid)).status,403);
  const parentLogin=await post('/api/auth/login',{role:'parent',secret:'local-strong-password-123'});
  assert.equal(parentLogin.status,200);const parent=parentLogin.cookie;
  const memory=await post('/api/memory',{actor:'child',scope:'parent',text:'Our private home note'},parent);
  assert.equal(memory.status,200);
  const family=await post('/api/memory',{scope:'child',text:'Enjoys stories with friendly robots'},parent);
  assert.equal(family.status,200);
  assert.equal((await get('/api/memory',kid)).data.entries.length,1);
  assert.equal((await post('/api/memory',{scope:'family',text:'spoof'},kid)).status,403);
  assert.equal((await get('/api/memory',parent)).data.entries.length,2);
  const command=await post('/api/tasks',{actor:'child',capability:'navigation.goto',params:{destination:'sofa'},requestId:'auth_request_01'},parent);
  assert.equal(command.status,200);
  const audit=await get('/api/audit',parent);
  assert.equal(audit.status,200);
  assert.ok(audit.data.events.some(x=>x.action==='/api/tasks'));
  const raw=await readFile(join(dir,'audit.jsonl'),'utf8');
  assert.doesNotMatch(raw,/local-strong-password-123|Our private home note/);
  await stop(proc);proc=start();await waitHealth(base,proc);
  assert.equal((await get('/api/state',parent)).status,401); // sessions expire on restart
  const again=await post('/api/auth/login',{role:'parent',secret:'local-strong-password-123'});
  assert.equal(again.status,200);
  assert.equal((await get('/api/memory',again.cookie)).data.entries.length,2);
  const state=await get('/api/state',again.cookie);
  assert.equal(state.data.tasks[0].status,'stopped');
 }finally{await stop(proc);await rm(dir,{recursive:true,force:true});}
});
