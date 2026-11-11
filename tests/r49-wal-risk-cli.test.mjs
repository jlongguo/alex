import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../scripts/skill-package-trust.mjs';
const script=resolve(import.meta.dirname,'../scripts/wal-recovery-risks.mjs');
const fixture=async()=>mkdtemp(join(tmpdir(),'alex-r49-wal-cli-'));
const run=(dir)=>spawnSync(process.execPath,[script,dir],{
 encoding:'utf8',timeout:12000
});
test('R49 WAL CLI 空目录只读扫描退出 0，状态仍不具备自动发布资格',async()=>{
 const dir=await fixture();try{
  const r=run(dir);
  assert.equal(r.status,0,r.stderr);
  const value=JSON.parse(r.stdout);
  assert.equal(value.approvedForUpgrade,false);
  assert.equal(value.hashChainCryptographicallyVerified,true);
  assert.equal(value.recoveryExecuted,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 WAL CLI 碰到 prepared 或结构损坏即退出 1，且不修改原文件',async()=>{
 const dir=await fixture();try{
  const file=join(dir,'skill-transactions.json');
  const sha=x=>createHash('sha256').update(canonicalJson(x)).digest('hex');
  const intent={operationId:'r49-cli-001',id:'family.sample',version:'1.0.0',
   expectedCurrentVersion:null,publisherId:'family.publisher',
   manifestSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64)};
  const row={seq:1,phase:'prepared',prevHash:'0'.repeat(64),
   requestHash:sha(intent),intent};
  const content=JSON.stringify({schemaVersion:1,records:[{...row,hash:sha(row)}]});
  await writeFile(file,content);
  const r=run(dir);
  assert.equal(r.status,1,r.stderr);
  assert.ok(JSON.parse(r.stdout).pending.includes('single'));
  assert.equal(await readFile(file,'utf8'),content);
  await writeFile(file,'{bad-json');
  const invalid=run(dir);
  assert.equal(invalid.status,1,invalid.stderr);
  assert.ok(JSON.parse(invalid.stdout).blocked.includes('single'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R49 WAL CLI 不接受任意附加参数',()=>{
 const r=spawnSync(process.execPath,[script,'one','two'],{
  encoding:'utf8',timeout:12000
 });
 assert.equal(r.status,2);
 assert.match(r.stderr,/用法/);
});
