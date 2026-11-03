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
    'laser_clearance', 'local_footprint', 'points_inside_0_19m',
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
