import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const script=resolve(import.meta.dirname,'../scripts/runtime-acceptance-gate.py');
const run=(...args)=>spawnSync('python3',[script,...args],{
 encoding:'utf8',timeout:12000
});

test('R55 ROS 和云端语音未实测时，不会从静态环境检查推导为通过',()=>{
 const checked=run();
 assert.equal(checked.status,0,checked.stderr);
 const report=JSON.parse(checked.stdout);
 assert.equal(report.ros_runtime,'not_run');
 assert.equal(report.voice_real_provider,'not_run');
 assert.equal(report.release_approved,false);
 assert.equal(report.physical_safety_certified,false);
 assert.ok(report.remaining.includes('REAL_ASR_LLM_TTS_PROVIDER_E2E'));
 assert.ok(report.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
});
test('R55 强制真实验收门槛缺证据即非零退出，而非跳过',()=>{
 const checked=run('--require-all');
 assert.equal(checked.status,1,checked.stderr);
 assert.equal(JSON.parse(checked.stdout).status,'manual-review-required');
});
test('R55 ROS 证据必须携带本次运行 ID，不能拿旧缓存或空参数冒充',()=>{
 const checked=run('--ros-report','/nonexistent/report.json');
 assert.equal(checked.status,2);
 assert.match(checked.stderr,/ROS_REPORT_AND_RUN_ID_REQUIRED_TOGETHER/);
 const invalid=run('--ros-report','/nonexistent/report.json',
  '--ros-run-id','../other-run');
 assert.equal(invalid.status,2);
 assert.match(invalid.stderr,/INVALID_ROS_RUN_ID/);
});
test('R55 不完整且自称 passed 的三段导航报告不能通过原始严格验证器',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'alex-r55-ros-gate-'));
 try{
  const file=join(folder,'ros.json');
  await writeFile(file,JSON.stringify({
   schema:'alex.dev/ros-acceptance/v1',
   status:'passed',simulation_only:true,mode:'route',
   checks:['clock_scan_odom_map_tf_nav2_ready'],
   run_id:'r55-fake-report',legs:[]
  }));
  const checked=run('--ros-report',file,'--ros-run-id','r55-fake-report');
  assert.equal(checked.status,1,checked.stderr);
  const result=JSON.parse(checked.stdout);
  assert.equal(result.ros_runtime,'invalid');
  assert.equal(result.release_approved,false);
  assert.ok(result.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('R55 不存在的 ROS 证据文件必须被显式拒绝',()=>{
 const checked=run('--ros-report','/no/alex/r55-report.json',
  '--ros-run-id','r55-actual');
 assert.equal(checked.status,1,checked.stderr);
 assert.equal(JSON.parse(checked.stdout).ros_runtime,'invalid');
});
