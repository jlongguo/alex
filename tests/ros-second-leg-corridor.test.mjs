import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

function loadMap() {
  const lines = read('robotics/ros2/alex_sim/maps/alex_home.pgm')
    .split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  assert.equal(lines[0], 'P2');
  const [width, height] = lines[1].split(/\s+/).map(Number);
  assert.equal(lines[2], '255');
  const pixels = lines.slice(3).join(' ').split(/\s+/).map(Number);
  assert.equal(pixels.length, width * height);
  return {width, height, pixels};
}

function canTraverse(map, start, goal, clearanceMeters) {
  const {width, height, pixels} = map;
  const blocked = (x, y) =>
    x < 0 || x >= width || y < 0 || y >= height ||
    pixels[(height - 1 - y) * width + x] !== 254;
  const safe = (x, y) => {
    const n = Math.ceil(clearanceMeters / 0.1);
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) {
      if (Math.hypot(dx, dy) * 0.1 <= clearanceMeters + 1e-9 && blocked(x + dx, y + dy))
        return false;
    }
    return true;
  };
  if (!safe(...start) || !safe(...goal)) return false;
  const queue = [start], seen = new Set([start.join(',')]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    if (x === goal[0] && y === goal[1]) return true;
    for (const [dx, dy] of [[1,0], [-1,0], [0,1], [0,-1]]) {
      const next = [x + dx, y + dy], key = next.join(',');
      if (!seen.has(key) && safe(...next)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }
  return false;
}

test('the second leg has a connected corridor at the declared collision radius', () => {
  const map = loadMap();
  const desk = [17, 16], story = [49, 17];
  // Offline topology only. This does not prove Nav2, dynamic clearance,
  // wheel contacts, collision monitor, or actual motion.
  assert.equal(canTraverse(map, desk, story, 0.24), true);
  assert.equal(canTraverse(map, desk, story, 0.30), true);
  assert.equal(canTraverse(map, desk, story, 0.40), false);
});

test('second-leg failure evidence covers collision intervention, path and speed', () => {
  const smoke = read('robotics/ros2/alex_sim/scripts/ros_smoke.py');
  for (const needle of [
    '/collision_monitor_state', 'CollisionMonitorState',
    'collision_state_received', 'global_plan', 'plan_received',
    'mean_abs_linear_mps', 'ROS failed goal diagnostics:',
    'sim_real_time_factor', 'position_trace', 'sim_seconds',
    'heading_rad', 'velocity_interval', 'mean_abs_angular_rps',
    'laser_clearance', 'initial_laser_clearance', 'SIM_LIDAR_SELF_HIT',
    'local_footprint', 'points_inside_0_19m',
    'gazebo_pose_before_goal', 'gazebo_pose_at_goal_end',
    'gazebo_pose_at_arrival', 'query_gz_model_pose',
    'requested_yaw_rad', 'goal_arrival_heading',
    'odom_distance_m', 'NAV2_GOAL_TIMEOUT_CANCEL_',
  ]) assert.ok(smoke.includes(needle), needle);
  const tuning = read('robotics/ros2/alex_sim/alex_sim/nav2_tuning.py');
  assert.match(tuning, /controller\['controller_frequency'\] = 10\.0/);
  assert.match(tuning, /follow_path\['model_dt'\] = 0\.10/);
  assert.match(tuning, /follow_path\['time_steps'\] = max\(1, round\(horizon \/ 0\.10\)\)/);
  assert.match(tuning, /checker\['movement_time_allowance'\] = max/);
  assert.match(tuning, /collision_monitor\['base_frame_id'\] = 'base_link'/);
});

test('arrival quaternion is aligned with the current navigation leg and never changes destination', () => {
  const source = `import math, sys
sys.path.insert(0, 'robotics/ros2/alex_sim/alex_sim')
from acceptance import DOCK, DESK, STORY, ACCEPTANCE_ROUTE, goal_arrival_heading
for start, goal in [((0.7, 2.8), DESK), ((1.7, 1.6), STORY), ((4.9, 1.7), DOCK)]:
    yaw, z, w = goal_arrival_heading(start, goal)
    assert abs(yaw - math.atan2(goal.y-start[1], goal.x-start[0])) < 1e-10
    assert abs(z*z + w*w - 1.0) < 1e-10
assert [(goal.x,goal.y) for goal in ACCEPTANCE_ROUTE] == [(1.7,1.6),(4.9,1.7),(0.7,2.8)]
for invalid in [None, (float('nan'),1), (2,)]:
    try: goal_arrival_heading(invalid, DESK)
    except (ValueError,TypeError): pass
    else: raise AssertionError('accepted invalid pose')
try: goal_arrival_heading((DESK.x, DESK.y), DESK)
except ValueError: pass
else: raise AssertionError('accepted degenerate yaw')
print('PASS')`;
  const result = spawnSync('python3', ['-c', source], {cwd: root, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
});

test('GPU lidar visibility mask excludes only robot visuals and wheel joints have effort bounds', () => {
  const model = read('robotics/ros2/alex_sim/models/alex_bot/model.sdf');
  assert.match(model, /<visibility_mask>4294967293<\/visibility_mask>/);
  assert.equal((model.match(/<visibility_flags>2<\/visibility_flags>/g) || []).length, 4);
  assert.equal((model.match(/<effort>1000000<\/effort>/g) || []).length, 2);
  assert.match(model, /<range><min>0\.06<\/min><max>5\.0<\/max>/);
  const lidarMask = 4294967293n, robotVisualFlag = 2n;
  assert.equal(lidarMask & robotVisualFlag, 0n);
  assert.notEqual(lidarMask & 0xffffffffn, 0n);
});

test('physics support triangle places the mass-weighted chassis COM behind the axle', () => {
  const model = read('robotics/ros2/alex_sim/models/alex_bot/model.sdf');
  assert.match(model, /<inertial><pose>-0\.04 0 0 0 0 0<\/pose><mass>1\.3<\/mass>/);
  assert.match(model, /<pose>-0\.09 0 0\.027 0 0 0<\/pose>/);
  const total = 1.3 + 0.08 + 0.08 + 0.025;
  const comX = (1.3 * -0.04 + 0.025 * -0.09) / total;
  assert.ok(comX < -0.02 && comX > -0.075, `COM ${comX} must remain in 3-point wheel/caster support`);
  // This triangle has wheel contact x=0, y=+/-0.145 and caster x=-0.09.
  const lateralHalfwidthAtCom = 0.145 * ((comX + 0.09) / 0.09);
  assert.ok(lateralHalfwidthAtCom > 0.045);
  assert.equal(1.3 / total > 0.85, true);
});

test('read-only ground-truth Gazebo pose parser extracts pitch and yaw, fails on invalid output', () => {
  const script = `import sys
sys.path.insert(0, 'robotics/ros2/alex_sim/alex_sim')
from gz_pose import parse_gz_model_pose
raw = """Requesting state for world [alex_home]...
Model: [55]
- Name: alex_bot
- Pose [ XYZ (m) ] [ RPY (rad) ]:
[1.6574 | 1.6432 | 0.0000]
[0.025 | -0.820 | 0.0115]
"""
result = parse_gz_model_pose(raw)
assert result['available']
assert result['xyz_m'] == [1.6574, 1.6432, 0.0]
assert result['rpy_rad'] == [0.025, -0.82, 0.0115]
assert result['max_abs_tilt_rad'] == 0.82
for invalid in ('', 'Pose [ XYZ (m) ] [ RPY (rad) ]:', raw.replace('0.025', 'NaN')):
    try: parse_gz_model_pose(invalid)
    except ValueError: pass
    else: raise RuntimeError('accepted invalid Gazebo model pose')
print('PASS')`;
  const result = spawnSync('python3', ['-c', script], {cwd: root, encoding:'utf8', timeout:10000});
  assert.equal(result.status, 0, result.stderr);
});

test('third leg from story corner to dock has traversable static corridors without safety erosion', () => {
  const map = loadMap();
  const story = [49,17], dock = [7,28];
  // This only proves static topology. Real hardware geometry, MPPI and
  // dynamic obstacles must still be verified by Gazebo acceptance.
  assert.equal(canTraverse(map, story, dock, 0.24), true);
  assert.equal(canTraverse(map, story, dock, 0.30), true);
  assert.equal(canTraverse(map, story, dock, 0.40), false);
  const tuning = read('robotics/ros2/alex_sim/alex_sim/nav2_tuning.py');
  assert.match(tuning, /follow_path\['prune_distance'\] = min\(float\(prune\), 1\.2\)/);
  assert.match(tuning, /\('PathAlignCritic', 8\)/);
  assert.match(tuning, /\('PathFollowCritic', 3\)/);
  assert.match(tuning, /\('PathAngleCritic', 2\)/);
});

test('Gazebo Harmonic pose command uses documented model-info CLI, not unsupported --pose', () => {
  const script = `import sys
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0, 'robotics/ros2/alex_sim/alex_sim')
from gz_pose import query_gz_model_pose
sample = """Requesting state for world [alex_home]...
Model: [56]
- Name: alex_bot
- Pose [ XYZ (m) ] [ RPY (rad) ]:
[2.010 | 1.655 | 0.110]
[0.001 | -0.003 | 1.700]
"""
with patch('gz_pose.subprocess.run', return_value=SimpleNamespace(returncode=0,stdout=sample,stderr='')) as mock:
    pose = query_gz_model_pose()
    assert pose['available']
    assert pose['xyz_m'] == [2.01,1.655,0.11]
    assert pose['max_abs_tilt_rad'] == 0.003
    args = mock.call_args.args[0]
    assert args == ['gz','model','-m','alex_bot']
    assert '--pose' not in args
print('PASS')`;
  const result = spawnSync('python3', ['-c', script], {cwd:root, encoding:'utf8', timeout:10000});
  assert.equal(result.status, 0, result.stderr);
});
