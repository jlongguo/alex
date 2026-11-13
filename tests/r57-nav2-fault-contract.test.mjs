import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
 runNav2FaultContract,verifyNav2FaultContract
} from '../scripts/nav2-fault-contract.mjs';

const RUN='77777777-7777-4777-8777-777777777777';
const copy=value=>structuredClone(value);

test('R57 真实 Node 子进程故障矩阵：拒绝、取消、超时未确认和失败后恢复', {timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r57-fault-'));
 const path=join(dir,'nav2.json');
 try{
  const result=await runNav2FaultContract({reportPath:path,makeRunId:()=>RUN});
  assert.equal(result.status,'passed');
  assert.equal(result.source,'injected-subprocess');
  assert.equal(result.ros_runtime_verified,false);
  assert.equal(result.physical_safety_certified,false);
  assert.equal(result.release_approved,false);
  assert.equal(result.scenarios.rejected.reason,'rejected');
  assert.equal(result.scenarios.user_cancelled.status,'cancelled');
  assert.equal(result.scenarios.timeout_unconfirmed.reason,'NAV2_CANCEL_UNCONFIRMED');
  assert.equal(result.scenarios.recovery_after_failure.status,'arrived');
  assert.equal(result.checks.length,4);
  assert.equal(verifyNav2FaultContract(result,RUN),true);
  const raw=await readFile(path,'utf8');
  assert.ok(!raw.includes('command_line'));
  assert.ok(!raw.includes('ALEX_TEST_NAV2_MODE'));
  assert.ok(!raw.includes('process.env'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R57 run ID、缺失故障、状态造假、过度发布声明全部 fail closed',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r57-verifier-'));
 try{
  const report=await runNav2FaultContract({
   reportPath:join(dir,'nav2.json'),makeRunId:()=>RUN
  });
  assert.throws(()=>verifyNav2FaultContract(report,'88888888-8888-4888-8888-888888888888'),
   /NAV2_FAULT_RUN_ID_MISMATCH/);
  const broken=copy(report);broken.checks.pop();
  assert.throws(()=>verifyNav2FaultContract(broken,RUN),/NAV2_FAULT_INCOMPLETE_CHECKS/);
  const fake=copy(report);fake.scenarios.timeout_unconfirmed.status='arrived';
  assert.throws(()=>verifyNav2FaultContract(fake,RUN),/NAV2_FAULT_INVALID_SCENARIO/);
  const overclaim=copy(report);overclaim.ros_runtime_verified=true;
  assert.throws(()=>verifyNav2FaultContract(overclaim,RUN),/NAV2_FAULT_INVALID_REPORT/);
  const release=copy(report);release.release_approved=true;
  assert.throws(()=>verifyNav2FaultContract(release,RUN),/NAV2_FAULT_INVALID_REPORT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R57 故障注入证据可进入 runtime gate，但真实三段 Nav2 仍被阻断',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r57-gate-'));
 const file=join(dir,'fault.json');
 try{
  await runNav2FaultContract({reportPath:file,makeRunId:()=>RUN});
  const gate=resolve(import.meta.dirname,'../scripts/runtime-acceptance-gate.py');
  const checked=spawnSync('python3',[
   gate,'--nav2-fault-report',file,'--nav2-fault-run-id',RUN
  ],{encoding:'utf8',timeout:12000});
  assert.equal(checked.status,0,checked.stderr);
  const report=JSON.parse(checked.stdout);
  assert.equal(report.nav2_fault_contract,'verified-injected');
  assert.equal(report.ros_runtime,'not_run');
  assert.ok(report.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
  assert.equal(report.release_approved,false);

  const wrong=spawnSync('python3',[
   gate,'--nav2-fault-report',file,'--nav2-fault-run-id',
   '99999999-9999-4999-8999-999999999999'
  ],{encoding:'utf8',timeout:12000});
  assert.equal(wrong.status,1,wrong.stderr);
  assert.equal(JSON.parse(wrong.stdout).nav2_fault_contract,'invalid');
 }finally{await rm(dir,{recursive:true,force:true});}
});
