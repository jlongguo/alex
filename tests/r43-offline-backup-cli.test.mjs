import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const script=resolve(import.meta.dirname,'../scripts/offline-state-backup.mjs');
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000});

test('R43 CLI 创建、校验和仅空目录恢复演练全链路执行',async()=>{
 const root=await mkdtemp(join(tmpdir(),'alex-r43-cli-'));
 try{
  const source=join(root,'source'),backup=join(root,'backup'),staging=join(root,'staging');
  await mkdir(source);await mkdir(staging);
  await writeFile(join(source,'state.json'),'{"schemaVersion":1}');
  const create=run('create',source,backup);
  assert.equal(create.status,0,create.stderr);
  const report=JSON.parse(create.stdout);
  assert.equal(report.fullApplicationBackup,false);
  const verify=run('verify',backup);
  assert.equal(verify.status,0,verify.stderr);
  assert.equal(JSON.parse(verify.stdout).files,1);
  const plan=run('restore-plan',backup,staging);
  assert.equal(plan.status,0,plan.stderr);
  assert.equal(JSON.parse(plan.stdout).restored,false);
  const stage=run('restore-stage',backup,staging);
  assert.equal(stage.status,0,stage.stderr);
  assert.equal(JSON.parse(stage.stdout).productionRestored,false);
  assert.equal(await readFile(join(staging,'state.json'),'utf8'),'{"schemaVersion":1}');
  const retry=run('restore-stage',backup,staging);
  assert.notEqual(retry.status,0);
  assert.match(retry.stderr,/ALEX_RESTORE_TARGET_NOT_EMPTY/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('R43 CLI 无效参数失败退出且不抛出未处理堆栈',()=>{
 const r=run('unknown');
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/ALEX_BACKUP_USAGE/);
 assert.equal(r.stdout,'');
});
