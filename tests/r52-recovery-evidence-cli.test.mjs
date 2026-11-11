import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectSkillRecoveryEvidence} from '../scripts/skill-recovery-evidence.mjs';

const script=resolve(import.meta.dirname,'../scripts/skill-recovery-evidence.mjs');
const fixture=()=>mkdtemp(join(tmpdir(),'alex-r52-recovery-cli-'));
const run=dir=>spawnSync(process.execPath,[script,dir],{
 encoding:'utf8',timeout:12000,
 env:{...process.env,AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r52-private-test-parent'}
});
test('R52 CLI 无 Skill 状态时只读返回明确的未授权发布状态',async()=>{
 const dir=await fixture();try{
  const cmd=run(dir);
  assert.equal(cmd.status,0,cmd.stderr);
  const report=JSON.parse(cmd.stdout);
  assert.equal(report.status,'pass');
  assert.equal(report.pending,0);
  assert.equal(report.replayExecuted,false);
  assert.equal(report.recoveryApproved,false);
  assert.equal(report.releaseApproved,false);
  assert.equal(JSON.stringify(report).includes('r52-private-test-parent'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R52 CLI WAL 校验失败即阻断，保留原始文件且不回显恶意字段',async()=>{
 const dir=await fixture();try{
  const path=join(dir,'skill-transactions.json');
  const raw=JSON.stringify({schemaVersion:1,records:[{
   seq:1,phase:'prepared',hash:'a'.repeat(64),prevHash:'0'.repeat(64),
   requestHash:'b'.repeat(64),intent:{secret:'NO_SECRET_OUTPUT'}
  }]});
  await writeFile(path,raw);
  const cmd=run(dir);
  assert.equal(cmd.status,1,cmd.stderr);
  const report=JSON.parse(cmd.stdout);
  assert.deepEqual(report.blockers,['WAL_OR_SKILL_STATE_INVALID']);
  assert.equal(report.status,'blocked');
  assert.equal(report.replayExecuted,false);
  assert.equal(cmd.stdout.includes('NO_SECRET_OUTPUT'),false);
  assert.equal(await readFile(path,'utf8'),raw);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R52 CLI 多余参数拒绝执行，返回用法且不加载状态',()=>{
 const cmd=spawnSync(process.execPath,[script,'one','two'],{
  encoding:'utf8',timeout:12000
 });
 assert.equal(cmd.status,2);
 assert.match(cmd.stderr,/用法/);
 assert.equal(cmd.stdout,'');
});
test('R52 结构损坏的 Trust 不能被 WAL 签名检查绕过',async()=>{
 const dir=await fixture();try{
  await writeFile(join(dir,'skill-trust.json'),'{"schemaVersion":999}');
  const report=await inspectSkillRecoveryEvidence({stateDir:dir,env:{}});
  assert.equal(report.status,'blocked');
  assert.equal(report.replayExecuted,false);
  assert.ok(report.blockers.includes('WAL_OR_SKILL_STATE_INVALID'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
