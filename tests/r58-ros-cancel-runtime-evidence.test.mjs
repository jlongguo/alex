import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const validator=join(root,'scripts/verify-ros-cancel-report.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const runId='r58-live-cancel-evidence-fixture';
const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 ...(env?{env:{...process.env,...env}}:{})
});

function example(){
 // 仅用于验证拒绝伪造/残缺报告的固定结构数据；不代表曾执行真实 Gazebo。
 return {
  schema:'alex.dev/ros-cancel-acceptance/v1',
  mode:'cancel-probe',status:'passed',simulation_only:true,
  physical_safety_certified:false,release_approved:false,
  run_id:runId,legs:[],
  checks:[
   'clock_scan_odom_map_tf_nav2_ready',
   'bt_navigator_lifecycle_active',
   'nav2_cancel_acknowledged','nav2_cancel_terminal',
   'post_cancel_stop_observed'
  ],
  graph:{
   ready_candidate:true,missing:[],map_valid:true,tf_fresh:true,
   nav2_action_ready:true,clock_observations:5,odom_samples:5,
   scan_ranges:120,
   observed_tf_edges:['odom->base_link','map->odom','base_link->lidar_link']
  },
  nav2_lifecycle:{
   state_id:3,active_responses:1,last_error:null
  },
  cancel:{
   goal:'study_desk',goal_accepted:true,
   cancel_request_sent:true,cancel_acknowledged:true,
   terminal_status:'CANCELED',tf_fresh:true,odom_advanced:true,
   position_drift_m:0.012,observation_seconds:1.5,
   nonzero_velocity_commands:0
  }
 };
}

async function withReport(callback){
 const dir=await mkdtemp(join(tmpdir(),'alex-r58-cancel-'));
 const file=join(dir,'cancel-report.json');
 try{await callback(file,dir);}
 finally{await rm(dir,{recursive:true,force:true});}
}

test('R58 真实取消证据的报告结构校验与精确 run ID',{timeout:15000},async()=>{
 await withReport(async file=>{
  await writeFile(file,JSON.stringify(example()));
  const valid=run('python3',[validator,'--report',file,'--run-id',runId]);
  assert.equal(valid.status,0,valid.stderr);
  const stale=run('python3',[validator,'--report',file,'--run-id','old-run']);
  assert.equal(stale.status,1);
  assert.match(stale.stderr,/ROS_CANCEL_REPORT_INVALID/);
 });
});

test('R58 拒绝假取消终态、缺失 ACK 和提前中断的证据',{timeout:15000},async()=>{
 await withReport(async file=>{
  const mutations=[
   doc=>{doc.cancel.terminal_status='SUCCEEDED';},
   doc=>{doc.cancel.cancel_acknowledged=false;},
   doc=>{doc.cancel.cancel_request_sent=false;},
   doc=>{doc.cancel.goal_accepted=false;},
   doc=>{doc.checks.pop();},
   doc=>{doc.status='failed';},
   doc=>{doc.mode='route';},
   doc=>{doc.release_approved=true;},
   doc=>{doc.physical_safety_certified=true;},
   doc=>{doc.legs=[{verified:true}];}
  ];
  for(const mutate of mutations){
   const report=example();mutate(report);
   await writeFile(file,JSON.stringify(report));
   const checked=run('python3',[validator,'--report',file,'--run-id',runId]);
   assert.equal(checked.status,1,JSON.stringify(report));
  }
 });
});

test('R58 停止窗口必须有新 odom、TF 与 clock 证据，不能留下非零速度指令',{timeout:15000},async()=>{
 await withReport(async file=>{
  const mutations=[
   doc=>{doc.cancel.odom_advanced=false;},
   doc=>{doc.cancel.tf_fresh=false;},
   doc=>{doc.cancel.position_drift_m=0.081;},
   doc=>{doc.cancel.position_drift_m=-0.01;},
   doc=>{doc.cancel.position_drift_m=NaN;},
   doc=>{doc.cancel.nonzero_velocity_commands=1;},
   doc=>{doc.cancel.nonzero_velocity_commands=false;},
   doc=>{doc.cancel.observation_seconds=0.1;},
   doc=>{doc.graph.clock_observations=1;},
   doc=>{doc.graph.tf_fresh=false;},
   doc=>{doc.graph.observed_tf_edges=[];},
   doc=>{doc.nav2_lifecycle.state_id=2;}
  ];
  for(const mutate of mutations){
   const report=example();mutate(report);
   await writeFile(file,JSON.stringify(report));
   const checked=run('python3',[validator,'--report',file,'--run-id',runId]);
   assert.equal(checked.status,1,JSON.stringify(report));
  }
 });
});

