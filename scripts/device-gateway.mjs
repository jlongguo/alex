import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {MAP, occupied} from '../dist/robot/map.js';
import {SIM_MAP_VERSION} from './navigation-simulator.mjs';

// IMPORTANT: commands in v0.5 are virtual presentation/simulation commands only.
// There is no actuator/motor transport, and no generic device execute endpoint.
export const VIRTUAL_CAPABILITIES=Object.freeze(['sim.navigation.goto','display.face','audio.output']);
const destinations=['dock','study_desk','sofa','story_corner'];
const faces=['neutral','happy','sleepy'];
const terminal=new Set(['succeeded','failed','stopped','cancelled']);
const safeString=(s,max)=>typeof s==='string'&&s.length>0&&s.length<=max;
const sameJson=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validateCapabilities=c=>{
  if(!Array.isArray(c)||c.length>VIRTUAL_CAPABILITIES.length||new Set(c).size!==c.length||c.some(x=>!VIRTUAL_CAPABILITIES.includes(x)))throw new Error('INVALID_DEVICE_CAPABILITIES');
  return [...c].sort();
};
export function validateVirtualAction(capability,params){
  if(!VIRTUAL_CAPABILITIES.includes(capability)||!params||typeof params!=='object'||Array.isArray(params))throw new Error('INVALID_GATEWAY_ACTION');
  const keys=Object.keys(params);
  if(capability==='sim.navigation.goto'&&keys.length===1&&keys[0]==='destination'&&destinations.includes(params.destination))return {destination:params.destination};
  if(capability==='display.face'&&keys.length===1&&keys[0]==='expression'&&faces.includes(params.expression))return {expression:params.expression};
  if(capability==='audio.output'&&keys.length===1&&keys[0]==='text'&&safeString(params.text,200))return {text:params.text};
  throw new Error('INVALID_GATEWAY_ACTION');
}

