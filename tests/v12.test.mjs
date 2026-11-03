import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const pkg='robotics/ros2/alex_sim/';
const run=(cmd,args,options={})=>spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout:10000,...options});
const fixture=join(pkg,'../../..','tests/fixtures/nav2-jazzy-minimal.yaml');

// The deterministic tuning policy can be checked without ROS or PyYAML.
// YAML serialization is separately exercised when PyYAML exists in the selected
// python3; otherwise its *explicit* missing-dependency error is validated.
const jsonFixture=join('tests','fixtures','nav2-jazzy-minimal.json');
const tuner=join(pkg,'alex_sim','nav2_tuning.py');
const pypath=join(pkg,'alex_sim');
const tuneAsJson=`import json,sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from nav2_tuning import configure_nav2
source=json.loads(Path(sys.argv[2]).read_text(encoding='utf8'))
result=configure_nav2(source)
assert source['amcl']['ros__parameters']['base_frame_id'] == 'base_footprint', 'mutated source'
print(json.dumps(result))`;

test('v0.12 Nav2 tuning keeps nested ROS params and controller plugin with no PyYAML required',()=>{
  const res=run('python3',['-c',tuneAsJson,pypath,jsonFixture]);
  assert.equal(res.status,0,res.stderr);
  const config=JSON.parse(res.stdout);
  const amcl=config.amcl.ros__parameters;
  assert.equal(amcl.base_frame_id,'base_link');
  assert.equal(amcl.set_initial_pose,true);
  assert.deepEqual([amcl.initial_pose.x,amcl.initial_pose.y],[0.7,2.8]);
  assert.equal(config.controller_server.ros__parameters.FollowPath.plugin,'nav2_mppi_controller::MPPIController');
  assert.equal(config.controller_server.ros__parameters.FollowPath.vx_max,0.2);
  assert.equal(config.controller_server.ros__parameters.general_goal_checker.xy_goal_tolerance,0.08);
  for(const costmap of ['local_costmap','global_costmap']){
    const c=config[costmap][costmap].ros__parameters;
    assert.equal(c.robot_radius,0.19);
    assert.equal(c.inflation_layer.inflation_radius,0.24);
    assert.equal(c.use_sim_time,true);
  }
  assert.equal(config.bt_navigator.ros__parameters.use_sim_time,true);
  assert.equal(config.bt_navigator.ros__parameters.robot_base_frame,'base_link');
  assert.equal(config.behavior_server.ros__parameters.robot_base_frame,'base_link');
  const monitor=config.collision_monitor.ros__parameters;
  assert.equal(monitor.base_frame_id,'base_link');
  assert.equal(monitor.odom_frame_id,'odom');
  assert.equal(monitor.cmd_vel_in_topic,'cmd_vel_smoothed');
  assert.equal(monitor.cmd_vel_out_topic,'cmd_vel');
  assert.deepEqual(monitor.observation_sources,['scan']);
  assert.equal(monitor.scan.topic,'scan');
  assert.equal(monitor.use_sim_time,true);
});

test('v0.12 incompatible Nav2 defaults fail closed instead of silently ignoring overrides',()=>{
  const res=run('python3',['-c',`import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from nav2_tuning import configure_nav2, IncompatibleNav2Template
source=json.loads(Path(sys.argv[2]).read_text(encoding='utf8'))
for candidate in ({'amcl': {'ros__parameters': {}}},
                  {**source,'controller_server':{'ros__parameters':{'controller_plugins':['Other']}}},
                  {**source,'local_costmap':{'local_costmap':{'ros__parameters':{}}}},
                  {**source,'collision_monitor':{'ros__parameters':{}}},
                  {**source,'collision_monitor':{'ros__parameters':{
                       **source['collision_monitor']['ros__parameters'],
                       'cmd_vel_out_topic':'unsafe_bypass'
                   }}}):
  try: configure_nav2(candidate)
  except IncompatibleNav2Template: pass
  else: raise RuntimeError('unsafe tuning accepted an incompatible template')`,pypath,jsonFixture]);
  assert.equal(res.status,0,res.stderr);
});

test('v0.12 YAML CLI either round-trips Nav2 settings or reports how to install PyYAML',()=>{
  const hasYaml=run('python3',['-c','import yaml']);
  const dest=mkdtempSync(join(tmpdir(),'alex-nav2-'));
  try{
    const out=join(dest,'params.yaml');
    const res=run('python3',[tuner,'--input',fixture,'--output',out]);
    if(hasYaml.status!==0){
      assert.notEqual(res.status,0);
      assert.match(res.stderr,/PyYAML.+(install|python3 -m venv)/i);
      return;
    }
    assert.equal(res.status,0,res.stderr);
    const text=readFileSync(out,'utf8');
    for(const pattern of [/base_frame_id: base_link/,/cmd_vel_in_topic: cmd_vel_smoothed/,/cmd_vel_out_topic: cmd_vel/,/set_initial_pose: true/,/x: 0\.7/,/y: 2\.8/,
      /robot_radius: 0\.19/,/inflation_radius: 0\.24/,/xy_goal_tolerance: 0\.08/,
      /vx_max: 0\.2/,/plugin: nav2_mppi_controller::MPPIController/,/use_sim_time: true/]) {
      assert.match(text,pattern);
    }
  }finally{rmSync(dest,{recursive:true,force:true})}
});