test('R58 runtime gate 将故障注入与实际取消分开，缺少真实三段路线仍阻断发布',{timeout:15000},async()=>{
 await withReport(async file=>{
  const initial=run('python3',[gate]);
  assert.equal(initial.status,0,initial.stderr);
  const baseline=JSON.parse(initial.stdout);
  assert.equal(baseline.ros_cancel_runtime,'not_run');
  assert.ok(baseline.remaining.includes('GAZEBO_NAV2_CANCEL_RUNTIME'));

  await writeFile(file,JSON.stringify(example()));
  const checked=run('python3',[gate,
   '--ros-cancel-report',file,'--ros-cancel-run-id',runId]);
  assert.equal(checked.status,0,checked.stderr);
  const report=JSON.parse(checked.stdout);
  assert.equal(report.ros_cancel_runtime,'verified');
  assert.equal(report.ros_runtime,'not_run');
  assert.ok(report.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
  assert.ok(!report.remaining.includes('GAZEBO_NAV2_CANCEL_RUNTIME'));
  assert.equal(report.release_approved,false);

  const wrong=run('python3',[gate,
   '--ros-cancel-report',file,'--ros-cancel-run-id','stale-id']);
  assert.equal(wrong.status,1);
  assert.equal(JSON.parse(wrong.stdout).ros_cancel_runtime,'invalid');
  const incomplete=run('python3',[gate,'--ros-cancel-report',file]);
  assert.equal(incomplete.status,2);
  assert.match(incomplete.stderr,/ROS_CANCEL_REPORT_AND_RUN_ID_REQUIRED_TOGETHER/);
 });
});

test('R58 取消运行器在没有显式隔离授权时 fail-closed 且覆盖旧 PASS 证据',{timeout:15000},async()=>{
 await withReport(async(file,dir)=>{
  await writeFile(file,JSON.stringify(example()));
  const checked=run('bash',['scripts/run-ros-acceptance.sh'],{
   ALEX_ROS_ACCEPTANCE_MODE:'cancel-probe',
   ALEX_ROS_SIMULATION_ONLY:'0',
   ALEX_RUN_ROS_INTEGRATION:'0',
   ALEX_ROS_REPORT:file,
   ALEX_ROS_LOG:join(dir,'launch.log'),
   ALEX_ROS_PREFLIGHT:join(dir,'preflight.json'),
   ALEX_ROS_DIAGNOSTICS:join(dir,'diagnostics.json')
  });
  assert.equal(checked.status,2,checked.stderr);
  const report=JSON.parse(await readFile(file,'utf8'));
  assert.notEqual(report.status,'passed');
  assert.deepEqual(report.checks,[]);
  assert.deepEqual(report.legs,[]);
  const invalid=run('bash',['scripts/run-ros-acceptance.sh'],{
   ALEX_ROS_ACCEPTANCE_MODE:'physical-test'
  });
  assert.equal(invalid.status,2,invalid.stderr);
 });
});

test('R58 ROS 脚本 Python 语法、Action 取消与独立 TF 停止检查保持可追溯',{timeout:15000},()=>{
 const source=join(root,'robotics/ros2/alex_sim/scripts/ros_smoke.py');
 const compiled=run('python3',['-c',
  'from pathlib import Path; import sys; compile(Path(sys.argv[1]).read_text(), sys.argv[1], "exec")',
  source]);
 assert.equal(compiled.status,0,compiled.stderr);
 const shell=run('bash',['-n','scripts/run-ros-acceptance.sh']);
 assert.equal(shell.status,0,shell.stderr);
 const files=run('python3',['-c',
  'from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text())',
  source]);
 assert.equal(files.status,0,files.stderr);
 assert.match(files.stdout,/handle\.cancel_goal_async\(\)/);
 assert.match(files.stdout,/GoalStatus\.STATUS_CANCELED/);
 assert.match(files.stdout,/post_cancel_stop_observed/);
 assert.match(files.stdout,/latest_odom_ns > odom_ns/);
 assert.match(files.stdout,/current_tf_pose\(\)/);
});

test('R58 直接调用 ROS Python 入口也必须限制为独立 LOCALHOST 模拟域',{timeout:15000},()=>{
 const source='robotics/ros2/alex_sim/scripts/ros_smoke.py';
 const checked=run('python3',[source,'--cancel-probe'],{
  ALEX_ROS_SIMULATION_ONLY:'1',
  ALEX_RUN_ROS_INTEGRATION:'1',
  ROS_DISTRO:'jazzy',
  ROS_DOMAIN_ID:'0',
  ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST'
 });
 assert.notEqual(checked.status,0);
 assert.match(checked.stderr,/NAV2_CANCEL_REQUIRES_ISOLATED_SIMULATION_DOMAIN/);
});