export class DeviceGateway {
  constructor(file,registry,{clock=()=>Date.now(),freshMs=30_000,timeoutMs=60_000}={}){
    this.store=new JsonStateStore(file);this.registry=registry;this.clock=clock;this.freshMs=freshMs;this.timeoutMs=timeoutMs;
    this.jobs=[];this.listeners=new Map();this.serial=Promise.resolve();
  }
  #exclusive(fn){const op=this.serial.catch(()=>{}).then(fn);this.serial=op.catch(()=>{});return op;}
  async load(){
    const snapshot=await this.store.load();if(!snapshot)return;
    if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.jobs)||snapshot.jobs.length>200)throw new Error('INVALID_GATEWAY_STATE');
    const ids=new Set();
    this.jobs=snapshot.jobs.map(j=>{
      if(!j||!/^job-[0-9a-f-]{36}$/.test(j.id)||ids.has(j.id)||!safeString(j.deviceId,80)||!['queued','running','succeeded','failed','stopped','cancelled'].includes(j.status)||!['parent','child'].includes(j.actor)||!Number.isFinite(j.createdMs)||!safeString(j.createdAt,60)||!safeString(j.updatedAt,60)||typeof j.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(j.requestId))throw new Error('INVALID_GATEWAY_STATE');
      validateVirtualAction(j.capability,j.params);ids.add(j.id);
      return {...j,status:terminal.has(j.status)?j.status:'stopped',reason:terminal.has(j.status)?j.reason:'Interrupted by server restart; not replayed',updatedAt:terminal.has(j.status)?j.updatedAt:new Date(this.clock()).toISOString()};
    });
    if(this.jobs.some((j,i)=>snapshot.jobs[i].status!==j.status))await this.save();
  }
  save(){return this.store.save({schemaVersion:1,jobs:this.jobs});}
  list(){return this.jobs.map(j=>({...j,params:{...j.params}}));}
  forDevice(id){return this.list().filter(j=>j.deviceId===id);}
  pending(id){return this.forDevice(id).filter(j=>j.status==='queued');}
  online(id){
    const d=this.registry.get(id);
    const seen=d?.lastSeenAt?Date.parse(d.lastSeenAt):0;
    return !!d&&!d.revoked&&Number.isFinite(seen)&&this.clock()-seen<=this.freshMs;
  }
  async announce(deviceId,token,capabilities,protocolVersion){
    if(![1,2].includes(protocolVersion))throw new Error('INVALID_PROTOCOL_VERSION');
    const caps=validateCapabilities(capabilities);
    await this.registry.announce(deviceId,token,caps,protocolVersion);
    // Declared capabilities are not permissions: parent must explicitly approve them.
    return {ok:true,deviceId,protocolVersion,declaredCapabilities:caps,approvedCapabilities:this.registry.get(deviceId)?.capabilities??[]};
  }
  async approve(actor,deviceId,capabilities){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    const caps=validateCapabilities(capabilities);
    await this.registry.approve(actor,deviceId,caps);
    return {ok:true,deviceId,approvedCapabilities:caps};
  }
  async dispatch(actor,{deviceId,capability,params,requestId}){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!safeString(deviceId,80))throw new Error('INVALID_DEVICE_ID');
    const sanitized=validateVirtualAction(capability,params);
    if(!safeString(requestId,100)||!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))throw new Error('INVALID_REQUEST_ID');
    return this.#exclusive(async()=>{
      const previous=this.jobs.find(j=>j.actor===actor&&j.requestId===requestId);
      if(previous){
        if(previous.deviceId!==deviceId||previous.capability!==capability||!sameJson(previous.params,sanitized))return {ok:false,message:'IDEMPOTENCY_CONFLICT'};
        return {ok:true,message:'Existing gateway task',job:{...previous}};
      }
      const device=this.registry.get(deviceId);
      if(!device||device.revoked)throw new Error('UNKNOWN_DEVICE');
      if(!device.capabilities.includes(capability))return {ok:false,message:'DEVICE_CAPABILITY_NOT_APPROVED'};
      if(!this.online(deviceId))return {ok:false,message:'DEVICE_OFFLINE'};
      if(capability==='sim.navigation.goto'&&this.jobs.some(j=>j.deviceId===deviceId&&j.capability===capability&&!terminal.has(j.status)))return {ok:false,message:'DEVICE_NAVIGATION_BUSY'};
      const now=this.clock();
      const job={id:`job-${randomUUID()}`,actor,deviceId,capability,params:sanitized,requestId,status:'queued',createdMs:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),reason:null};
      this.jobs.unshift(job);if(this.jobs.length>200)this.jobs.length=200;
      await this.save();this.#notify(deviceId,{type:'job.queued',job});
      return {ok:true,message:'Virtual device task queued',job:{...job}};
    });
  }
  async result(deviceId,token,{jobId,status,reason}){
    if(!this.registry.authenticate(deviceId,token))throw new Error('DEVICE_UNAUTHORIZED');
    if(!['running','succeeded','failed'].includes(status)||!safeString(jobId,80)||reason!==undefined&&(typeof reason!=='string'||reason.length>160))throw new Error('INVALID_GATEWAY_RESULT');
    return this.#exclusive(async()=>{
      const job=this.jobs.find(j=>j.id===jobId&&j.deviceId===deviceId);
      if(!job)throw new Error('UNKNOWN_GATEWAY_JOB');
      if(!this.registry.get(deviceId)?.capabilities.includes(job.capability))return {ok:false,message:'DEVICE_CAPABILITY_NOT_APPROVED'};
      if(job.status===status)return {ok:true,job:{...job},duplicate:true};
      if(terminal.has(job.status))return {ok:false,message:'TASK_ALREADY_TERMINAL'};
      if(status==='running'&&job.status!=='queued')return {ok:false,message:'INVALID_TASK_TRANSITION'};
      if(status==='succeeded'&&job.status!=='running')return {ok:false,message:'INVALID_TASK_TRANSITION'};
      if(status==='succeeded'&&job.capability==='sim.navigation.goto'&&this.registry.get(deviceId)?.protocolVersion===2 && (job.telemetry?.phase!=='arrived'||job.telemetry.progress!==100))return {ok:false,message:'NAVIGATION_ARRIVAL_EVIDENCE_REQUIRED'};
      job.status=status;job.updatedAt=new Date(this.clock()).toISOString();if(status==='failed')job.reason=reason||'Device reported failure';
      await this.save();this.#notify(deviceId,{type:'job.updated',job});
      return {ok:true,job:{...job}};
    });
  }
  async telemetry(deviceId,token,{jobId,sequence,phase,progress,pose,mapVersion}){
    if(!this.registry.authenticate(deviceId,token))throw new Error('DEVICE_UNAUTHORIZED');
    if(typeof jobId!=='string'||!/^job-[0-9a-f-]{36}$/.test(jobId)||!Number.isSafeInteger(sequence)||sequence<1||sequence>10000||!['planning','moving','arrived','blocked'].includes(phase)||!Number.isInteger(progress)||progress<0||progress>100||mapVersion!==SIM_MAP_VERSION||!pose||typeof pose!=='object'||Array.isArray(pose)||Object.keys(pose).sort().join(',')!=='heading,x,y'||![pose.x,pose.y,pose.heading].every(Number.isFinite)||pose.heading<-Math.PI-0.01||pose.heading>Math.PI+0.01||occupied(pose.x,pose.y))throw new Error('INVALID_NAVIGATION_FEEDBACK');
    if((phase==='arrived')!== (progress===100))throw new Error('INVALID_NAVIGATION_FEEDBACK');
    return this.#exclusive(async()=>{
      const job=this.jobs.find(j=>j.id===jobId&&j.deviceId===deviceId);
      if(!job)throw new Error('UNKNOWN_GATEWAY_JOB');
      if(job.capability!=='sim.navigation.goto'||job.status!=='running'||this.registry.get(deviceId)?.protocolVersion!==2||!this.registry.get(deviceId)?.capabilities.includes(job.capability))return {ok:false,message:'NAVIGATION_FEEDBACK_NOT_ALLOWED'};
      if(job.telemetry && sequence<=job.telemetry.sequence)return {ok:false,message:'NAVIGATION_FEEDBACK_OUT_OF_ORDER'};
      if(job.telemetry && progress<job.telemetry.progress)return {ok:false,message:'NAVIGATION_PROGRESS_REGRESSION'};
      if((!job.telemetry&&phase!=='planning')||(job.telemetry?.phase==='planning'&&!['planning','moving','arrived','blocked'].includes(phase))||(job.telemetry?.phase==='blocked'))return {ok:false,message:'INVALID_NAVIGATION_PHASE'};
      if(phase==='arrived'){
        const target=MAP.destinations[job.params.destination];
        if(Math.hypot(pose.x-target.x,pose.y-target.y)>0.5)return {ok:false,message:'NAVIGATION_TARGET_MISMATCH'};
      }
      if(job.telemetry?.phase==='arrived')return {ok:false,message:'NAVIGATION_ALREADY_ARRIVED'};
      job.telemetry={sequence,phase,progress,pose:{x:pose.x,y:pose.y,heading:pose.heading},mapVersion,updatedAt:new Date(this.clock()).toISOString()};
      job.updatedAt=job.telemetry.updatedAt;
      await this.save();this.#notify(deviceId,{type:'navigation.feedback',jobId,telemetry:job.telemetry});
      return {ok:true,jobId,telemetry:{...job.telemetry}};
    });
  }
  async cancel(actor,jobId){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return this.#exclusive(async()=>{
      const job=this.jobs.find(j=>j.id===jobId);
      if(!job)throw new Error('UNKNOWN_GATEWAY_JOB');
      if(terminal.has(job.status))return {ok:false,message:'TASK_ALREADY_TERMINAL'};
      job.status='cancelled';job.reason='Cancelled by parent';job.updatedAt=new Date(this.clock()).toISOString();
      await this.save();this.#notify(job.deviceId,{type:'job.cancelled',job});return {ok:true,job:{...job}};
    });
  }
  async disconnect(deviceId){
    return this.#exclusive(async()=>{
      const now=new Date(this.clock()).toISOString();let changed=false;
      for(const job of this.jobs.filter(j=>j.deviceId===deviceId&&!terminal.has(j.status))){job.status='stopped';job.reason='Device revoked';job.updatedAt=now;changed=true;}
      if(changed)await this.save();this.#notify(deviceId,{type:'device.revoked'});
      for(const connection of this.listeners.get(deviceId)??[])try{connection.end();}catch{}
      this.listeners.delete(deviceId);
    });
  }
  async expire(){
    return this.#exclusive(async()=>{
      const now=this.clock(),ts=new Date(now).toISOString();let changed=0;
      for(const job of this.jobs.filter(j=>!terminal.has(j.status))){
        if(now-job.createdMs>this.timeoutMs || !this.online(job.deviceId)){
          job.status='stopped';job.reason=!this.online(job.deviceId)?'Device disconnected or heartbeat stale':'Gateway task timed out';job.updatedAt=ts;changed++;
          this.#notify(job.deviceId,{type:'job.stopped',job});
        }
      }
      if(changed)await this.save();return changed;
    });
  }
  attach(deviceId,token,res){
    if(!this.registry.authenticate(deviceId,token))throw new Error('DEVICE_UNAUTHORIZED');
    if(!this.listeners.has(deviceId))this.listeners.set(deviceId,new Set());
    const listeners=this.listeners.get(deviceId);
    if(listeners.size>=3)throw new Error('DEVICE_CONNECTION_LIMIT');
    listeners.add(res);
    res.write(`event: ready\ndata: ${JSON.stringify({deviceId,pending:this.pending(deviceId)})}\n\n`);
    return ()=>{listeners.delete(res);if(!listeners.size)this.listeners.delete(deviceId);};
  }
  #notify(id,message){
    const frame=`event: gateway-event\ndata: ${JSON.stringify(message)}\n\n`;
    for(const res of this.listeners.get(id)??[])try{res.write(frame);}catch{ /* disconnected client cleanup on close */ }
  }
}
