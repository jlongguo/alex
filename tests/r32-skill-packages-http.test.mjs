import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {manifestDigest,signedPayload} from '../scripts/skill-package-trust.mjs';
const cwd=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<130;i++){
  if(child.exitCode!==null)throw Error('R32_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await sleep(60);
 }
 child.kill();throw Error('R32_BOOT_TIMEOUT');
}
async function stop(s){
 if(!s||s.child.exitCode!==null)return;
 const done=once(s.child,'exit');s.child.kill('SIGTERM');await done;
}
async function req(base,path,cookie,data){
 const r=await fetch(base+path,{method:data?'POST':'GET',headers:{
  ...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})
 },...(data?{body:JSON.stringify(data)}:{})});
 return {status:r.status,data:await r.json().catch(()=>({})),
  cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const shape={type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false};
test('R32 parent package API denies child and anonymous, persists metadata without executable access',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r32-http-'));
 const env={
  PORT:String(43000+Math.floor(Math.random()*9000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r32-long-parent-password',ALEX_CHILD_PIN:'334455',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',ALEX_SKILL_PACKAGES_FILE:join(dir,'packages.json'),
  ALEX_SKILL_TRUST_FILE:join(dir,'trust.json'),
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'skills.json'),STATE_FILE:join(dir,'state.json'),
  AUDIT_FILE:join(dir,'audit.jsonl'),MEMORY_FILE:join(dir,'memory.json'),
  DEVICES_FILE:join(dir,'devices.json'),PROFILES_FILE:join(dir,'profiles.json'),
  GATEWAY_FILE:join(dir,'gateway.json'),WORKFLOW_FILE:join(dir,'workflows.json'),
  PLAN_FILE:join(dir,'plans.json'),PROPOSAL_FILE:join(dir,'proposals.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning-plans.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json')
 };
 const m={schemaVersion:'alex.skill/v1',id:'family.demo',version:'1.0.0',
  name:'Demo package',description:'Metadata only',permissions:[],allowedActors:['parent'],
  dependencies:[],inputSchema:shape,outputSchema:shape};
 let server;
 try{
  server=await boot(env);
  const parent=(await req(server.base,'/api/auth/login',null,{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  const child=(await req(server.base,'/api/auth/login',null,{role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
  assert.equal((await req(server.base,'/api/skills/packages')).status,401);
  assert.equal((await req(server.base,'/api/skills/packages',child)).status,403);
  assert.equal((await req(server.base,'/api/skills/packages',child,{action:'submit',manifest:m})).status,403);
  const added=await req(server.base,'/api/skills/packages',parent,{action:'submit',manifest:m});
  assert.equal(added.status,200);assert.equal(added.data.status,'pending');
  assert.equal((await req(server.base,'/api/skills/packages',parent,{action:'install',id:m.id,version:m.version})).data.error,'SKILL_NOT_APPROVED');
  // R34 provenance is mandatory in the server, even for legacy R32/R33 HTTP flows.
  assert.equal((await req(server.base,'/api/skills/packages',parent,{
   action:'review',id:m.id,version:m.version,decision:'approve'
  })).status,403);
  const keyPair=generateKeyPairSync('ed25519');
  const publicKeyPem=keyPair.publicKey.export({type:'spki',format:'pem'}).toString();
  const artifact=Buffer.from('R34 trusted metadata test fixture');
  const artifactSha256=createHash('sha256').update(artifact).digest('hex');
  const signature=sign(null,signedPayload(manifestDigest(m),artifactSha256),
    keyPair.privateKey).toString('base64');
  assert.equal((await req(server.base,'/api/skills/trust',parent,{
   action:'enroll',publisherId:'family.publisher',publicKeyPem
  })).status,200);
  assert.equal((await req(server.base,'/api/skills/trust',parent,{
   action:'attest',id:m.id,version:m.version,publisherId:'family.publisher',
   artifactBase64:artifact.toString('base64'),signature
  })).status,200);
  assert.equal((await req(server.base,'/api/skills/packages',parent,{action:'review',id:m.id,version:m.version,decision:'approve'})).status,200);
  assert.equal((await req(server.base,'/api/skills/packages',parent,{action:'install',id:m.id,version:m.version})).status,200);
  const list=await req(server.base,'/api/skills/packages',parent);
  assert.equal(list.status,200);assert.equal(list.data.metadataOnly,true);
  assert.equal(list.data.installed[0].version,'1.0.0');
  assert.equal((await req(server.base,'/api/skills',parent)).data.skills.some(s=>s.id==='family.demo'),false);
  await stop(server);server=null;env.PORT=String(Number(env.PORT)+1);
  server=await boot(env);
  const p2=(await req(server.base,'/api/auth/login',null,{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  assert.equal((await req(server.base,'/api/skills/packages',p2)).data.installed[0].id,'family.demo');
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
