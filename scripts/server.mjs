import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeCore,CompatibleAgentProvider,RuleAgentProvider } from '../dist/index.js';
import {JsonStateStore} from './state-store.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(appDir, 'public');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '4317');
// Real AI requires explicit model, endpoint, key; default remains offline deterministic rules.
const useAgent=process.env.AGENT_PROVIDER==='compatible';
if(useAgent && (!process.env.AGENT_BASE_URL||!process.env.AGENT_API_KEY||!process.env.AGENT_MODEL))throw new Error('INVALID_AGENT_CONFIG');
const provider=useAgent?new CompatibleAgentProvider({baseUrl:process.env.AGENT_BASE_URL,apiKey:process.env.AGENT_API_KEY,model:process.env.AGENT_MODEL}):new RuleAgentProvider();
const core = new HomeCore(provider);
const store=new JsonStateStore(process.env.STATE_FILE??resolve(appDir,'.local','state.json'));
const saved=await store.load();
if(saved)core.restore(saved);
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
const errorStatus = (message) => /^INVALID_|^UNKNOWN_/.test(message) ? 400 : 500;
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
const keepAliveTimer=setInterval(()=>{for(const res of clients)try{res.write(': heartbeat\n\n');}catch{clients.delete(res);}},15000);

const server=http.createServer(asyncWrap(async(req,res)=>{
  const pathname=new URL(req.url??'/',`http://${req.headers.host ?? 'localhost'}`).pathname;
  const origin=req.headers.origin;
  const allowedOrigin=`http://${req.headers.host}`;
  if(origin && origin!==allowedOrigin){send(res,403,{ok:false,error:'CROSS_ORIGIN_FORBIDDEN'});return;}
  // Local development only. No authentication: must not be Internet-exposed.
  if(req.method==='GET' && pathname==='/api/health'){send(res,200,{ok:true,mode:'simulation',agentProvider:provider.kind,realAI:useAgent,physicalSafety:false,persistentTasks:true});return;}
  if(req.method==='GET' && pathname==='/api/state'){send(res,200,core.state());return;}
  if(req.method==='GET' && pathname==='/api/devices'){send(res,200,{devices:core.listDevices()});return;}
  if(req.method==='GET' && pathname==='/api/skills'){send(res,200,{skills:core.skills.list()});return;}
  if(req.method==='GET' && pathname==='/api/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(': connected\n\n');clients.add(res);
    req.on('close',()=>clients.delete(res));return;
  }
  if(req.method==='POST'){
    const data=await body(req);
    let result;
    switch(pathname){
      case '/api/command': result=await core.commandAsync(data.text,data.actor,data.requestId);break;
      case '/api/tasks': result=core.navigate(data);break;
      case '/api/tasks/cancel': result=core.cancel(data.taskId,data.actor);break;
      case '/api/safety/stop': result=core.emergencyStop(data.actor);break;
      case '/api/safety/reset': result=core.resetEmergencyStop(data.actor);break;
      case '/api/environment': result=core.setObstacle(data.obstaclePresent,data.actor);break;
      case '/api/skills/invoke': result=core.invokeSkill(data.id,data.actor);break;
      default:send(res,404,{ok:false,error:'NOT_FOUND'});return;
    }
    // Persist all mutations before acknowledging a successful command.
    await store.save(core.snapshot());
    send(res,result.ok?200:409,result);return;
  }
  const assets={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'};
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
function shutdown(){clearInterval(tickTimer);clearInterval(keepAliveTimer);clearTimeout(persistTimer);for(const res of clients)res.end();server.close(async()=>{try{await store.save(core.snapshot());}catch(err){console.error(err);}process.exit(process.exitCode??0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
