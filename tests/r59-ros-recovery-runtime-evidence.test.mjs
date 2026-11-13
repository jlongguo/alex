import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const verifier=join(root,'scripts/verify-ros-recovery-report.py');
const cancelVerifier=join(root,'scripts/verify-ros-cancel-report.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const runId='r59-synthetic-structure-only';
const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:12000,
 ...(env?{env:{...process.env,...env}}:{})
});

function leg(goal,x,y){
 return {
  goal,x,y,pose_x:x,pose_y:y,position_error_m:0.02,
  verified:true,feedback_count:12,odom_distance_m:1.4,
  wall_seconds:14.5
 };
}

function fixture(){
 // 报告仅测试结构校验器的拒绝行为，绝不作为真实 Gazebo 运行证据提交。
 return {
  schema:'alex.dev/ros-recovery-acceptance/v1',
  mode:'recover-probe',status:'passed',simulation_only:true,
  run_id:runId,physical_safety_certified:false,release_approved:false,
  checks:[
   'clock_scan_odom_map_tf_nav2_ready','bt_navigator_lifecycle_active',
   'nav2_cancel_acknowledged','nav2_cancel_terminal',
   'post_cancel_stop_observed',
   'post_cancel_recovery_desk_verified','post_cancel_return_dock_verified'
  ],
  graph:{
   missing:[],ready_candidate:true,map_valid:true,tf_fresh:true,
   nav2_action_ready:true,clock_observations:5,odom_samples:5,
   scan_ranges:90,
   observed_tf_edges:['odom->base_link','map->odom','base_link->lidar_link']
  },
  nav2_lifecycle:{state_id:3,active_responses:3,last_error:null},
  cancel:{
   goal:'study_desk',goal_accepted:true,
   cancel_request_sent:true,cancel_acknowledged:true,
   terminal_status:'CANCELED',tf_fresh:true,odom_advanced:true,
   position_drift_m:0.01,observation_seconds:1.55,
   nonzero_velocity_commands:0
  },
  recovery:{
   source:'same-gazebo-session',
   cancel_verified:true,
   recovery_goals:['study_desk','dock'],
   return_to_dock_verified:true
  },
  legs:[
   leg('study_desk',1.7,1.6),
   leg('dock',0.7,2.8)
  ],
  last_goal:{
   goal:'dock',action_status:'SUCCEEDED',
   tf_fresh:true,feedback_count:12,
   odom_distance_m:1.4
  }
 };
}

async function inTemp(cb){
 const dir=await mkdtemp(join(tmpdir(),'alex-r59-recovery-'));
 try{await cb({dir,report:join(dir,'recovery.json')});}
 finally{await rm(dir,{recursive:true,force:true});}
}

test('R59 严格报告验证支持恰好两段恢复目标，拒绝旧 run ID 和跨模式证据',async()=>{
 await inTemp(async({report})=>{
  await writeFile(report,JSON.stringify(fixture()));
  const good=run('python3',[verifier,'--report',report,'--run-id',runId]);
  assert.equal(good.status,0,good.stderr);
  const stale=run('python3',[verifier,'--report',report,'--run-id','old-run']);
  assert.equal(stale.status,1);
  const separateCancel=run('python3',[cancelVerifier,'--report',report,'--run-id',runId]);
  assert.equal(separateCancel.status,1,
   'R58 取消报告验证器不得把 R59 恢复报告当作独立取消报告');
 });
});

test('R59 拒绝错误顺序、缺少停止观察和虚假的返回码头声明',async()=>{
 await inTemp(async({report})=>{
  const mutated=[
   doc=>{doc.status='running';},
   doc=>{doc.mode='route';},
   doc=>{doc.schema='alex.dev/ros-acceptance/v1';},
   doc=>{doc.checks.pop();},
   doc=>{doc.checks.splice(3,1);},
   doc=>{doc.recovery.recovery_goals.reverse();},
   doc=>{doc.recovery.cancel_verified=false;},
   doc=>{doc.recovery.return_to_dock_verified=false;},
   doc=>{doc.recovery.source='two-separate-gazebo-sessions';},
   doc=>{doc.legs.reverse();},
   doc=>{doc.legs.pop();},
   doc=>{doc.legs.push(leg('story_corner',4.9,1.7));},
   doc=>{doc.last_goal.action_status='CANCELED';},
   doc=>{doc.last_goal.goal='study_desk';},
   doc=>{doc.last_goal.tf_fresh=false;},
   doc=>{doc.cancel.terminal_status='SUCCEEDED';},
   doc=>{doc.cancel.cancel_acknowledged=false;},
   doc=>{doc.cancel.position_drift_m=0.09;},
   doc=>{doc.cancel.nonzero_velocity_commands=1;},
   doc=>{doc.release_approved=true;},
   doc=>{doc.physical_safety_certified=true;}
  ];
  for(const mutate of mutated){
   const data=fixture();mutate(data);
   await writeFile(report,JSON.stringify(data));
   const checked=run('python3',[verifier,'--report',report,'--run-id',runId]);
   assert.equal(checked.status,1,JSON.stringify(data));
  }
 });
});

