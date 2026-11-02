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
    await sleep(350); // synthetic delay only; NOT a simulated physical path or motor controller.
    if(cancelled.has(job.id))return;
    const finished=await request('/api/gateway/result','POST',{deviceId,jobId:job.id,status:'succeeded'});
    if(finished.ok){processed.add(job.id);console.log(`[virtual] completed ${job.id}`);}
  }catch(e){if(!stopping)console.error('[virtual] task:',e.message);}
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
await request('/api/devices/capabilities','POST',{deviceId,capabilities:caps,protocolVersion:1});
await heartbeat();
console.log(`[virtual] ${deviceId} connected; waiting for parent capability approval`);
const timer=setInterval(()=>heartbeat().catch(e=>console.error('[virtual] heartbeat:',e.message)),10000);
try{
  while(!stopping){
    try{await heartbeat();await receive();}
    catch(e){if(e.message==='DEVICE_REVOKED'||e.message.includes('401')){console.error('[virtual] authorization revoked');break;}console.error('[virtual] stream reconnect:',e.message);}
    if(!stopping)await sleep(1000);
  }
}finally{clearInterval(timer);}
