import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DeviceRegistry} from '../scripts/device-registry.mjs';
import {DeviceGateway} from '../scripts/device-gateway.mjs';
import {GridNavigationBridge,SIM_MAP_VERSION} from '../scripts/navigation-simulator.mjs';

const cwd=resolve('.');
const fresh=()=>('v09_'+randomUUID().replaceAll('-',''));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'alex-v09-'));
  const registry=new DeviceRegistry(join(dir,'devices.json'));
  const code=registry.start('parent').code;
  const device=await registry.complete(code,'V09 simulator');
  const gateway=new DeviceGateway(join(dir,'gateway.json'),registry);
  await gateway.announce(device.deviceId,device.token,['sim.navigation.goto'],2);
  await gateway.approve('parent',device.deviceId,['sim.navigation.goto']);
  await registry.heartbeat(device.deviceId,device.token);
  const task=await gateway.dispatch('parent',{deviceId:device.deviceId,capability:'sim.navigation.goto',params:{destination:'study_desk'},requestId:fresh()});
  assert.equal(task.ok,true);
  return {dir,registry,gateway,device,job:task.job,close:()=>rm(dir,{recursive:true,force:true})};
}
const feedback=(f,params)=>f.gateway.telemetry(f.device.deviceId,f.device.token,{jobId:f.job.id,mapVersion:SIM_MAP_VERSION,...params});
const start=f=>f.gateway.result(f.device.deviceId,f.device.token,{jobId:f.job.id,status:'running'});
const finish=f=>f.gateway.result(f.device.deviceId,f.device.token,{jobId:f.job.id,status:'succeeded'});

