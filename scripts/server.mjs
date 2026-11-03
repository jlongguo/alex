import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeCore,CompatibleAgentProvider,RuleAgentProvider,validateProposal } from '../dist/index.js';
import {JsonStateStore} from './state-store.mjs';
import {FamilyAuth,AuditLog} from './family-security.mjs';
import {FamilyMemory} from './family-memory.mjs';
import {DeviceRegistry} from './device-registry.mjs';
import {FamilyProfiles} from './family-profiles.mjs';
import {DeviceGateway} from './device-gateway.mjs';
import {MAP} from '../dist/robot/map.js';
import {WorkflowOrchestrator,WORKFLOW_RECIPES,parseWorkflowCommand} from './workflow-orchestrator.mjs';
import {PlanOrchestrator} from './plan-orchestrator.mjs';
import {PlanProposals,RulePlanProvider,CompatiblePlanProvider} from './plan-proposals.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(appDir, 'public');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '4317');
if (!['127.0.0.1','::1','localhost'].includes(host)) throw new Error('LOOPBACK_HOST_ONLY');
const auth=new FamilyAuth({mode:process.env.AUTH_MODE??'demo',parentPassword:process.env.ALEX_PARENT_PASSWORD,childPin:process.env.ALEX_CHILD_PIN});
if(auth.mode==='demo')console.warn('INSECURE DEMO MODE: no authentication; loopback access only. Set AUTH_MODE=local for family use.');
const audit=new AuditLog(process.env.AUDIT_FILE??resolve(appDir,'.local','audit.jsonl'));
const memory=new FamilyMemory(process.env.MEMORY_FILE??resolve(appDir,'.local','memory.json'));
const devices=new DeviceRegistry(process.env.DEVICES_FILE??resolve(appDir,'.local','devices.json'));
const profiles=new FamilyProfiles(process.env.PROFILES_FILE??resolve(appDir,'.local','profiles.json'));
const gateway=new DeviceGateway(process.env.GATEWAY_FILE??resolve(appDir,'.local','gateway.json'),devices);
const deviceStreamClients=new Set();
const agentMemoryEnabled=process.env.AGENT_MEMORY_CONTEXT==='1';
// Real AI requires explicit model, endpoint, key; default remains offline deterministic rules.
const useAgent=process.env.AGENT_PROVIDER==='compatible';
if(useAgent && (!process.env.AGENT_BASE_URL||!process.env.AGENT_API_KEY||!process.env.AGENT_MODEL))throw new Error('INVALID_AGENT_CONFIG');
const provider=useAgent?new CompatibleAgentProvider({baseUrl:process.env.AGENT_BASE_URL,apiKey:process.env.AGENT_API_KEY,model:process.env.AGENT_MODEL}):new RuleAgentProvider();
const core = new HomeCore(provider);
const workflows=new WorkflowOrchestrator(process.env.WORKFLOW_FILE??resolve(appDir,'.local','workflows.json'),{gateway,registry:devices,skills:core.skills,busyDevice:id=>plans.list().some(p=>p.deviceId===id&&p.status==='running')});
const plans=new PlanOrchestrator(process.env.PLAN_FILE??resolve(appDir,'.local','plans.json'),{gateway,registry:devices,skills:core.skills,busyDevice:id=>workflows.list().some(w=>w.deviceId===id&&['dispatching','navigating','speaking'].includes(w.status))});
if(!['rules','compatible'].includes(process.env.ALEX_PLAN_PROVIDER??'rules'))throw new Error('INVALID_PLAN_PROVIDER');
const proposalProvider=process.env.ALEX_PLAN_PROVIDER==='compatible'
  ?new CompatiblePlanProvider({baseUrl:process.env.AGENT_BASE_URL,apiKey:process.env.AGENT_API_KEY,model:process.env.AGENT_MODEL})
  :new RulePlanProvider();
