import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {MAP,occupied} from '../dist/robot/map.js';
import {toNav2Goal,toGridPose} from '../scripts/ros2-navigation.mjs';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(resolve(cwd,p),'utf8');
const pkg='robotics/ros2/alex_sim/';
const config=name=>read(pkg+name);
const spawn=(command,args,env={})=>spawnSync(command,args,{cwd,encoding:'utf8',timeout:7000,env:{...process.env,...env}});

test('v0.11 Gazebo world & Nav2 map are reproducible from canonical TypeScript map',()=>{
  const result=spawn(process.execPath,['scripts/generate-sim-assets.mjs','--check']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/match/);
});

test('v0.11 PGM map has identical occupancy and correct ROS lower-left y origin',()=>{
  const lines=config('maps/alex_home.pgm').split('\n').filter(s=>s&&!s.startsWith('#'));
  assert.deepEqual(lines.slice(0,3),['P2',`${MAP.width} ${MAP.height}`,'255']);
  const vals=lines.slice(3).flatMap(row=>row.trim().split(/\s+/).map(Number));
  assert.equal(vals.length,MAP.width*MAP.height);
  for(let y=0;y<MAP.height;y++)for(let x=0;x<MAP.width;x++){
    assert.equal(vals[(MAP.height-1-y)*MAP.width+x],occupied(x,y)?0:254,`cell ${x},${y}`);
  }
});

test('v0.11 ROS coordinates match each allowed Alex destination exactly',()=>{
  for(const [name,point] of Object.entries(MAP.destinations)){
    const goal=toNav2Goal(name);
    assert.ok(Math.abs(goal.x-point.x*MAP.cellMeters)<1e-9);
    assert.ok(Math.abs(goal.y-point.y*MAP.cellMeters)<1e-9);
    assert.deepEqual(toGridPose({x:goal.x,y:goal.y,yaw:0}),{x:point.x,y:point.y,heading:0});
    assert.equal(occupied(point.x,point.y),false);
  }
  assert.match(config('worlds/alex_home.sdf'),/<pose>0\.7 2\.8 0 0 0 0<\/pose>/);
  assert.match(config('maps/alex_home.yaml'),/origin: \[-0\.05, -0\.05, 0\.0\]/);
});

test('v0.11 robot Gazebo model has wheels, lidar, odom and simulated velocity topic',()=>{
  const model=config('models/alex_bot/model.sdf');
  for(const value of ['left_wheel_joint','right_wheel_joint','gz::sim::systems::DiffDrive','gpu_lidar','/scan','/odom','/tf','/cmd_vel'])assert.ok(model.includes(value),value);
  assert.match(config('urdf/alex_bot.urdf'),/link name="lidar_link"/);
  assert.match(config('config/bridge.yaml'),/ros_topic_name: \/clock/);
  assert.match(config('config/bridge.yaml'),/ros_topic_name: \/scan/);
});

test('v0.11 Python/XML/SDF/URDF static validator passes without ROS installed',()=>{
  const result=spawn('python3',['scripts/validate-ros-assets.py']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/NO ROS2 runtime/);
});

test('v0.11 ROS launch refuses to run unless simulation-only mode is explicitly enabled',()=>{
  const env={...process.env};delete env.ALEX_ROS_SIMULATION_ONLY;
  const result=spawnSync('bash',['scripts/launch-ros-sim.sh'],{cwd,encoding:'utf8',timeout:3000,env});
  assert.equal(result.status,2);
  assert.match(result.stderr,/ALEX_ROS_SIMULATION_ONLY=1/);
});

test('v0.11 ROS smoke fails closed without explicit integration-test opt-in',()=>{
  const env={...process.env};delete env.ALEX_RUN_ROS_INTEGRATION;delete env.ALEX_ROS_SIMULATION_ONLY;
  const result=spawnSync('python3',[pkg+'scripts/ros_smoke.py'],{cwd,encoding:'utf8',timeout:3000,env});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/simulation integration test requires explicit/i);
});

test('v0.11 simulation package includes both Nav2 map and graph checks, but no real motor driver',()=>{
  const launch=config('launch/sim.launch.py');
  const smoke=config('scripts/ros_smoke.py');
  assert.match(launch,/bringup_launch\.py/);
  assert.match(launch,/robot_state_publisher/);
  assert.match(launch,/parameter_bridge/);
  for(const topic of ['/clock','/scan','/odom','/map','/navigate_to_pose'])assert.ok(smoke.includes(topic),topic);
  assert.ok(!config('models/alex_bot/model.sdf').includes('ros2_control'));
});