test('v0.9 grid path includes intermediate waypoints and arrives at named goal',async()=>{
  const bridge=new GridNavigationBridge({stepDelayMs:0,stepsPerTick:5}),frames=[];
  const result=await bridge.navigate('study_desk',{onFeedback:async e=>frames.push(e)});
  assert.equal(result.status,'arrived');assert.deepEqual({x:result.pose.x,y:result.pose.y},{x:17,y:16});
  assert.ok(frames.length>2);assert.equal(frames[0].phase,'planning');assert.equal(frames.at(-1).phase,'arrived');
  assert.ok(frames.some(e=>e.phase==='moving'&&e.progress>0&&e.progress<100));
});
test('v0.9 simulated navigation cancels without reaching destination',async()=>{
  const bridge=new GridNavigationBridge({stepDelayMs:0,stepsPerTick:1});let count=0;
  const result=await bridge.navigate('story_corner',{onFeedback:async()=>{count++},isCancelled:()=>count>2});
  assert.equal(result.status,'cancelled');assert.notDeepEqual({x:result.pose.x,y:result.pose.y},{x:49,y:17});
});
test('v0.9 v2 navigation requires proof of arrival and authenticated device token',async()=>{
  const f=await setup();
  try{
    await start(f);
    assert.equal((await finish(f)).message,'NAVIGATION_ARRIVAL_EVIDENCE_REQUIRED');
    await assert.rejects(()=>f.gateway.telemetry(f.device.deviceId,'0'.repeat(64),{jobId:f.job.id,mapVersion:SIM_MAP_VERSION,sequence:1,phase:'planning',progress:0,pose:{x:7,y:28,heading:0}}),/DEVICE_UNAUTHORIZED/);
    const first={sequence:1,phase:'planning',progress:0,pose:{x:7,y:28,heading:0}};
    assert.equal((await feedback(f,first)).ok,true);
    assert.equal((await feedback(f,first)).message,'NAVIGATION_FEEDBACK_OUT_OF_ORDER');
    await assert.rejects(()=>feedback(f,{...first,sequence:2,progress:101}),/INVALID_NAVIGATION_FEEDBACK/);
  }finally{await f.close()}
});
test('v0.9 forged destination and regressive telemetry are rejected',async()=>{
  const f=await setup();try{
    await start(f);
    assert.equal((await feedback(f,{sequence:1,phase:'planning',progress:0,pose:{x:7,y:28,heading:0}})).ok,true);
    assert.equal((await feedback(f,{sequence:2,phase:'arrived',progress:100,pose:{x:7,y:28,heading:0}})).message,'NAVIGATION_TARGET_MISMATCH');
    assert.equal((await feedback(f,{sequence:2,phase:'moving',progress:50,pose:{x:17,y:18,heading:0}})).ok,true);
    assert.equal((await feedback(f,{sequence:3,phase:'moving',progress:49,pose:{x:17,y:17,heading:0}})).message,'NAVIGATION_PROGRESS_REGRESSION');
    assert.equal((await feedback(f,{sequence:3,phase:'arrived',progress:100,pose:{x:17,y:16,heading:0}})).ok,true);
    assert.equal((await finish(f)).ok,true);
    assert.equal((await feedback(f,{sequence:4,phase:'moving',progress:99,pose:{x:17,y:16,heading:0}})).message,'NAVIGATION_FEEDBACK_NOT_ALLOWED');
  }finally{await f.close()}
});
test('v0.9 navigation on one device is exclusive and capability revocation is enforced',async()=>{
  const f=await setup();try{
    assert.equal((await f.gateway.dispatch('parent',{deviceId:f.device.deviceId,capability:'sim.navigation.goto',params:{destination:'sofa'},requestId:fresh()})).message,'DEVICE_NAVIGATION_BUSY');
    await start(f);await f.registry.approve('parent',f.device.deviceId,[]);
    assert.equal((await feedback(f,{sequence:1,phase:'planning',progress:0,pose:{x:7,y:28,heading:0}})).message,'NAVIGATION_FEEDBACK_NOT_ALLOWED');
    assert.equal((await finish(f)).message,'DEVICE_CAPABILITY_NOT_APPROVED');
    await f.gateway.cancel('parent',f.job.id);assert.equal(f.gateway.list()[0].status,'cancelled');
  }finally{await f.close()}
});
test('v0.9 restart retains last pose but never replays unfinished navigation',async()=>{
  const f=await setup();try{
    await start(f);await feedback(f,{sequence:1,phase:'planning',progress:0,pose:{x:7,y:28,heading:0}});
    const restored=new DeviceGateway(join(f.dir,'gateway.json'),f.registry);await restored.load();
    assert.equal(restored.list()[0].status,'stopped');
    assert.equal((await restored.telemetry(f.device.deviceId,f.device.token,{jobId:f.job.id,mapVersion:SIM_MAP_VERSION,sequence:2,phase:'moving',progress:5,pose:{x:7,y:27,heading:0}})).message,'NAVIGATION_FEEDBACK_NOT_ALLOWED');
  }finally{await f.close()}
});
async function ready(base,proc){
  for(let i=0;i<80;i++){if(proc.exitCode!==null)throw new Error('SERVER_EXITED');try{if((await fetch(base+'/api/health')).ok)return}catch{}await delay(100)}
  throw new Error('SERVER_NOT_READY');
}
async function stop(proc){
  if(!proc||proc.exitCode!==null)return;
  proc.kill('SIGTERM');await Promise.race([new Promise(r=>proc.once('exit',r)),delay(4000)]);
  if(proc.exitCode===null)proc.kill('SIGKILL');
}
test('v0.9 real virtual client returns authenticated pose telemetry over HTTP and SSE',{timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-v09-http-'));
  const port=44000+Math.floor(Math.random()*8000),base='http://127.0.0.1:'+port;
  const env={...process.env,PORT:String(port),AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'v09-unique-secret-password',ALEX_CHILD_PIN:'112233',STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),PROPOSAL_FILE:join(dir,'proposals.json')};
  const server=spawn(process.execPath,['scripts/server.mjs'],{cwd,env,stdio:'ignore'});let client;
  async function post(path,data,cookie,token){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
  async function get(path,cookie){const r=await fetch(base+path,{headers:{...(cookie?{Cookie:cookie}:{})}});return {status:r.status,body:await r.json()}}
  try{
    await ready(base,server);
    const parent=(await post('/api/auth/login',{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
    const child=(await post('/api/auth/login',{role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
    assert.equal((await get('/api/gateway/navigation-map',child)).status,403);
    assert.equal((await get('/api/gateway/navigation-map',parent)).body.map.cellMeters,0.1);
    const pair=await post('/api/devices/pair/start',{},parent);
    const dev=(await post('/api/devices/pair/complete',{code:pair.body.code,name:'V09 client'})).body;
    client=spawn(process.execPath,['scripts/virtual-device.mjs'],{cwd,env:{...env,ALEX_BASE_URL:base,ALEX_DEVICE_ID:dev.deviceId,ALEX_DEVICE_TOKEN:dev.token,ALEX_SIM_STEP_MS:'15'},stdio:'ignore'});
    let connected=false;
    for(let i=0;i<75;i++){const d=(await get('/api/devices',parent)).body.devices.find(x=>x.id===dev.deviceId);if(d?.protocolVersion>=2&&d.declaredCapabilities?.includes('sim.navigation.goto')){connected=true;break}await delay(75)}
    assert.ok(connected);
    assert.equal((await post('/api/devices/capabilities/approve',{deviceId:dev.deviceId,capabilities:['sim.navigation.goto']},parent)).status,200);
    const started=await post('/api/gateway/dispatch',{deviceId:dev.deviceId,capability:'sim.navigation.goto',params:{destination:'study_desk'},requestId:fresh()},parent);
    assert.equal(started.status,200);
    let final;
    for(let i=0;i<110;i++){final=(await get('/api/gateway/jobs',parent)).body.jobs.find(j=>j.id===started.body.job.id);if(['succeeded','failed','stopped'].includes(final.status))break;await delay(75)}
    assert.equal(final.status,'succeeded');assert.equal(final.telemetry.phase,'arrived');assert.equal(final.telemetry.progress,100);
    assert.equal(final.telemetry.pose.x,17);assert.equal(final.telemetry.pose.y,16);
  }finally{await stop(client);await stop(server);await rm(dir,{recursive:true,force:true})}
});
