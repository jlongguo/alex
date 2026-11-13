import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const validator=join(root,'scripts/verify-ros-timeout-recovery-report.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const rosSmoke=join(root,'robotics/ros2/alex_sim/scripts/ros_smoke.py');
const RUN_ID='r59-timeout-recovery-verified-fixture';
const run=(binary,args,env)=>spawnSync(binary,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 ...(env?{env:{...process.env,...env}}:{})
});

function leg(goal,x,y){
 return {
  goal,x,y,pose_x:x,pose_y:y,
  position_error_m:0.01,feedback_count:3,
  odom_distance_m:1.1,wall_seconds:7.2,verified:true
 };
}

// 人工构造数据仅用于验证证据结构/拒绝逻辑；它并非真实 ROS 验收记录。
function fixture(){
 return {
  schema:'alex.dev/ros-timeout-recovery/v1',
  mode:'timeout-recovery',status:'passed',simulation_only:true,
  release_approved:false,physical_safety_certified:false,
  run_id:RUN_ID,
  legs:[leg('study_desk',1.7,1.6),leg('dock',0.7,2.8)],
  checks:[
   'clock_scan_odom_map_tf_nav2_ready','bt_navigator_lifecycle_active',
   'nav2_forced_timeout_observed','nav2_cancel_acknowledged',
   'nav2_cancel_terminal','post_cancel_stop_observed',
   'nav2_recovery_to_desk_verified','nav2_return_to_dock_verified'
  ],
  graph:{
   ready_candidate:true,missing:[],map_valid:true,tf_fresh:true,
   nav2_action_ready:true,clock_observations:5,
   odom_samples:5,scan_ranges:160,
   observed_tf_edges:['odom->base_link','map->odom','base_link->lidar_link']
  },
  nav2_lifecycle:{state_id:3,active_responses:3,last_error:null},
  timeout:{
   kind:'controlled_action_deadline',
   deadline_seconds:1.5,elapsed_seconds:1.507,
   feedback_count:2,pending_at_deadline:true
  },
  cancel:{
   goal:'study_desk',goal_accepted:true,
   cancel_request_sent:true,cancel_acknowledged:true,
   terminal_status:'CANCELED',tf_fresh:true,odom_advanced:true,
   position_drift_m:0.008,observation_seconds:1.5,
   nonzero_velocity_commands:0
  }
 };
}

async function withReport(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r59-live-report-'));
 const file=join(dir,'timeout.json');
 try{await fn(file,dir);}
 finally{await rm(dir,{recursive:true,force:true});}
}

test('R59 严格验证超时 → 取消 → 两段恢复的结构与当前 run ID',{timeout:15000},async()=>{
 await withReport(async file=>{
  await writeFile(file,JSON.stringify(fixture()));
  const valid=run('python3',[validator,'--report',file,'--run-id',RUN_ID]);
  assert.equal(valid.status,0,valid.stderr);
  const stale=run('python3',[validator,'--report',file,'--run-id','stale-run']);
  assert.equal(stale.status,1,stale.stderr);
  assert.match(stale.stderr,/ROS_TIMEOUT_RECOVERY_INVALID/);
 });
});

test('R59 无实际反馈、没有超时、超时后已到达、取消不完整均 fail-closed',{timeout:15000},async()=>{
 await withReport(async file=>{
  const mutate=[
   x=>{x.timeout.feedback_count=0;},
   x=>{x.timeout.pending_at_deadline=false;},
   x=>{x.timeout.elapsed_seconds=1.1;},
   x=>{x.timeout.elapsed_seconds=99;},
   x=>{x.timeout.kind='user_request';},
   x=>{x.timeout.deadline_seconds=0.01;},
   x=>{x.checks=x.checks.filter(c=>c!=='nav2_forced_timeout_observed');},
   x=>{x.cancel.cancel_acknowledged=false;},
   x=>{x.cancel.terminal_status='SUCCEEDED';},
   x=>{x.cancel.position_drift_m=0.15;},
   x=>{x.cancel.nonzero_velocity_commands=1;},
   x=>{x.cancel.odom_advanced=false;},
   x=>{x.simulation_only=false;},
   x=>{x.release_approved=true;}
  ];
  for(const modify of mutate){
   const value=fixture();modify(value);
   await writeFile(file,JSON.stringify(value));
   const out=run('python3',[validator,'--report',file,'--run-id',RUN_ID]);
   assert.equal(out.status,1,JSON.stringify(value));
  }
 });
});

test('R59 恢复的目标顺序、独立里程计、到达容差和反馈不可伪造',{timeout:15000},async()=>{
 await withReport(async file=>{
  const mutate=[
   x=>{x.legs=[];},
   x=>{x.legs.reverse();},
   x=>{x.legs[0].goal='dock';},
   x=>{x.legs[0].verified=false;},
   x=>{x.legs[0].feedback_count=0;},
   x=>{x.legs[1].odom_distance_m=0.1;},
   x=>{x.legs[1].position_error_m=0.22;},
   x=>{x.legs[1].pose_x=5;},
   x=>{x.legs[1].x=4.9;},
   x=>{x.checks.pop();},
   x=>{x.status='failed';}
  ];
  for(const modify of mutate){
   const value=fixture();modify(value);
   await writeFile(file,JSON.stringify(value));
   const out=run('python3',[validator,'--report',file,'--run-id',RUN_ID]);
   assert.equal(out.status,1,JSON.stringify(value));
  }
 });
});