const proposals=new PlanProposals(process.env.PROPOSAL_FILE??resolve(appDir,'.local','proposals.json'),{plans,provider:proposalProvider});
const store=new JsonStateStore(process.env.STATE_FILE??resolve(appDir,'.local','state.json'));
const saved=await store.load();
if(saved)core.restore(saved);
await memory.load();
await devices.load();
await profiles.load();
await gateway.load();
await workflows.load();
await plans.load();
await proposals.load();
await store.save(core.snapshot());
let persistTimer=null;
const schedulePersist=()=>{
  clearTimeout(persistTimer);
  persistTimer=setTimeout(()=>store.save(core.snapshot()).catch(err=>{console.error('Persistence failure:',err.message);process.exitCode=1;}),200);
};
const clients = new Set();
const send = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
};
const errorStatus = (message) => message==='UNAUTHENTICATED'||message==='DEVICE_UNAUTHORIZED'||message==='INVALID_CREDENTIALS'?401:message==='PARENT_REQUIRED'||message==='LOCAL_AUTH_REQUIRED'?403:message==='TOO_MANY_ATTEMPTS'?429:/^INVALID_|^UNKNOWN_|^AUTH_NOT_ENABLED|^MEMORY_LIMIT_|^SESSION_LIMIT_|^DEVICE_LIMIT_|^PROFILE_LIMIT_/.test(message)?400:500;
function asyncWrap(fn) {
  return async (req, res) => {
    try {await fn(req,res);} catch (err) {
      const message = err instanceof Error ? err.message : 'INTERNAL_ERROR';
      send(res,errorStatus(message),{ok:false,error:message});
    }
  };
}
async function body(req) {
  if(req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('INVALID_CONTENT_TYPE');
  let raw='';
  for await (const chunk of req) { raw+=chunk; if(raw.length>8192) throw new Error('INVALID_BODY_TOO_LARGE'); }
  try {const data=JSON.parse(raw); if(!data || Array.isArray(data) || typeof data!=='object') throw new Error();return data;}
  catch {throw new Error('INVALID_JSON');}
}

core.subscribe(e => {
  schedulePersist();
  const line=`id: ${e.seq}\nevent: home-event\ndata: ${JSON.stringify(e)}\n\n`;
  for(const res of clients)try{res.write(line);}catch{clients.delete(res);}
});
const tickTimer=setInterval(()=>core.tick(.1),100);
const gatewayTimer=setInterval(()=>gateway.expire().catch(err=>console.error('Gateway expiry:',err.message)),1000);
const workflowTimer=setInterval(()=>workflows.tick().catch(err=>console.error('Workflow tick:',err.message)),250);
const planTimer=setInterval(()=>plans.tick().catch(err=>console.error('Plan tick:',err.message)),250);
const keepAliveTimer=setInterval(()=>{for(const res of clients)try{res.write(': heartbeat\n\n');}catch{clients.delete(res);}},15000);

const server=http.createServer(asyncWrap(async(req,res)=>{
  const pathname=new URL(req.url??'/',`http://${req.headers.host ?? 'localhost'}`).pathname;
  const origin=req.headers.origin;
  const incomingHost = req.headers.host ?? '';
  // Prevent DNS rebinding: only explicit loopback Host headers are accepted.
  if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(incomingHost)){send(res,403,{ok:false,error:'LOOPBACK_HOST_REQUIRED'});return;}
  const allowedOrigin=`http://${incomingHost}`;
  if(origin && origin!==allowedOrigin){send(res,403,{ok:false,error:'CROSS_ORIGIN_FORBIDDEN'});return;}
  if(req.method==='GET' && pathname==='/api/auth/session'){send(res,200,auth.current(req));return;}
  if(req.method==='POST' && pathname==='/api/auth/login'){
    try{
      const data=await body(req);
      const login=auth.login(req,{role:data.role,secret:data.secret});
      await audit.record({actor:login.actor,action:'auth.login',outcome:'allowed'});
      res.setHeader('Set-Cookie',login.cookie);
      send(res,200,{ok:true,actor:login.actor});
    }catch(err){
      await audit.record({action:'auth.login',outcome:'denied'});
      const message=err instanceof Error?err.message:'AUTH_FAILED';
      send(res,errorStatus(message),{ok:false,error:message});
    }
    return;
  }
  if(req.method==='POST' && pathname==='/api/auth/logout'){
    const session=auth.current(req);
    res.setHeader('Set-Cookie',auth.logout(req));
    await audit.record({actor:session.actor,action:'auth.logout',outcome:'allowed'});
    send(res,200,{ok:true});return;
  }
  // Device pairing completion and heartbeat have separate narrow credentials.
  // Neither endpoint can read family memory or submit motion commands.
  if(req.method==='POST' && pathname==='/api/devices/pair/complete'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    try{
      const result=await devices.complete(data.code,data.name);
      await audit.record({action:'device.paired',outcome:'allowed'});
      send(res,200,{ok:true,...result});
    }catch(e){await audit.record({action:'device.paired',outcome:'denied'});throw e;}
    return;
  }
  if(req.method==='POST' && pathname==='/api/devices/capabilities'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    send(res,200,await gateway.announce(data.deviceId,token,data.capabilities,data.protocolVersion));return;
  }
  if(req.method==='POST' && pathname==='/api/gateway/telemetry'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const outcome=await gateway.telemetry(data.deviceId,token,data);
    send(res,outcome.ok?200:409,outcome);return;
  }
  if(req.method==='POST' && pathname==='/api/gateway/result'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const outcome=await gateway.result(data.deviceId,token,data);
    await audit.record({actor:'device',action:'gateway.result',outcome:outcome.ok?'allowed':'denied'});
    send(res,outcome.ok?200:409,outcome);return;
  }
  if(req.method==='GET' && (pathname==='/api/gateway/stream'||pathname==='/api/gateway/poll')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const deviceId=new URL(req.url,`http://${incomingHost}`).searchParams.get('deviceId');
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!devices.authenticate(deviceId,token)){send(res,401,{ok:false,error:'DEVICE_UNAUTHORIZED'});return;}
    if(pathname==='/api/gateway/poll'){send(res,200,{ok:true,jobs:gateway.pending(deviceId)});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const detach=gateway.attach(deviceId,token,res);deviceStreamClients.add(res);
    const keepAlive=setInterval(()=>{if(!devices.authenticate(deviceId,token)){res.end();return;}try{res.write(': heartbeat\n\n');}catch{res.end();}},10000);
    req.on('close',()=>{clearInterval(keepAlive);detach();deviceStreamClients.delete(res);});return;
  }
  if(req.method==='POST' && pathname==='/api/devices/heartbeat'){
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const result=await devices.heartbeat(data.deviceId,token);
    send(res,200,result);return;
  }
  // Authentication and actor binding are enforced before any private API.
  const isPrivate=pathname.startsWith('/api/') && pathname!=='/api/health';
  const session=auth.current(req);
  if(isPrivate && !session.authenticated){send(res,401,{ok:false,error:'UNAUTHENTICATED'});return;}
  // Demo remains loopback-only and must not be used as a real family security boundary.
  if(req.method==='GET' && pathname==='/api/health'){send(res,200,{ok:true,mode:'simulation',authMode:auth.mode,agentProvider:provider.kind,realAI:useAgent,agentMemoryOptIn:agentMemoryEnabled,physicalSafety:false,persistentTasks:true,virtualDeviceGateway:true,workflowOrchestrator:true,planOrchestrator:true,planProposals:true,planProposalProvider:proposalProvider.kind,navigationTelemetry:true,simulationBridge:"grid-v1",ros2Connected:false,physicalDeviceActions:false});return;}
  if(req.method==='GET' && (pathname==='/api/proposals'||pathname.startsWith('/api/proposals/timeline/'))){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(pathname==='/api/proposals'){send(res,200,{proposals:proposals.list(),provider:proposalProvider.kind});return;}
    const id=decodeURIComponent(pathname.slice('/api/proposals/timeline/'.length));
    send(res,200,proposals.timeline(id));return;
  }
  if(req.method==='GET' && (pathname==='/api/plans'||pathname==='/api/plans/events')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(pathname==='/api/plans'){send(res,200,{plans:plans.list(),templates:plans.templates()});return;}
    const cursor=new URL(req.url,`http://${incomingHost}`).searchParams.get('after')??'0';
    if(!/^\d{1,15}$/.test(cursor)){send(res,400,{ok:false,error:'INVALID_EVENT_CURSOR'});return;}
    send(res,200,{events:plans.getEvents(Number(cursor))});return;
  }
  if(req.method==='GET' && pathname==='/api/workflows'){
    const actor=auth.actor(req);if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    send(res,200,{workflows:workflows.list(),recipes:WORKFLOW_RECIPES});return;
  }
  if(req.method==='GET' && pathname==='/api/gateway/navigation-map'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{map:{width:MAP.width,height:MAP.height,cellMeters:MAP.cellMeters,destinations:MAP.destinations,walls:MAP.walls,furniture:MAP.furniture},version:'alex-home-grid-v1',simulationOnly:true});return;
  }
  if(req.method==='GET' && pathname==='/api/gateway/jobs'){
    const actor=auth.actor(req,new URL(req.url,`http://${incomingHost}`).searchParams.get('actor'));
    if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    send(res,200,{jobs:gateway.list()});return;
  }
  if(req.method==='GET' && pathname==='/api/state'){send(res,200,core.state());return;}
  if(req.method==='GET' && pathname==='/api/devices'){send(res,200,{devices:[...core.listDevices(),...devices.list()]});return;}
  if(req.method==='GET' && pathname==='/api/profiles'){send(res,200,{profiles:profiles.list()});return;}
  if(req.method==='GET' && pathname==='/api/privacy/export'){const actor=auth.actor(req);if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}send(res,200,{version:1,profiles:profiles.list(),memory:memory.exportForParent(actor),devices:devices.list()});return;}
  if(req.method==='GET' && pathname==='/api/skills'){send(res,200,{skills:core.skills.list()});return;}
  if(req.method==='GET' && pathname==='/api/memory'){
    const actor=auth.actor(req,new URL(req.url,`http://${incomingHost}`).searchParams.get('actor'));
    send(res,200,{entries:memory.list(actor)});return;
  }
  if(req.method==='GET' && pathname==='/api/audit'){
    const actor=auth.actor(req,new URL(req.url,`http://${incomingHost}`).searchParams.get('actor'));
    if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{events:await audit.recent()});return;
  }
  if(req.method==='GET' && pathname==='/api/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(': connected\n\n');clients.add(res);
    req.on('close',()=>clients.delete(res));return;
  }
  if(req.method==='POST' && pathname.startsWith('/api/')){
    const data=await body(req);
    const actor=auth.actor(req,data.actor);
    let result;
    try {
      if(pathname==='/api/devices/pair/start'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,...devices.start(actor)};
      }else if(pathname==='/api/devices/revoke'){
        result={ok:await devices.revoke(actor,data.deviceId),message:'Device revoke processed'};
        if(result.ok)await gateway.disconnect(data.deviceId);
      }else if(pathname==='/api/devices/capabilities/approve'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await gateway.approve(actor,data.deviceId,data.capabilities);
      }else if(pathname==='/api/gateway/dispatch'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await gateway.dispatch(actor,data);
      }else if(pathname==='/api/proposals/create'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await proposals.propose(actor,data);
        await audit.record({actor,action:'proposal.create',outcome:result.ok?'allowed':'denied',requestId:data.requestId});
      }else if(pathname==='/api/proposals/approve'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await proposals.approve(actor,data.proposalId);
        await audit.record({actor,action:'proposal.approve',outcome:result.ok?'allowed':'denied'});
      }else if(pathname==='/api/proposals/reject'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await proposals.reject(actor,data.proposalId);
        await audit.record({actor,action:'proposal.reject',outcome:result.ok?'allowed':'denied'});
      }else if(pathname==='/api/plans/start'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await plans.start(actor,data);
      }else if(pathname==='/api/plans/command'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await plans.command(actor,data);
      }else if(pathname==='/api/plans/cancel'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await plans.cancel(actor,data.planId);
      }else if(pathname==='/api/workflows/start'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await workflows.start(actor,data);
      }else if(pathname==='/api/workflows/command'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await workflows.startCommand(actor,data);
      }else if(pathname==='/api/workflows/cancel'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await workflows.cancel(actor,data.workflowId);
      }else if(pathname==='/api/gateway/cancel'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await gateway.cancel(actor,data.jobId);
      }else if(pathname==='/api/profiles'){
        result={ok:true,profile:await profiles.add(actor,data)};
      }else if(pathname==='/api/profiles/delete'){
        result={ok:await profiles.remove(actor,data.id),message:'Profile deletion processed'};
      }else if(pathname==='/api/privacy/erase'){
        const removed=await memory.erase(actor,data.scope);
        result={ok:true,deletedMemoryEntries:removed,note:'Audit metadata and learner profiles are not erased by this operation.'};
      }else if(pathname==='/api/memory'){
        const entry=await memory.add(actor,data.scope,data.text);
        result={ok:true,message:'Memory saved',entry};
      }else if(pathname==='/api/memory/delete'){
        const deleted=await memory.remove(actor,data.id);
        result={ok:deleted,message:deleted?'Memory deleted':'Memory not found'};
      }else {
        const trusted={...data,actor};
        switch(pathname){
          case '/api/command': {
            // Recognize a small allowlist of composite commands before the legacy single-action classifier.
            // Role binding comes from the verified session; no model-generated workflow JSON is trusted.
            if(parseWorkflowCommand(data.text)){
              if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
              result=await workflows.startCommand(actor,{text:data.text,deviceId:data.deviceId,requestId:data.requestId});
              break;
            }
            if(data.deviceId!==undefined){
              if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
              // Routing external virtual devices is a separate, parent-authorized action.
              // The model only proposes an intent; it never controls arbitrary hardware.
              if(actor!=='parent')throw new Error('PARENT_REQUIRED');
              if(typeof data.text!=='string'||!data.text.trim()||data.text.length>500)throw new Error('INVALID_COMMAND');
              let proposal;
              try{proposal=validateProposal(await provider.propose(data.text,agentMemoryEnabled?memory.forAgent(actor):[]));}
              catch{result={ok:false,message:'Agent proposal invalid; no device action issued'};break;}
              if(proposal.type!=='navigate'){result={ok:false,message:'Only virtual navigation is supported for remote simulated devices'};break;}
              result=await gateway.dispatch(actor,{deviceId:data.deviceId,capability:'sim.navigation.goto',params:{destination:proposal.destination},requestId:data.requestId});
              break;
            }
            result=await core.commandAsync(data.text,actor,data.requestId,agentMemoryEnabled?memory.forAgent(actor):[]);break;
          }
          case '/api/tasks': result=core.navigate(trusted);break;
          case '/api/tasks/cancel': result=core.cancel(data.taskId,actor);break;
          case '/api/safety/stop': result=core.emergencyStop(actor);break;
          case '/api/safety/reset': result=core.resetEmergencyStop(actor);break;
          case '/api/environment': result=core.setObstacle(data.obstaclePresent,actor);break;
          case '/api/skills/invoke': result=core.invokeSkill(data.id,actor);break;
          default:send(res,404,{ok:false,error:'NOT_FOUND'});return;
        }
        // Persist the command before returning success. Device motion is simulated only.
        await store.save(core.snapshot());
      }
      await audit.record({actor,action:pathname,outcome:result.ok?'allowed':'denied',requestId:typeof data.requestId==='string'?data.requestId:undefined});
      send(res,result.ok?200:409,result);
    }catch(err){
      await audit.record({actor,action:pathname,outcome:'error'});
      throw err;
    }
    return;
  }
  const assets={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/navigation.js':'navigation.js'};
  if(req.method!=='GET'||!(pathname in assets)){send(res,404,{ok:false,error:'NOT_FOUND'});return;}
  const file=assets[pathname];
  const bytes=await readFile(resolve(publicDir,file));
  const mime=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
  res.writeHead(200,{
    'Content-Type':`${mime}; charset=utf-8`,
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'"
  });
  res.end(bytes);
}));
server.listen(port,host,()=>console.log(`Home Agent OS ready → http://${host}:${port}`));
function shutdown(){clearInterval(gatewayTimer);clearInterval(workflowTimer);clearInterval(planTimer);for(const r of deviceStreamClients)try{r.end();}catch{}clearInterval(tickTimer);clearInterval(keepAliveTimer);clearTimeout(persistTimer);for(const res of clients)res.end();server.close(async()=>{try{await store.save(core.snapshot());}catch(err){console.error(err);}process.exit(process.exitCode??0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
