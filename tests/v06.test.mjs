import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';
import {WorkflowOrchestrator,parseWorkflowCommand} from '../scripts/workflow-orchestrator.mjs';
import {HomeCore} from '../dist/index.js';
const cwd=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const rid=()=>`request_${randomUUID().replaceAll('-','')}`;
async function terminate(proc){if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([once(proc,'exit'),delay(1800)]);}}
async function waitHealth(base,proc){for(let i=0;i<70;i++){if(proc.exitCode!==null)throw new Error('server exited');try{if((await fetch(base+'/api/health')).ok)return;}catch{}await delay(80);}throw new Error('server did not start');}
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'alex-v06-unit-'));let now=Date.now();const clock=()=>now;
 const registry=new DeviceRegistry(join(dir,'devices.json'),{clock});
 const gateway=new DeviceGateway(join(dir,'gateway.json'),registry,{clock,freshMs:10_000});
 const core=new HomeCore();const workflows=new WorkflowOrchestrator(join(dir,'workflows.json'),{gateway,registry,skills:core.skills,clock,timeoutMs:20000});
 const pair=async()=>{const p=registry.start('parent'),d=await registry.complete(p.code,'Virtual');await gateway.announce(d.deviceId,d.token,['sim.navigation.goto','audio.output'],1);await registry.heartbeat(d.deviceId,d.token);await gateway.approve('parent',d.deviceId,['sim.navigation.goto','audio.output']);return d;};
 const finish=async(d,id)=>{assert.equal((await gateway.result(d.deviceId,d.token,{jobId:id,status:'running'})).ok,true);assert.equal((await gateway.result(d.deviceId,d.token,{jobId:id,status:'succeeded'})).ok,true);};
 return {dir,registry,gateway,core,workflows,clock,pair,finish,advance:ms=>now+=ms,close:()=>rm(dir,{recursive:true,force:true})};
}
test('v0.6: deterministic parser supports only allowlisted composite instructions',()=>{
 assert.equal(parseWorkflowCommand('Alex，去书桌陪我学英语'),'study.english');
 assert.equal(parseWorkflowCommand('go to story corner and tell a story'),'story.corner');
 assert.equal(parseWorkflowCommand('打开电机并全速前进'),null);
 assert.equal(parseWorkflowCommand('学英语'),null);
});
test('v0.6: navigation -> skill -> audio -> success, with idempotent requests',async()=>{
 const t=await setup();try{const d=await t.pair();await t.workflows.load();const input={recipe:'study.english',requestId:rid()};
 const r=await t.workflows.start('parent',input);assert.equal(r.ok,true);assert.equal(r.workflow.status,'navigating');
 assert.equal((await t.workflows.start('parent',input)).workflow.id,r.workflow.id);
 assert.equal((await t.workflows.start('parent',{...input,recipe:'story.corner'})).message,'IDEMPOTENCY_CONFLICT');
 await t.workflows.tick();assert.equal(t.workflows.get(r.workflow.id).status,'navigating');
 await t.finish(d,r.workflow.navigationJobId);await t.workflows.tick();
 const s=t.workflows.get(r.workflow.id);assert.equal(s.status,'speaking');assert.deepEqual(s.steps.map(x=>x.status),['succeeded','succeeded','running']);
 assert.equal(t.gateway.list().find(j=>j.id===s.audioJobId).capability,'audio.output');
 await t.finish(d,s.audioJobId);await t.workflows.tick();
 const end=t.workflows.get(r.workflow.id);assert.equal(end.status,'succeeded');assert.deepEqual(end.steps.map(x=>x.status),['succeeded','succeeded','succeeded']);
 assert.doesNotMatch(await readFile(join(t.dir,'workflows.json'),'utf8'),new RegExp(d.token));
 }finally{await t.close();}
});
test('v0.6: child cannot start or cancel composite motion, unapproved/offline devices fail closed',async()=>{
 const t=await setup();try{
 await assert.rejects(()=>t.workflows.start('child',{recipe:'study.english',requestId:rid()}),/PARENT_REQUIRED/);
 const no=await t.workflows.start('parent',{recipe:'study.english',requestId:rid()});assert.equal(no.message,'NO_APPROVED_AVAILABLE_DEVICE');
 const d=await t.pair();t.advance(11000);
 const stale=await t.workflows.start('parent',{recipe:'study.english',requestId:rid()});assert.equal(stale.message,'NO_APPROVED_AVAILABLE_DEVICE');
 await t.registry.heartbeat(d.deviceId,d.token);
 const ok=await t.workflows.start('parent',{recipe:'study.english',requestId:rid()});assert.equal(ok.ok,true);
 await assert.rejects(()=>t.workflows.cancel('child',ok.workflow.id),/PARENT_REQUIRED/);
 const conflict=await t.workflows.start('parent',{recipe:'story.corner',requestId:rid()});assert.equal(conflict.message,'NO_APPROVED_AVAILABLE_DEVICE');
 await t.workflows.cancel('parent',ok.workflow.id);
 assert.equal(t.gateway.list().find(j=>j.id===ok.workflow.navigationJobId).status,'cancelled');
 await t.workflows.tick();assert.equal(t.workflows.get(ok.workflow.id).status,'cancelled');
 }finally{await t.close();}
});
test('v0.6: cancelled navigation cannot trigger a skill, including after restart',async()=>{
 const t=await setup();try{
 const d=await t.pair(),r=await t.workflows.start('parent',{recipe:'study.english',requestId:rid()});
 await t.gateway.cancel('parent',r.workflow.navigationJobId);await t.workflows.tick();
 assert.equal(t.workflows.get(r.workflow.id).status,'stopped');assert.equal(t.gateway.list().filter(j=>j.capability==='audio.output').length,0);
 const q=await t.workflows.start('parent',{recipe:'story.corner',requestId:rid()});assert.equal(q.ok,true);
 const fresh=new WorkflowOrchestrator(join(t.dir,'workflows.json'),{gateway:t.gateway,registry:t.registry,skills:t.core.skills});await fresh.load();
 assert.equal(fresh.get(q.workflow.id).status,'stopped');
 await fresh.tick();assert.equal(t.gateway.list().filter(j=>j.capability==='audio.output').length,0);
 // Prevent a queued-but-interrupted job being treated as a fresh instruction.
 const restarted=new DeviceGateway(join(t.dir,'gateway.json'),t.registry);await restarted.load();
 assert.equal(restarted.list().find(j=>j.id===q.workflow.navigationJobId).status,'stopped');
 }finally{await t.close();}
});
test('v0.6: revoke capability after arrival prevents skill and audio',async()=>{
 const t=await setup();try{
 const d=await t.pair(),r=await t.workflows.start('parent',{recipe:'study.english',requestId:rid()});
 await t.finish(d,r.workflow.navigationJobId);await t.gateway.approve('parent',d.deviceId,['sim.navigation.goto']);
 await t.workflows.tick();assert.equal(t.workflows.get(r.workflow.id).status,'stopped');
 assert.equal(t.gateway.list().filter(j=>j.capability==='audio.output').length,0);
 }finally{await t.close();}
});
test('v0.6: expired workflow cancels virtual job and never runs skill',async()=>{
 const t=await setup();try{
 const d=await t.pair(),r=await t.workflows.start('parent',{recipe:'study.english',requestId:rid()});
 t.advance(25000);await t.workflows.tick();assert.equal(t.workflows.get(r.workflow.id).status,'stopped');
 assert.equal(t.gateway.list().find(j=>j.id===r.workflow.navigationJobId).status,'cancelled');
 assert.equal(t.gateway.list().filter(j=>j.capability==='audio.output').length,0);
 }finally{await t.close();}
});
test('v0.6 HTTP: authenticated workflow dispatch, real virtual client, success and restart safety',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-v06-http-')),port=45000+Math.floor(Math.random()*11000),base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),WORKFLOW_FILE:join(dir,'workflows.json'),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'a-unique-local-parent-password',ALEX_CHILD_PIN:'445566',AGENT_PROVIDER:'rules'};
 const launch=()=>spawn(process.execPath,['scripts/server.mjs'],{cwd,env,stdio:'ignore'});
 let proc=launch(),sim=null;
 const post=async(path,data,cookie,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});return {status:r.status,value:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const get=async(path,cookie)=>{const r=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});return {status:r.status,value:await r.json()};};
 try{
 await waitHealth(base,proc);
 let parent=(await post('/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
 const child=(await post('/api/auth/login',{role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
 assert.equal((await get('/api/workflows')).status,401);
 assert.equal((await post('/api/workflows/start',{recipe:'study.english',requestId:rid()},child)).status,403);
 const pairing=await post('/api/devices/pair/start',{},parent);
 const d=(await post('/api/devices/pair/complete',{code:pairing.value.code,name:'Alex Test Robot'})).value;
 sim=spawn(process.execPath,['scripts/virtual-device.mjs'],{cwd,env:{...env,ALEX_BASE_URL:base,ALEX_DEVICE_ID:d.deviceId,ALEX_DEVICE_TOKEN:d.token},stdio:'ignore'});
 let announced=false;for(let i=0;i<65;i++){
 const row=(await get('/api/devices',parent)).value.devices.find(x=>x.id===d.deviceId);
 if(row?.declaredCapabilities?.includes('audio.output')){announced=true;break;}await delay(80);
 }assert.equal(announced,true);
 assert.equal((await post('/api/devices/capabilities/approve',{deviceId:d.deviceId,capabilities:['sim.navigation.goto','audio.output']},parent)).status,200);
 const created=await post('/api/workflows/command',{text:'去书桌陪我学英语',requestId:rid()},parent);
 assert.equal(created.status,200);assert.equal(created.value.workflow.recipe,'study.english');
 let completed=null;
 for(let i=0;i<100;i++){
 const w=(await get('/api/workflows',parent)).value.workflows.find(x=>x.id===created.value.workflow.id);
 if(w?.status==='succeeded'){completed=w;break;}await delay(100);
 }
 assert.ok(completed,'workflow should finish with a real virtual client');
 assert.deepEqual(completed.steps.map(s=>s.name),['navigation','skill','audio']);
 const audit=(await get('/api/audit',parent)).value.events;assert.ok(audit.some(e=>e.action==='/api/workflows/command'));
 const second=await post('/api/command',{text:'Alex，去书桌陪我学英语',requestId:rid()},parent);assert.equal(second.status,200);assert.equal(second.value.workflow.recipe,'study.english');
 await terminate(sim);sim=null;await terminate(proc);proc=launch();await waitHealth(base,proc);
 parent=(await post('/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
 assert.equal((await get('/api/workflows',parent)).value.workflows.find(x=>x.id===second.value.workflow.id).status,'stopped');
 }finally{if(sim)await terminate(sim);await terminate(proc);await rm(dir,{recursive:true,force:true});}
});

test('v0.6: companion control panel exposes workflow form and IDs',async()=>{
 const [html,script]=await Promise.all([readFile(join(cwd,'public/index.html'),'utf8'),readFile(join(cwd,'public/app.js'),'utf8')]);
 for(const id of ['workflow-section','workflow-form','workflow-list','workflow-recipe','workflow-device'])assert.ok(html.includes(`id="${id}"`));
 assert.match(script,/\/api\/workflows\/start/);
 assert.match(script,/\/api\/workflows\/cancel/);
});