test('R59 复用原三段导航 12cm 误差、odom 与反馈门槛而非降低标准',async()=>{
 await inTemp(async({report})=>{
  const mutated=[
   doc=>{doc.legs[0].position_error_m=0.13;},
   doc=>{doc.legs[1].pose_x=0.9;},
   doc=>{doc.legs[0].odom_distance_m=0.399;},
   doc=>{doc.legs[1].feedback_count=0;},
   doc=>{doc.legs[1].verified=false;},
   doc=>{doc.legs[0].wall_seconds=0;},
   doc=>{doc.legs[0].x=1.6;},
   doc=>{doc.last_goal.feedback_count=0;},
   doc=>{doc.last_goal.odom_distance_m=0.3;},
  ];
  for(const mutate of mutated){
   const data=fixture();mutate(data);
   await writeFile(report,JSON.stringify(data));
   const checked=run('python3',[verifier,'--report',report,'--run-id',runId]);
   assert.equal(checked.status,1,JSON.stringify(data));
  }
 });
});

test('R59 运行时 Gate 单独约束恢复证据，不能由结构 fixture 解锁真实路线或独立取消',async()=>{
 await inTemp(async({report})=>{
  const before=run('python3',[gate]);
  assert.equal(before.status,0,before.stderr);
  const baseline=JSON.parse(before.stdout);
  assert.equal(baseline.ros_recovery_runtime,'not_run');
  assert.ok(baseline.remaining.includes('GAZEBO_NAV2_RECOVERY_RUNTIME'));

  await writeFile(report,JSON.stringify(fixture()));
  const checked=run('python3',[gate,
   '--ros-recovery-report',report,'--ros-recovery-run-id',runId]);
  assert.equal(checked.status,0,checked.stderr);
  const observed=JSON.parse(checked.stdout);
  assert.equal(observed.ros_recovery_runtime,'verified');
  assert.equal(observed.ros_runtime,'not_run');
  assert.equal(observed.ros_cancel_runtime,'not_run');
  assert.ok(observed.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
  assert.ok(observed.remaining.includes('GAZEBO_NAV2_CANCEL_RUNTIME'));
  assert.equal(observed.release_approved,false);
  assert.equal(observed.physical_safety_certified,false);

  const stale=run('python3',[gate,
   '--ros-recovery-report',report,'--ros-recovery-run-id','previous-run']);
  assert.equal(stale.status,1);
  assert.equal(JSON.parse(stale.stdout).ros_recovery_runtime,'invalid');
  const missing=run('python3',[gate,'--ros-recovery-report',report]);
  assert.equal(missing.status,2);
  assert.match(missing.stderr,/ROS_RECOVERY_REPORT_AND_RUN_ID_REQUIRED_TOGETHER/);
 });
});

test('R59 恢复验收无授权时 fail-closed，旧 PASS 不可跨运行复用',async()=>{
 await inTemp(async({dir,report})=>{
  await writeFile(report,JSON.stringify(fixture()));
  const checked=run('bash',['scripts/run-ros-acceptance.sh'],{
   ALEX_ROS_ACCEPTANCE_MODE:'recover-probe',
   ALEX_ROS_SIMULATION_ONLY:'0',ALEX_RUN_ROS_INTEGRATION:'0',
   ALEX_ROS_REPORT:report,
   ALEX_ROS_LOG:join(dir,'launch.log'),
   ALEX_ROS_PREFLIGHT:join(dir,'preflight.json'),
   ALEX_ROS_DIAGNOSTICS:join(dir,'diagnostics.json')
  });
  assert.equal(checked.status,2,checked.stderr);
  const output=JSON.parse(await readFile(report,'utf8'));
  assert.equal(output.status,'blocked');
  assert.deepEqual(output.checks,[]);
  assert.deepEqual(output.legs,[]);
  assert.notEqual(output.run_id,runId);
 });
});

test('R59 直接 ROS 入口要求 Jazzy + Domain 77 + LOCALHOST，不导入硬件驱动',()=>{
 const source='robotics/ros2/alex_sim/scripts/ros_smoke.py';
 const invalid=run('python3',[source,'--recover-probe'],{
  ROS_DISTRO:'jazzy',ROS_DOMAIN_ID:'0',
  ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST',
  ALEX_ROS_SIMULATION_ONLY:'1',ALEX_RUN_ROS_INTEGRATION:'1'
 });
 assert.notEqual(invalid.status,0);
 assert.match(invalid.stderr,/NAV2_CANCEL_REQUIRES_ISOLATED_SIMULATION_DOMAIN/);

 const compiled=run('python3',['-c',
  'from pathlib import Path; import sys; compile(Path(sys.argv[1]).read_text(),sys.argv[1],"exec")',
  source]);
 assert.equal(compiled.status,0,compiled.stderr);
 const syntax=run('bash',['-n','scripts/run-ros-acceptance.sh']);
 assert.equal(syntax.status,0,syntax.stderr);
});

test('R59 三段路线原验证器继续检查原有 3 段，不被 2 段恢复放宽',async()=>{
 await inTemp(async({report})=>{
  const data=fixture();
  data.schema='alex.dev/ros-acceptance/v1';
  data.mode='route';
  data.legs=[leg('study_desk',1.7,1.6),leg('story_corner',4.9,1.7),leg('dock',0.7,2.8)];
  await writeFile(report,JSON.stringify(data));
  const verifyRoute=join(root,'scripts/verify-ros-report.py');
  const good=run('python3',[verifyRoute,'--report',report,'--run-id',runId]);
  assert.equal(good.status,0,good.stderr);
  data.legs.pop();
  await writeFile(report,JSON.stringify(data));
  const invalid=run('python3',[verifyRoute,'--report',report,'--run-id',runId]);
  assert.equal(invalid.status,1);
 });
});
