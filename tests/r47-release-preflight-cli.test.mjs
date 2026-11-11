import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const script=resolve(import.meta.dirname,'../scripts/release-preflight.mjs');
const invoke=(root,env,backup)=>spawnSync(process.execPath,
 [script,root,...(backup?[backup]:[])],{
  encoding:'utf8',timeout:12000,
  env:{...process.env,...env}
 });
test('R47 真实 CLI 只读扫描已创建状态目录，人工验收项不能被掩盖',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alex-r47-cli-'));
 try{
  const dir=join(root,'state');await mkdir(dir);
  await writeFile(join(dir,'state.json'),'{"schemaVersion":1}');
  const run=invoke(dir,{AUTH_MODE:'local',
   ALEX_PARENT_PASSWORD:'r47-cli-parent-secret'});
  assert.equal(run.status,0,run.stderr);
  const report=JSON.parse(run.stdout);
  assert.equal(report.status,'manual-review-required');
  assert.equal(report.storage.existing,1);
  assert.equal(report.releaseApproved,false);
  assert.equal(report.upgradeExecuted,false);
  assert.equal(report.rollbackExecuted,false);
  assert.ok(report.manual.includes('REAL_USER_ACCEPTANCE'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('R47 真实 CLI 遇到写者锁/无本地认证应失败退出，不触碰现有文件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alex-r47-cli-lock-'));
 try{
  const dir=join(root,'state');await mkdir(dir);
  const lock=join(dir,'.alex-writer.lock');
  await writeFile(lock,'DO-NOT-REMOVE');
  const run=invoke(dir,{AUTH_MODE:'demo'});
  assert.equal(run.status,1,run.stderr);
  const report=JSON.parse(run.stdout);
  assert.ok(report.blocked.includes('SERVER_STOPPED'));
  assert.ok(report.blocked.includes('FAMILY_AUTH'));
  const {readFile}=await import('node:fs/promises');
  assert.equal(await readFile(lock,'utf8'),'DO-NOT-REMOVE');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('R47 真实 CLI 过多参数拒绝执行且不输出私密数据',()=>{
 const run=spawnSync(process.execPath,[script,'a','b','c'],{
  encoding:'utf8',timeout:12000
 });
 assert.equal(run.status,2);
 assert.match(run.stderr,/用法/);
 assert.equal(run.stdout,'');
});
