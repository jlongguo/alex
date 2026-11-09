import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {manifestDigest,signedPayload} from '../scripts/skill-package-trust.mjs';
const cwd=resolve(import.meta.dirname,'..');
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function boot(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,...env},stdio:'ignore'});
 const base='http://127.0.0.1:'+env.PORT;
 for(let i=0;i<140;i++){
  if(child.exitCode!==null)throw Error('R37_SERVER_EXITED');
  try{if((await fetch(base+'/api/health')).ok)return {child,base};}catch{}
  await nap(60);
 }
 child.kill();throw Error('R37_SERVER_TIMEOUT');
}
async function stop(server){
 if(!server||server.child.exitCode!==null)return;
 const done=once(server.child,'exit');server.child.kill('SIGTERM');await done;
}
async function api(base,path,cookie,data){
 const response=await fetch(base+path,{method:data?'POST':'GET',headers:{
  ...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})
 },...(data?{body:JSON.stringify(data)}:{})});
 return {status:response.status,body:await response.json().catch(()=>({})),
  cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const schema={type:'object',properties:{text:{type:'string'}},required:[],additionalProperties:false};
test('R37 signed HTTP transaction is parent-only, durable and idempotent across restart',{timeout:50000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r37-http-'));
 const env={
  PORT:String(45500+Math.floor(Math.random()*4000)),AUTH_MODE:'local',
  ALEX_PARENT_PASSWORD:'r37-parent-passphrase-long',ALEX_CHILD_PIN:'447799',
  AGENT_PROVIDER:'rules',ALEX_CHAT_PROVIDER:'offline',
  ALEX_AUDIO_PROVIDER:'disabled',ALEX_REALTIME_PROVIDER:'disabled',
  ALEX_SPEECH_STREAM_PROVIDER:'disabled',
  ALEX_SKILL_PACKAGES_FILE:join(dir,'packages.json'),ALEX_SKILL_TRUST_FILE:join(dir,'trust.json'),
  ALEX_SKILL_TRANSACTIONS_FILE:join(dir,'tx.json'),
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'governance.json'),
  STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
  MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),GATEWAY_FILE:join(dir,'gateway.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json'),
  LEARNER_CREDENTIALS_FILE:join(dir,'credentials.json'),
  ALEX_LEARNER_PRIVACY_FILE:join(dir,'privacy.json'),
  ALEX_LEARNING_PLANS_FILE:join(dir,'learning-plans.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json')
 };
 const manifest={schemaVersion:'alex.skill/v1',id:'family.tx-demo',version:'1.0.0',
  name:'Signed example',description:'No package code execution',permissions:[],
  allowedActors:['parent'],dependencies:[],inputSchema:schema,outputSchema:schema};
 const keys=generateKeyPairSync('ed25519'),bytes=Buffer.from('opaque signed metadata package');
 const artifactSha256=createHash('sha256').update(bytes).digest('hex');
 const signature=sign(null,signedPayload(manifestDigest(manifest),artifactSha256),
  keys.privateKey).toString('base64');
 let server;
 try{
  server=await boot(env);
  const login=await api(server.base,'/api/auth/login',null,{role:'parent',secret:env.ALEX_PARENT_PASSWORD});
  const parent=login.cookie;
  const child=(await api(server.base,'/api/auth/login',null,{role:'child',secret:env.ALEX_CHILD_PIN})).cookie;
  assert.equal((await api(server.base,'/api/skills/transactions')).status,401);
  assert.equal((await api(server.base,'/api/skills/transactions',child)).status,403);
  const payload={action:'apply',operationId:'r37-parent-request-01',
   id:manifest.id,version:manifest.version,expectedCurrentVersion:null};
  assert.equal((await api(server.base,'/api/skills/packages',child,payload)).status,403);
  assert.equal((await api(server.base,'/api/skills/packages',parent,{action:'submit',manifest})).status,200);
  assert.equal((await api(server.base,'/api/skills/packages',parent,payload)).body.error,
   'SKILL_ATTESTATION_REQUIRED');
  const pub=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  assert.equal((await api(server.base,'/api/skills/trust',parent,{
   action:'enroll',publisherId:'family.publisher',publicKeyPem:pub})).status,200);
  assert.equal((await api(server.base,'/api/skills/trust',parent,{
   action:'attest',id:manifest.id,version:manifest.version,publisherId:'family.publisher',
   artifactBase64:bytes.toString('base64'),signature})).status,200);
  const applied=await api(server.base,'/api/skills/packages',parent,payload);
  assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(applied.body.status,'committed');
  assert.equal(applied.body.executable,false);
  assert.equal((await api(server.base,'/api/skills/packages',parent,payload)).body.status,'committed');
  const registry=(await api(server.base,'/api/skills/packages',parent)).body;
  assert.equal(registry.installed[0].id,manifest.id);
  assert.deepEqual(registry.history.map(r=>r.action),['submit','review','install']);
  const wal=(await api(server.base,'/api/skills/transactions',parent)).body;
  assert.equal(wal.records[0].phase,'committed');
  assert.equal(wal.records[0].manifestSha256,manifestDigest(manifest));
  assert.equal(wal.records[0].artifactSha256,artifactSha256);
  assert.equal((await api(server.base,'/api/skills/packages',child,{action:'recover'})).status,403);
  await stop(server);server=null;
  env.PORT=String(Number(env.PORT)+1);
  server=await boot(env);
  const parent2=(await api(server.base,'/api/auth/login',null,{role:'parent',secret:env.ALEX_PARENT_PASSWORD})).cookie;
  assert.equal((await api(server.base,'/api/skills/transactions',parent2)).body.records[0].phase,'committed');
  assert.equal((await api(server.base,'/api/skills/packages',parent2,{action:'recover'})).body.pending,0);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
