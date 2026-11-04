#!/usr/bin/env node
// Virtual device client: prints and acknowledges simulated actions only.
// It NEVER connects to GPIOs, motors, smart home actuators or audio hardware.
const endpoint=new URL(process.env.ALEX_BASE_URL??'http://127.0.0.1:4317');
if(endpoint.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search)throw new Error('LOCAL_VIRTUAL_DEVICE_ONLY');
const deviceId=process.env.ALEX_DEVICE_ID,token=process.env.ALEX_DEVICE_TOKEN;
if(!/^dev-[0-9a-f-]{36}$/.test(deviceId??'')||!/^[0-9a-f]{64}$/.test(token??''))throw new Error('ALEX_DEVICE_ID_AND_TOKEN_REQUIRED');
const bearer={'Authorization':`Bearer ${token}`};
const caps=['sim.navigation.goto','display.face','audio.output'];
const sleep=t=>new Promise(resolve=>setTimeout(resolve,t));
const backend=process.env.ALEX_NAV_BACKEND??'grid';
const {VirtualPresentationRuntime}=await import('./virtual-presentation.mjs');
const presentation=new VirtualPresentationRuntime();
if(!['grid','ros2'].includes(backend))throw new Error('INVALID_NAV_BACKEND');
const {GridNavigationBridge}=await import('./navigation-simulator.mjs');
let nav;
if(backend==='ros2'){
  if(process.env.ALEX_ROS_SIMULATION_ONLY!=='1')throw new Error('ROS2_SIMULATION_ONLY_FLAG_REQUIRED');
  const {Nav2SimulationBridge}=await import('./ros2-navigation.mjs');
  nav=new Nav2SimulationBridge({simulationOnly:true});
}else nav=new GridNavigationBridge({stepDelayMs:Number(process.env.ALEX_SIM_STEP_MS??25),obstaclePresent:process.env.ALEX_SIM_OBSTACLE==='1'});

let stopping=false;const processed=new Set(),running=new Set(),cancelled=new Set();
async function request(path,method='GET',payload){
  const r=await fetch(new URL(path,endpoint),{method,headers:{...bearer,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(8000)});
  const result=await r.json();if(!r.ok)throw new Error(result.error||result.message||`HTTP_${r.status}`);return result;
}
async function heartbeat(){await request('/api/devices/heartbeat','POST',{deviceId});}
async function run(job){
  if(!job||job.deviceId!==deviceId||processed.has(job.id)||running.has(job.id)||cancelled.has(job.id))return;
  running.add(job.id);
  try{
    const started=await request('/api/gateway/result','POST',{deviceId,jobId:job.id,status:'running'});
    if(!started.ok)return;
    console.log(`[virtual] ${job.capability}: ${JSON.stringify(job.params)}`);
    if(job.capability==='sim.navigation.goto'){
      const outcome=await nav.navigate(job.params.destination,{
        isCancelled:()=>stopping||cancelled.has(job.id),
        onFeedback:async feedback=>{
          const result=await request('/api/gateway/telemetry','POST',{deviceId,jobId:job.id,...feedback});
          if(!result.ok)throw new Error(result.message||'NAVIGATION_FEEDBACK_REJECTED');
        }
      });
      if(outcome.status==='cancelled')return;
      if(outcome.status!=='arrived'){
        await request('/api/gateway/result','POST',{deviceId,jobId:job.id,status:'failed',reason:'Simulated route blocked'});
        return;
      }
    }else if(['display.face','audio.output'].includes(job.capability)){
      const observed=await presentation.render(job,{
        isCancelled:()=>stopping||cancelled.has(job.id)
      });
      if(!observed)return;
      const receipt=await request('/api/gateway/presentation','POST',{
        deviceId,jobId:job.id,sequence:1,phase:'rendered',
        kind:job.capability,observed
      });
      if(!receipt.ok)throw new Error('VIRTUAL_PRESENTATION_REJECTED');
    }else throw new Error('UNSUPPORTED_VIRTUAL_CAPABILITY');
    if(cancelled.has(job.id)||stopping)return;
    const finished=await request('/api/gateway/result','POST',{deviceId,jobId:job.id,status:'succeeded'});
    if(finished.ok){processed.add(job.id);console.log(`[virtual] completed ${job.id}`);}
  }catch(e){if(!stopping){console.error('[virtual] task:',e.message);try{await request('/api/gateway/result','POST',{deviceId,jobId:job.id,status:'failed',reason:'Navigation simulation error'});}catch{}}}
  finally{running.delete(job.id);}
}
async function receive(){
  const url=new URL(`/api/gateway/stream?deviceId=${encodeURIComponent(deviceId)}`,endpoint);
  const r=await fetch(url,{headers:bearer});if(!r.ok)throw new Error(`STREAM_HTTP_${r.status}`);
  let buffer='',event='';
  for await (const data of r.body){
    if(stopping)break;
    buffer+=new TextDecoder().decode(data,{stream:true});
    if(buffer.length>64_000)throw new Error('INVALID_STREAM_FRAME');
    const lines=buffer.split('\n');buffer=lines.pop()??'';
    for(const line of lines){
      if(line.startsWith('event: '))event=line.slice(7).trim();
      if(!line.startsWith('data: '))continue;
      const message=JSON.parse(line.slice(6));
      if(event==='ready')for(const job of message.pending??[])void run(job);
      if(event==='gateway-event'){
        if(message.type==='job.queued')void run(message.job);
        if(message.type==='job.cancelled'&&message.job)cancelled.add(message.job.id);
        if(message.type==='device.revoked')throw new Error('DEVICE_REVOKED');
      }
    }
  }
}
process.on('SIGINT',()=>{stopping=true;process.exit(0);});
process.on('SIGTERM',()=>{stopping=true;process.exit(0);});
// Fail clearly before sending device credentials to a demo server.
async function assertLocalFamilyServer() {
  let response;
  try {
    response=await fetch(new URL('/api/health',endpoint),{signal:AbortSignal.timeout(5000)});
  } catch {
    throw new Error('ALEX_SERVER_UNREACHABLE: start Alex using bash scripts/start-local.sh on port 4317');
  }
  if(!response.ok)throw new Error(`ALEX_SERVER_HEALTH_HTTP_${response.status}`);
  const health=await response.json();
  if(health.authMode!=='local'){
    throw new Error('LOCAL_AUTH_REQUIRED: the running server is in demo mode; stop it, then run bash scripts/start-local.sh before starting the virtual device');
  }
}
await assertLocalFamilyServer();
await request('/api/devices/capabilities','POST',{deviceId,capabilities:caps,protocolVersion:3});
await heartbeat();
console.log(`[virtual] ${deviceId} connected; navigation backend=${backend}; waiting for parent capability approval`);
const timer=setInterval(()=>heartbeat().catch(e=>console.error('[virtual] heartbeat:',e.message)),10000);
try{
  while(!stopping){
    try{await heartbeat();await receive();}
    catch(e){if(e.message==='DEVICE_REVOKED'||e.message.includes('401')){console.error('[virtual] authorization revoked');break;}console.error('[virtual] stream reconnect:',e.message);}
    if(!stopping)await sleep(1000);
  }
}finally{clearInterval(timer);}