test('R59 runtime gate 单独阻断实测超时恢复，模拟故障不解除该缺口',{timeout:15000},async()=>{
 await withReport(async file=>{
  const initial=run('python3',[gate]);
  assert.equal(initial.status,0,initial.stderr);
  const baseline=JSON.parse(initial.stdout);
  assert.equal(baseline.ros_timeout_recovery,'not_run');
  assert.ok(baseline.remaining.includes('GAZEBO_NAV2_TIMEOUT_RECOVERY_RUNTIME'));
  await writeFile(file,JSON.stringify(fixture()));
  const verified=run('python3',[gate,
   '--ros-timeout-report',file,'--ros-timeout-run-id',RUN_ID]);
  assert.equal(verified.status,0,verified.stderr);
  const result=JSON.parse(verified.stdout);
  assert.equal(result.ros_timeout_recovery,'verified');
  assert.equal(result.ros_cancel_runtime,'not_run');
  assert.equal(result.ros_runtime,'not_run');
  assert.equal(result.release_approved,false);
  assert.ok(!result.remaining.includes('GAZEBO_NAV2_TIMEOUT_RECOVERY_RUNTIME'));
  assert.ok(result.remaining.includes('GAZEBO_NAV2_CANCEL_RUNTIME'));
  assert.ok(result.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));

  const invalid=run('python3',[gate,
   '--ros-timeout-report',file,'--ros-timeout-run-id','old-run']);
  assert.equal(invalid.status,1);
  assert.equal(JSON.parse(invalid.stdout).ros_timeout_recovery,'invalid');
  const unmatched=run('python3',[gate,'--ros-timeout-report',file]);
  assert.equal(unmatched.status,2);
  assert.match(unmatched.stderr,/ROS_TIMEOUT_REPORT_AND_RUN_ID_REQUIRED_TOGETHER/);
 });
});

test('R59 没有显式授权不得执行超时恢复，旧 PASS 在预检前作废',{timeout:15000},async()=>{
 await withReport(async(file,dir)=>{
  await writeFile(file,JSON.stringify(fixture()));
  const denied=run('bash',['scripts/run-ros-acceptance.sh'],{
   ALEX_ROS_ACCEPTANCE_MODE:'timeout-recovery',
   ALEX_ROS_SIMULATION_ONLY:'0',
   ALEX_RUN_ROS_INTEGRATION:'0',
   ALEX_ROS_REPORT:file,
   ALEX_ROS_LOG:join(dir,'launch.log'),
   ALEX_ROS_PREFLIGHT:join(dir,'preflight.json'),
   ALEX_ROS_DIAGNOSTICS:join(dir,'diagnostics.json')
  });
  assert.equal(denied.status,2,denied.stderr);
  const report=JSON.parse(await readFile(file,'utf8'));
  assert.equal(report.status,'blocked');
  assert.deepEqual(report.checks,[]);
  assert.deepEqual(report.legs,[]);
  const missing=run('python3',[rosSmoke,'--timeout-recovery'],{
   ALEX_ROS_SIMULATION_ONLY:'1',ALEX_RUN_ROS_INTEGRATION:'1',
   ROS_DISTRO:'jazzy',ROS_DOMAIN_ID:'0',
   ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST'
  });
  assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/NAV2_CANCEL_REQUIRES_ISOLATED_SIMULATION_DOMAIN/);
 });
});

test('R59 Python/Bash 编译和真实 Action 时序源码检查',{timeout:15000},async()=>{
 const py=run('python3',['-c',
  'from pathlib import Path;import sys;compile(Path(sys.argv[1]).read_text(),sys.argv[1],"exec")',
  rosSmoke]);
 assert.equal(py.status,0,py.stderr);
 const syntax=run('bash',['-n','scripts/run-ros-acceptance.sh']);
 assert.equal(syntax.status,0,syntax.stderr);
 const smoke=await readFile(rosSmoke,'utf8');
 assert.match(smoke,/feedback_callback=count_feedback if force_timeout else None/);
 assert.match(smoke,/feedback_observed\['count'\] > 0 or result\.done\(\)/);
 assert.match(smoke,/pending_at_deadline=not result\.done\(\)/);
 assert.match(smoke,/run_cancel_probe\(force_timeout=True\)/);
 assert.match(smoke,/run_goal\(DESK\)/);
 assert.match(smoke,/run_goal\(DOCK\)/);
 assert.ok(smoke.indexOf('run_cancel_probe(force_timeout=True)')<smoke.indexOf('run_goal(DOCK)'));
});
