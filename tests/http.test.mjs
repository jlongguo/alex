import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname,resolve } from 'node:path';

const cwd=resolve(dirname(fileURLToPath(import.meta.url)),'..');

async function waitHealth(url, child) {
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)throw new Error('Server exited early');
    try{const r=await fetch(url+'/api/health');if(r.ok)return;}catch{}
    await new Promise(r=>setTimeout(r,75));
  }
  throw new Error('Server did not start');
}

test('HTTP integration: boot server, navigation, child safety, emergency stop', {timeout:15000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alex-http-v01-'));
  const port=45000+Math.floor(Math.random()*15000),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['scripts/server.mjs'],{cwd,env:{...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),AGENT_PROVIDER:'rules'},stdio:'ignore'});
  try{
    await waitHealth(base,child);
    const health=await (await fetch(base+'/api/health')).json();
    assert.equal(health.realAI,false);
    const page=await fetch(base+'/');
    assert.equal(page.status,200);
    assert.match(await page.text(),/家庭智能中枢/);
    const post=async(path,data)=>{const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return {status:res.status,data:await res.json()};};
    const start=await post('/api/command',{actor:'parent',text:'去书桌'});
    assert.equal(start.status,200);
    assert.equal(start.data.task.status,'running');
    const state=await (await fetch(base+'/api/state')).json();
    assert.equal(state.activeTaskId,start.data.task.id);
    const denied=await post('/api/skills/invoke',{actor:'child',id:'home.status'});
    assert.equal(denied.status,409);
    const stop=await post('/api/safety/stop',{actor:'child'});
    assert.equal(stop.status,200);
    const resetChild=await post('/api/safety/reset',{actor:'child'});
    assert.equal(resetChild.status,409);
    const resetParent=await post('/api/safety/reset',{actor:'parent'});
    assert.equal(resetParent.status,200);
  }finally{
    child.kill('SIGTERM');
    if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,800))]);
    await rm(dir,{recursive:true,force:true});
  }
});
