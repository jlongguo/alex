import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const cwd=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function server(env){
 const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,...env},
  stdio:['ignore','ignore','pipe']});
 let error='';
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{error+=chunk.slice(0,4096);});
 return {child,get error(){return error;}};
}
async function health(port,proc){
 for(let i=0;i<100;i++){
  if(proc.child.exitCode!==null)throw Error('R41_SERVER_EXITED:'+proc.error);
  try{if((await fetch('http://127.0.0.1:'+port+'/api/health')).ok)return;}catch{}
  await sleep(70);
 }
 throw Error('R41_SERVER_UNAVAILABLE:'+proc.error);
}
async function stop(proc){
 if(!proc||proc.child.exitCode!==null)return;
 const done=once(proc.child,'exit');proc.child.kill('SIGTERM');await done;
}
test('R41 两个服务进程不能同时写入相同的家庭状态目录，正常退出后可重启',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-http-'));
 const port=46000+Math.floor(Math.random()*3000);
 const env={
  HOST:'127.0.0.1',PORT:String(port),AUTH_MODE:'demo',AGENT_PROVIDER:'rules',
  STATE_FILE:join(dir,'state.json'),AUDIT_FILE:join(dir,'audit.jsonl'),
  MEMORY_FILE:join(dir,'memory.json'),DEVICES_FILE:join(dir,'devices.json'),
  PROFILES_FILE:join(dir,'profiles.json'),
  ALEX_SKILL_GOVERNANCE_FILE:join(dir,'governance.json'),
  ALEX_SKILL_PACKAGES_FILE:join(dir,'packages.json'),
  ALEX_SKILL_TRUST_FILE:join(dir,'trust.json'),
  ALEX_SKILL_TRANSACTIONS_FILE:join(dir,'transactions.json'),
  ALEX_SKILL_BATCH_WAL_FILE:join(dir,'batch-wal.json'),
  ALEX_CONVERSATION_FILE:join(dir,'conversations.json'),
  WORKFLOW_FILE:join(dir,'workflows.json'),PLAN_FILE:join(dir,'plans.json'),
  PROPOSAL_FILE:join(dir,'proposals.json')
 };
 let first,second,third;
 try{
  first=server(env);await health(port,first);
  const lock=JSON.parse(await readFile(join(dir,'.alex-writer.lock'),'utf8'));
  assert.equal(lock.pid,first.child.pid);
  second=server({...env,PORT:String(port+1)});
  const exited=await Promise.race([
   once(second.child,'exit').then(([code])=>code),
   sleep(8000).then(()=>{throw Error('R41_SECOND_INSTANCE_NOT_REJECTED');})
  ]);
  assert.notEqual(exited,0);
  assert.match(second.error,/ALEX_INSTANCE_ALREADY_RUNNING/);
  assert.equal(JSON.parse(await readFile(join(dir,'.alex-writer.lock'),'utf8')).pid,first.child.pid);
  await stop(first);first=null;
  third=server({...env,PORT:String(port+2)});
  await health(port+2,third);
  assert.equal(JSON.parse(await readFile(join(dir,'.alex-writer.lock'),'utf8')).pid,third.child.pid);
 }finally{
  await stop(first);await stop(second);await stop(third);
  await rm(dir,{recursive:true,force:true});
 }
});
