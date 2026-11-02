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
const cwd=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fresh=()=>`request_${randomUUID().replaceAll('-','')}`;
async function terminate(proc){if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([once(proc,'exit'),delay(1500)]);}}
async function waitHealth(base,proc){for(let i=0;i<65;i++){if(proc.exitCode!==null)throw new Error('server exited');try{if((await fetch(base+'/api/health')).ok)return;}catch{}await delay(75);}throw new Error('server did not start');}

test('v0.5: gateway authorizes explicit grants, idempotency, transitions and replay safety',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-gateway-unit-'));let now=Date.now();
  try{
    const devices=new DeviceRegistry(join(dir,'devices.json'),{clock:()=>now});
    const gateway=new DeviceGateway(join(dir,'gateway.json'),devices,{clock:()=>now,freshMs:5000,timeoutMs:12000});
    await devices.load();await gateway.load();
    const p=devices.start('parent'),d=await devices.complete(p.code,'First');
    await assert.rejects(()=>gateway.announce(d.deviceId,'bad',['display.face'],1),/DEVICE_UNAUTHORIZED/);
    await gateway.announce(d.deviceId,d.token,['display.face','sim.navigation.goto'],1);
    await devices.heartbeat(d.deviceId,d.token);
    assert.equal((await gateway.dispatch('parent',{deviceId:d.deviceId,capability:'sim.navigation.goto',params:{destination:'dock'},requestId:fresh()})).message,'DEVICE_CAPABILITY_NOT_APPROVED');
    await assert.rejects(()=>gateway.approve('child',d.deviceId,['sim.navigation.goto']),/PARENT_REQUIRED/);
    await assert.rejects(()=>gateway.approve('parent',d.deviceId,['audio.output']),/INVALID_DEVICE_CAPABILITIES/);
    await gateway.approve('parent',d.deviceId,['sim.navigation.goto']);
    const input={deviceId:d.deviceId,capability:'sim.navigation.goto',params:{destination:'dock'},requestId:fresh()};
    const one=await gateway.dispatch('parent',input);assert.equal(one.ok,true);
    assert.equal(gateway.pending(d.deviceId).length,1);
    assert.equal((await gateway.dispatch('parent',input)).job.id,one.job.id);
    assert.equal((await gateway.dispatch('parent',{...input,params:{destination:'sofa'}})).message,'IDEMPOTENCY_CONFLICT');
    assert.equal((await gateway.result(d.deviceId,d.token,{jobId:one.job.id,status:'succeeded'})).ok,false);
    assert.equal((await gateway.result(d.deviceId,d.token,{jobId:one.job.id,status:'running'})).ok,true);
    assert.equal((await gateway.result(d.deviceId,d.token,{jobId:one.job.id,status:'succeeded'})).ok,true);
    assert.equal((await gateway.result(d.deviceId,d.token,{jobId:one.job.id,status:'succeeded'})).duplicate,true);
    assert.equal((await gateway.cancel('parent',one.job.id)).message,'TASK_ALREADY_TERMINAL');
    const next=await gateway.dispatch('parent',{...input,requestId:fresh()});assert.equal(next.ok,true);
    const restored=new DeviceGateway(join(dir,'gateway.json'),devices,{clock:()=>now});await restored.load();
    assert.equal(restored.list().find(j=>j.id===next.job.id).status,'stopped');
    assert.equal((await restored.result(d.deviceId,d.token,{jobId:next.job.id,status:'running'})).ok,false);
    now+=6000;assert.equal(gateway.online(d.deviceId),false);
    assert.equal((await gateway.dispatch('parent',{...input,requestId:fresh()})).message,'DEVICE_OFFLINE');
    assert.equal(await gateway.expire(),1);
    assert.doesNotMatch(await readFile(join(dir,'gateway.json'),'utf8'),new RegExp(d.token));
    await devices.revoke('parent',d.deviceId);await gateway.disconnect(d.deviceId);
    await assert.rejects(()=>gateway.result(d.deviceId,d.token,{jobId:one.job.id,status:'running'}),/DEVICE_UNAUTHORIZED/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('v0.5 HTTP: two devices, role checks, SSE/poll, agent route, revoke and restart', {timeout:28000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-v05-http-'));
  const port=41000+Math.floor(Math.random()*12000),base=`http://127.0.0.1:${port}`;
  const env={...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'a-long-parent-password',ALEX_CHILD_PIN:'112233',AGENT_PROVIDER:'rules'};
  const launch=()=>spawn(process.execPath,['scripts/server.mjs'],{cwd,env,stdio:'ignore'});
  const post=async(path,data,cookie,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});return {status:r.status,value:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const get=async(path,cookie,token)=>{const r=await fetch(base+path,{headers:{...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`}:{})}});return {status:r.status,value:await r.json()};};
  let proc=launch();let controller;
  try{
    await waitHealth(base,proc);
    let parent=(await post('/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
    const child=(await post('/api/auth/login',{role:'child',secret:'112233'})).cookie;
    const linked=[];
    for(let n=0;n<2;n++){
      const code=await post('/api/devices/pair/start',{},parent);
      const d=await post('/api/devices/pair/complete',{code:code.value.code,name:`Sim ${n}`});
      assert.equal(d.status,200);linked.push(d.value);
      assert.equal((await post('/api/devices/capabilities',{deviceId:d.value.deviceId,capabilities:['sim.navigation.goto','display.face'],protocolVersion:1},undefined,d.value.token)).status,200);
      assert.equal((await post('/api/devices/heartbeat',{deviceId:d.value.deviceId},undefined,d.value.token)).status,200);
    }
    const [a,b]=linked;
    assert.equal((await post('/api/devices/capabilities/approve',{deviceId:a.deviceId,capabilities:['sim.navigation.goto']},child)).status,403);
    assert.equal((await post('/api/devices/capabilities/approve',{deviceId:a.deviceId,capabilities:['sim.navigation.goto']},parent)).status,200);
    assert.equal((await post('/api/devices/capabilities/approve',{deviceId:b.deviceId,capabilities:['display.face']},parent)).status,200);
    const cmd={deviceId:a.deviceId,capability:'sim.navigation.goto',params:{destination:'study_desk'},requestId:fresh()};
    assert.equal((await post('/api/gateway/dispatch',cmd,child)).status,403);
    assert.equal((await post('/api/gateway/dispatch',cmd,parent)).status,200);
    const queued=await post('/api/gateway/dispatch',cmd,parent);assert.equal(queued.value.job.id,(await get('/api/gateway/poll?deviceId='+a.deviceId,undefined,a.token)).value.jobs[0].id);
    const attempt=await post('/api/gateway/result',{deviceId:a.deviceId,jobId:queued.value.job.id,status:'running'},undefined,b.token);
    assert.equal(attempt.status,401);
    const r1=await post('/api/gateway/result',{deviceId:a.deviceId,jobId:queued.value.job.id,status:'running'},undefined,a.token);assert.equal(r1.status,200);
    assert.equal((await post('/api/gateway/result',{deviceId:a.deviceId,jobId:queued.value.job.id,status:'succeeded'},undefined,a.token)).status,200);
    const incompatible=await post('/api/gateway/dispatch',{deviceId:b.deviceId,capability:'sim.navigation.goto',params:{destination:'dock'},requestId:fresh()},parent);assert.equal(incompatible.status,409);
    const expressed=await post('/api/gateway/dispatch',{deviceId:b.deviceId,capability:'display.face',params:{expression:'happy'},requestId:fresh()},parent);assert.equal(expressed.status,200);
    assert.equal((await get('/api/gateway/jobs',child)).status,403);
    const routed=await post('/api/command',{deviceId:a.deviceId,text:'去客厅',requestId:fresh()},parent);assert.equal(routed.status,200);
    assert.equal(routed.value.job.params.destination,'sofa');
    assert.equal((await post('/api/command',{deviceId:a.deviceId,text:'去客厅',requestId:fresh()},child)).status,403);
    const stream=await fetch(base+`/api/gateway/stream?deviceId=${a.deviceId}`,{headers:{Authorization:`Bearer ${a.token}`},signal:(controller=new AbortController()).signal});
    assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);controller.abort();
    assert.equal((await post('/api/devices/revoke',{deviceId:a.deviceId},parent)).status,200);
    assert.equal((await get('/api/gateway/poll?deviceId='+a.deviceId,undefined,a.token)).status,401);
    await terminate(proc);proc=launch();await waitHealth(base,proc);
    parent=(await post('/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
    const after=await get('/api/gateway/jobs',parent);
    assert.equal(after.status,200);
    assert.equal(after.value.jobs.find(j=>j.id===expressed.value.job.id).status,'stopped');
    assert.equal(after.value.jobs.find(j=>j.id===routed.value.job.id).status,'stopped');
    assert.equal((await get('/api/devices',parent)).value.devices.filter(x=>x.id.startsWith('dev-')).length,2);
  }finally{controller?.abort();await terminate(proc);await rm(dir,{recursive:true,force:true});}
});

test('v0.5 real virtual client: receives streamed command and sends success feedback',{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-v05-client-'));
  const port=41000+Math.floor(Math.random()*12000),base=`http://127.0.0.1:${port}`;
  const env={...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'a-unique-test-password',ALEX_CHILD_PIN:'445566',AGENT_PROVIDER:'rules'};
  const proc=spawn(process.execPath,['scripts/server.mjs'],{cwd,env,stdio:'ignore'});
  let simulator=null;
  const post=async(path,data,cookie,token)=>{
    const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
    return {status:r.status,value:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    await waitHealth(base,proc);
    const parent=(await post('/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
    const pairing=await post('/api/devices/pair/start',{},parent);
    const device=await post('/api/devices/pair/complete',{code:pairing.value.code,name:'Virtual SSE Device'});
    simulator=spawn(process.execPath,['scripts/virtual-device.mjs'],{cwd,env:{...env,ALEX_BASE_URL:base,ALEX_DEVICE_ID:device.value.deviceId,ALEX_DEVICE_TOKEN:device.value.token},stdio:'ignore'});
    let announced=false;
    for(let n=0;n<70;n++){
      const r=await fetch(base+'/api/devices',{headers:{Cookie:parent}});const body=await r.json();
      if(body.devices.find(x=>x.id===device.value.deviceId)?.declaredCapabilities?.includes('sim.navigation.goto')){announced=true;break;}
      await delay(75);
    }
    assert.equal(announced,true,'virtual client must announce capabilities');
    assert.equal((await post('/api/devices/capabilities/approve',{deviceId:device.value.deviceId,capabilities:['sim.navigation.goto']},parent)).status,200);
    const queued=await post('/api/gateway/dispatch',{deviceId:device.value.deviceId,capability:'sim.navigation.goto',params:{destination:'study_desk'},requestId:fresh()},parent);
    assert.equal(queued.status,200);
    let finished=false;
    for(let n=0;n<80;n++){
      const r=await fetch(base+'/api/gateway/jobs',{headers:{Cookie:parent}});
      const body=await r.json();
      if(body.jobs.find(x=>x.id===queued.value.job.id)?.status==='succeeded'){finished=true;break;}
      await delay(75);
    }
    assert.equal(finished,true,'virtual client should acknowledge streamed task completion');
  }finally{if(simulator)await terminate(simulator);await terminate(proc);await rm(dir,{recursive:true,force:true});}
});