test('v0.12 independent pose proof rejects Nav2 success without fresh TF or feedback',()=>{
  const res=run('python3',['-c',`import sys
sys.path.insert(0,'${pkg}alex_sim')
from acceptance import DESK, verify_arrival
for kw in [dict(status='FAILED', feedback_count=3, tf_fresh=True, odom_distance_m=2, start_distance_m=1), dict(status='SUCCEEDED', feedback_count=0, tf_fresh=True, odom_distance_m=2, start_distance_m=1),dict(status='SUCCEEDED', feedback_count=3, tf_fresh=False, odom_distance_m=2, start_distance_m=1)]:
  try: verify_arrival(DESK,(1.7,1.6),**kw)
  except ValueError: pass
  else: raise RuntimeError('false arrival')
try: verify_arrival(DESK,(2.3,1.6),status='SUCCEEDED',feedback_count=2,tf_fresh=True,odom_distance_m=2,start_distance_m=1)
except ValueError: pass
else: raise RuntimeError('goal outside tolerance accepted')
assert verify_arrival(DESK,(1.75,1.63),status='SUCCEEDED',feedback_count=2,tf_fresh=True,odom_distance_m=2,start_distance_m=1) > 0`]);
  assert.equal(res.status,0,res.stderr);
});

test('v0.12 acceptance route is dock -> study desk -> story corner -> dock, in canonical map coordinates',()=>{
  const res=run('python3',['-c',`import sys
sys.path.insert(0,'${pkg}alex_sim')
from acceptance import ACCEPTANCE_ROUTE
assert [(p.name,p.x,p.y) for p in ACCEPTANCE_ROUTE] == [('study_desk',1.7,1.6),('story_corner',4.9,1.7),('dock',0.7,2.8)]`]);
  assert.equal(res.status,0,res.stderr);
});

test('v0.12 graph evidence rejects missing scan, stale clock, missing transforms and absent action',()=>{
  const res=run('python3',['-c',`import sys
sys.path.insert(0,'${pkg}alex_sim')
from acceptance import verify_graph
seen={'clock','scan','odom','map'}
frames={('odom','base_link'),('map','odom'),('base_link','lidar_link')}
verify_graph(seen,frames,True,True)
for opts in [(seen-{'scan'},frames,True,True),(seen,frames-{('map','odom')},True,True),(seen,frames,False,True),(seen,frames,True,False)]:
  try: verify_graph(*opts)
  except ValueError: pass
  else: raise RuntimeError('graph false success')`]);
  assert.equal(res.status,0,res.stderr);
});

test('v0.12 headless acceptance refuses to run without BOTH flags',()=>{
  const env={...process.env,ROS_DISTRO:'jazzy',ALEX_ROS_SIMULATION_ONLY:'1'};
  delete env.ALEX_RUN_ROS_INTEGRATION;
  const result=run('bash',['scripts/run-ros-acceptance.sh'],{env});
  assert.equal(result.status,2);
  assert.match(result.stderr,/SIMULATION_ONLY=1.*INTEGRATION=1/);
  const smoke=run('python3',[pkg+'scripts/ros_smoke.py','--route'],{env});
  assert.notEqual(smoke.status,0);
  assert.match(smoke.stderr,/requires explicit/i);
});

test('v0.12 graph and route smoke contains a real Nav2 Action client and artifact report logic',()=>{
  const script=readFileSync(resolve(root,pkg+'scripts/ros_smoke.py'),'utf8');
  for(const k of ['--route','current_tf_pose','NavigateToPose','feedback_count','odom_distance_m','acceptance-report.json','save_report','cancel_goal_async'])assert.ok(script.includes(k),k);
  assert.equal(run('python3',['-m','py_compile',pkg+'scripts/ros_smoke.py',pkg+'alex_sim/acceptance.py',pkg+'alex_sim/nav2_tuning.py',pkg+'launch/sim.launch.py']).status,0);
});

test('v0.12 simulated launch generates ROS Nav2 params, does not bridge to a real robot',()=>{
  const launch=readFileSync(resolve(root,'scripts/launch-ros-sim.sh'),'utf8');
  const prep=readFileSync(resolve(root,'scripts/prepare-ros-sim.sh'),'utf8');
  assert.match(launch,/source.*prepare-ros-sim\.sh/);
  assert.match(prep,/ALEX_ROS_NAV2_PARAMS_FILE/);
  assert.match(prep,/nav2_tuning.py/);
  assert.match(prep,/ALEX_ROS_SIMULATION_ONLY/);
  const bridge=readFileSync(resolve(root,pkg+'config/bridge.yaml'),'utf8');
  assert.match(bridge,/direction: ROS_TO_GZ/);
  assert.ok(!bridge.includes('real_motor'));
  const shell=run('bash',['-n','scripts/run-ros-acceptance.sh']);
  assert.equal(shell.status,0,shell.stderr);
});
