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

test('v0.12 Nav2 sim settings are written to explicit nested ROS params, preserving controller plugins',()=>{
  const dest=mkdtempSync(join(tmpdir(),'alex-nav2-'));
  try{
    const out=join(dest,'params.yaml');
    const res=run('python3',[pkg+'alex_sim/nav2_tuning.py','--input',fixture,'--output',out]);
    assert.equal(res.status,0,res.stderr);
    const text=readFileSync(out,'utf8');
    assert.match(text,/base_frame_id: base_link/);
    assert.match(text,/set_initial_pose: true/);
    assert.match(text,/x: 0\.7/);
    assert.match(text,/y: 2\.8/);
    assert.match(text,/robot_radius: 0\.19/);
    assert.match(text,/inflation_radius: 0\.24/);
    assert.match(text,/xy_goal_tolerance: 0\.08/);
    assert.match(text,/vx_max: 0\.2/);
    assert.match(text,/plugin: nav2_mppi_controller::MPPIController/);
    assert.match(text,/use_sim_time: true/);
  }finally{rmSync(dest,{recursive:true,force:true})}
});

test('v0.12 incompatible Nav2 defaults fail closed instead of silently ignoring overrides',()=>{
  const res=run('python3',['-c',`import sys, yaml
sys.path.insert(0,'${pkg}alex_sim')
from nav2_tuning import configure_nav2, IncompatibleNav2Template
try:
  configure_nav2({'amcl': {'ros__parameters': {}}})
except IncompatibleNav2Template:
  sys.exit(0)
raise RuntimeError('unsafe tuning acceptance')`]);
  assert.equal(res.status,0,res.stderr);
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
  assert.match(launch,/ALEX_ROS_NAV2_PARAMS_FILE/);
  assert.match(launch,/nav2_tuning.py/);
  assert.match(launch,/ALEX_ROS_SIMULATION_ONLY/);
  const bridge=readFileSync(resolve(root,pkg+'config/bridge.yaml'),'utf8');
  assert.match(bridge,/direction: ROS_TO_GZ/);
  assert.ok(!bridge.includes('real_motor'));
  const shell=run('bash',['-n','scripts/run-ros-acceptance.sh']);
  assert.equal(shell.status,0,shell.stderr);
});
