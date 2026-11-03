import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const pkg = new URL('../robotics/ros2/alex_sim/', import.meta.url);
const read = path => readFileSync(new URL(path, pkg), 'utf8');

test('Harmonic gpu_lidar uses lidar configuration and a TF-compatible frame', () => {
  const sdf = read('models/alex_bot/model.sdf');
  assert.match(sdf, /<sensor name="lidar" type="gpu_lidar">/);
  assert.match(sdf, /<gz_frame_id>lidar_link<\/gz_frame_id>/);
  assert.match(sdf, /<lidar><scan><horizontal>/);
  assert.match(sdf, /<samples>360<\/samples>/);
  assert.doesNotMatch(sdf, /<ray>|<frame_id>lidar_link<\/frame_id>/);
  assert.match(read('urdf/alex_bot.urdf'), /link name="lidar_link"/);
});

test('Gazebo single-world clock bridge uses the observed root /clock', () => {
  const cfg = read('config/bridge.yaml');
  assert.match(cfg, /ros_topic_name: \/clock[\s\S]*?gz_topic_name: \/clock/);
  assert.doesNotMatch(cfg, /gz_topic_name: \/world\/alex_home\/clock/);
  assert.match(cfg, /direction: GZ_TO_ROS/);
  assert.match(cfg, /ros_topic_name: \/scan/);
  assert.match(read('worlds/alex_home.sdf'), /<world name="alex_home">/);
});

test('Gazebo verbose launch flags retain isolated server and headless opt-in', () => {
  const code = read('launch/sim.launch.py');
  assert.match(code, /gz_args = '-v 4 -r -s '/);
  assert.match(code, /--headless-rendering/);
  assert.match(code, /ALEX_ROS_SIMULATION_ONLY/);
});
