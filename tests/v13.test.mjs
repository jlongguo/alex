import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd, args, options = {}) => spawnSync(cmd, args, {
  cwd: root, encoding: 'utf8', timeout: 15000, ...options
});
const launch = 'robotics/ros2/alex_sim/launch/sim.launch.py';

test('v0.13 launch description actually executes with offline ROS stubs', () => {
  const result = run('python3', ['scripts/validate-ros-launch.py']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PASS/);
});

test('v0.13 nav2_bringup launch exists and headless GPU LiDAR can be opted in', () => {
  const text = readFileSync(resolve(root, launch), 'utf8');
  assert.match(text, /get_package_share_directory\('nav2_bringup'\)/);
  assert.match(text, /NAV2_BRINGUP_LAUNCH_MISSING/);
  assert.match(text, /--headless-rendering/);
  assert.match(text, /ALEX_GZ_HEADLESS_RENDERING/);
});

test('v0.13 evidence writer cannot forge a runtime pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-ros-evidence-'));
  try {
    const file = join(dir, 'report.json');
    const unsafe = run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'passed', '--reason', 'FORGED']);
    assert.notEqual(unsafe.status, 0);
    const init = run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'blocked', '--reason', 'PREFLIGHT_PENDING']);
    assert.equal(init.status, 0, init.stderr);
    const a = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(a.status, 'blocked');
    assert.equal(a.runtime_validation, 'NOT_PASSED');
    assert.equal(a.legs.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.13 new run always clears prior successful evidence; trap cannot overwrite a real result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-ros-evidence-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ status: 'passed', checks: ['fake'], legs: [{ verified: true }] }));
    const reset = run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'blocked', '--reason', 'PREFLIGHT_PENDING']);
    assert.equal(reset.status, 0, reset.stderr);
    let report = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.legs, []);
    const id = report.run_id;
    run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'running', '--reason', 'RUNNING']);
    report = JSON.parse(readFileSync(file, 'utf8'));
    const fail = run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'failed', '--reason', 'CRASH', '--if-status', 'running']);
    assert.equal(fail.status, 0, fail.stderr);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'failed');
    assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).run_id, id);
    const noOverwrite = run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'failed', '--reason', 'CRASH', '--if-status', 'running']);
    assert.equal(noOverwrite.status, 0);
    assert.match(noOverwrite.stdout, /unchanged/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.13 acceptance refuses missing opt-in and writes blocked, never stale pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-ros-accept-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ status: 'passed', legs: [{ verified: true }] }));
    const env = { ...process.env, ALEX_ROS_REPORT: file, ALEX_ROS_SIMULATION_ONLY: '1', ROS_DISTRO: 'jazzy' };
    delete env.ALEX_RUN_ROS_INTEGRATION;
    const res = run('bash', ['scripts/run-ros-acceptance.sh'], { env });
    assert.equal(res.status, 2, res.stderr);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.legs, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.13 sim:check incorporates runtime launch semantics and acceptance script shell is valid', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['sim:check'], /validate-ros-launch/);
  assert.equal(run('bash', ['-n', 'scripts/run-ros-acceptance.sh']).status, 0);
  assert.equal(run('python3', ['-m', 'py_compile', launch, 'scripts/validate-ros-launch.py', 'scripts/ros-evidence.py']).status, 0);
});

test('v0.13 report verifier rejects false positive status, missing legs and stale pose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-ros-verify-'));
  try {
    const file = join(dir, 'report.json');
    const route = [
      { goal: 'study_desk', x: 1.7, y: 1.6, pose_x: 1.73, pose_y: 1.61 },
      { goal: 'story_corner', x: 4.9, y: 1.7, pose_x: 4.89, pose_y: 1.71 },
      { goal: 'dock', x: 0.7, y: 2.8, pose_x: 0.71, pose_y: 2.80 },
    ].map(x => ({ ...x, verified: true, position_error_m: 0.04, odom_distance_m: 1.2, wall_seconds: 9.3, feedback_count: 3 }));
    const data = { schema: 'alex.dev/ros-acceptance/v1', status: 'passed', mode: 'route', simulation_only: true,
      checks: ['clock_scan_odom_map_tf_nav2_ready'], legs: route };
    const verify = () => run('python3', ['scripts/verify-ros-report.py', '--report', file]);
    writeFileSync(file, JSON.stringify(data));
    assert.equal(verify().status, 0);
    for (const modification of [
      obj => { obj.legs = obj.legs.slice(0, 1); },
      obj => { obj.status = 'running'; },
      obj => { obj.legs[0].verified = false; },
      obj => { obj.legs[1].pose_x += 0.4; },
      obj => { obj.checks = []; },
      obj => { obj.legs[2].feedback_count = 0; },
    ]) {
      const damaged = structuredClone(data);
      modification(damaged);
      writeFileSync(file, JSON.stringify(damaged));
      assert.notEqual(verify().status, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.13 an invalid passed report can be downgraded without fabricating success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-ros-verify-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ status: 'passed', mode: 'route', legs: [{verified:false}] }));
    const result = run('python3', ['scripts/ros-evidence.py', '--report', file, '--status', 'failed', '--reason', 'REPORT_VERIFICATION_FAILED', '--if-status', 'passed']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.13 live simulation workflow is manual-only and gated on dedicated runner', () => {
  const src = readFileSync(resolve(root, '.github/workflows/ros-sim-acceptance.yml'), 'utf8');
  assert.match(src, /workflow_dispatch:/);
  assert.match(src, /ALEX_SIM_RUNNER_APPROVED/);
  assert.match(src, /alex-ros-sim/);
  assert.match(src, /ALEX_ROS_SIMULATION_ONLY/);
  assert.doesNotMatch(src, /\n\s+(?:push|pull_request):/);
});
