import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..');
const source = 'robotics/ros2/alex_sim/alex_sim';
const call = code => spawnSync('python3',['-c',code],{cwd:root,encoding:'utf8',timeout:10000});

function inspect(setup) {
  const result = call(`import json,sys
sys.path.insert(0,${JSON.stringify(source)})
from acceptance import graph_readiness_snapshot
${setup}
print(json.dumps(snapshot))`);
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('graph snapshot identifies a missing ROS graph without reporting success',()=>{
  const result=inspect(`snapshot=graph_readiness_snapshot(set(),set(),[],odom_samples=0,scan_samples=0,scan_ranges=0,map_valid=False,tf_fresh=False,nav2_ready=False)`);
  assert.equal(result.ready_candidate,false);
  for(const missing of ['clock_missing','scan_missing','odom_missing','map_missing_or_invalid',
       'tf_missing:odom->base_link','tf_missing:map->odom','tf_missing:base_link->lidar_link',
       'map_to_base_link_tf_not_fresh','navigate_to_pose_not_ready'])
    assert.ok(result.missing.includes(missing),missing);
  assert.ok(result.hints.some(hint=>hint.includes('gpu_lidar')));
});

test('graph snapshot detects non-advancing clock and insufficient laser ranges',()=>{
  const result=inspect(`snapshot=graph_readiness_snapshot({'clock','scan','odom','map'},
      {('odom','base_link'),('map','odom'),('base_link','lidar_link')},[10,10],
      odom_samples=2,scan_samples=1,scan_ranges=3,map_valid=True,tf_fresh=True,nav2_ready=True)`);
  assert.deepEqual(result.missing,['clock_not_advancing','scan_insufficient_ranges']);
});

test('graph snapshot is bounded and all healthy evidence is required for readiness',()=>{
  const result=inspect(`snapshot=graph_readiness_snapshot({'clock','scan','odom','map'},
      {('odom','base_link'),('map','odom'),('base_link','lidar_link')},[10,20],
      odom_samples=2,scan_samples=1,scan_ranges=360,map_valid=True,tf_fresh=True,nav2_ready=True,
      observed_topics=['/scan']*200,publisher_counts={'/scan':1,'/clock':2})`);
  assert.equal(result.ready_candidate,true);
  assert.deepEqual(result.missing,[]);
  assert.equal(result.publishers['/scan'],1);
  assert.equal(result.publishers['/odom'],0);
  assert.deepEqual(result.observed_topics,['/scan']);
});

test('ROS graph timeout persists stage evidence and shell displays Gazebo launch errors',()=>{
  const smoke=readFileSync(resolve(root,'robotics/ros2/alex_sim/scripts/ros_smoke.py'),'utf8');
  const shell=readFileSync(resolve(root,'scripts/run-ros-acceptance.sh'),'utf8');
  const diagnostics=readFileSync(resolve(root,'scripts/diagnose-ros-acceptance.py'),'utf8');
  assert.match(smoke,/stage == 'ROS_GRAPH'/);
  assert.match(smoke,/record_graph_snapshot\(\)/);
  assert.match(smoke,/report\['graph'\] = snapshot/);
  assert.match(shell,/tail -n 90 "\$log"/);
  assert.match(shell,/exit "\$smoke_status"/);
  assert.match(diagnostics,/'graph': state\.get\('graph', \{\}\)/);
});
