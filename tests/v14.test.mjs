import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd, args, options = {}) => spawnSync(cmd, args, {
  cwd: root, encoding: 'utf8', timeout: 10000, ...options,
});

function fakeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'alex-v14-ros-overlay-'));
  const scripts = join(dir, 'scripts');
  const bin = join(dir, 'bin');
  const local = join(dir, '.local/ros');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(local, 'install'), { recursive: true });
  copyFileSync(join(root, 'scripts/prepare-ros-sim.sh'), join(scripts, 'prepare-ros-sim.sh'));
  const ros2 = join(bin, 'ros2');
  writeFileSync(ros2, `#!/usr/bin/env bash
if [[ "$1" == pkg && "$2" == prefix ]]; then
  if [[ "$3" == alex_sim ]]; then
    if [[ "\${FAKE_BAD_PREFIX:-0}" == 1 ]]; then echo /wrong/alex; else echo "$FAKE_ROOT/.local/ros/install/alex_sim"; fi
  else echo "$FAKE_ROOT/dependencies/$3"; fi
  exit 0
fi
exit 2
`);
  chmodSync(ros2, 0o755);
  for (const exe of ['gz', 'colcon']) {
    writeFileSync(join(bin, exe), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, exe), 0o755);
  }
  writeFileSync(join(local, 'nav2_params.generated.yaml'), 'amcl:\n  ros__parameters: {}\n');
  writeFileSync(join(local, 'install/setup.bash'), 'export ALEX_TEST_OVERLAY=loaded\nexport PYTHONPATH="/alex-virtual-overlay:${PYTHONPATH:-}"\n');
  const env = {
    ...process.env, FAKE_ROOT: dir, PATH: bin + ':' + process.env.PATH,
    ALEX_ROS_SIMULATION_ONLY: '1', ROS_DISTRO: 'jazzy',
    ROS_DOMAIN_ID: '77', ALEX_ROS_WORKSPACE_PREPARED: '1',
  };
  return { dir, env, script: join(scripts, 'prepare-ros-sim.sh'), cleanup: () => rmSync(dir, {recursive:true,force:true}) };
}

test('v0.14 sourced ROS overlay reaches the parent shell and its child processes', () => {
  const f = fakeWorkspace();
  try {
    const res = run('bash', ['-c', 'source "$FAKE_ROOT/scripts/prepare-ros-sim.sh"; bash -c \'printf "%s:%s:%s" "$ALEX_TEST_OVERLAY" "$ROS_DOMAIN_ID" "$ALEX_ROS_WORKSPACE_PREPARED"\''], { env: f.env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'loaded:77:1');
  } finally { f.cleanup(); }
});

test('v0.14 preparation refuses execution, wrong domain, missing simulation opt-in or a mismatched overlay', () => {
  const f = fakeWorkspace();
  try {
    const invoke = env => run('bash', ['-c', 'source "$FAKE_ROOT/scripts/prepare-ros-sim.sh"'], { env });
    assert.equal(run('bash', [f.script], { env: f.env }).status, 2);
    assert.notEqual(invoke({ ...f.env, ALEX_ROS_SIMULATION_ONLY: '0' }).status, 0);
    assert.notEqual(invoke({ ...f.env, ROS_DOMAIN_ID: '21' }).status, 0);
    const bad = invoke({ ...f.env, FAKE_BAD_PREFIX: '1' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /overlay mismatch/);
    assert.equal(invoke(f.env).status, 0);
  } finally { f.cleanup(); }
});

test('v0.14 route verifier binds the report to this invocation ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-v14-run-id-'));
  try {
    const report = join(dir, 'report.json');
    const route = [
      {goal:'study_desk',x:1.7,y:1.6,pose_x:1.7,pose_y:1.6},
      {goal:'story_corner',x:4.9,y:1.7,pose_x:4.9,pose_y:1.7},
      {goal:'dock',x:0.7,y:2.8,pose_x:0.7,pose_y:2.8},
    ].map(x => ({ ...x, verified:true, position_error_m:0, odom_distance_m:1.2, wall_seconds:10, feedback_count:3 }));
    const data = {schema:'alex.dev/ros-acceptance/v1', status:'passed', mode:'route', simulation_only:true,
      run_id:'unique-v14-run', checks:['clock_scan_odom_map_tf_nav2_ready'], legs:route};
    writeFileSync(report, JSON.stringify(data));
    const verify = id => run('python3',['scripts/verify-ros-report.py','--report',report,'--run-id',id]);
    assert.equal(verify('unique-v14-run').status,0);
    const mismatch = verify('earlier-run');
    assert.notEqual(mismatch.status,0);
    assert.match(mismatch.stderr,/ACCEPTANCE_RUN_ID_MISMATCH/);
    delete data.run_id;
    writeFileSync(report, JSON.stringify(data));
    assert.notEqual(verify('unique-v14-run').status,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('v0.14 diagnostics are non-authoritative and identify likely bootstrap failure', () => {
  const dir = mkdtempSync(join(tmpdir(),'alex-v14-diagnostics-'));
  try {
    const report=join(dir,'report.json'), preflight=join(dir,'preflight.json'), log=join(dir,'launch.log'),out=join(dir,'diagnostics.json');
    writeFileSync(report,JSON.stringify({status:'failed',reason:'CRASH',run_id:'abc',
      last_goal:{goal:'study_desk',velocity_pipeline:{'/cmd_vel':{messages:0}}}}));
    writeFileSync(preflight,JSON.stringify({status:'blocked',blockers:['package:nav2_msgs']}));
    writeFileSync(log,"Traceback: ModuleNotFoundError: No module named 'alex_sim'\nNAV2_GOAL_TIMEOUT\n[collision_monitor] Failed to get \\"lidar_link\\"->\\"base_footprint\\" frame transform: \\"base_footprint\\" passed to lookupTransform argument target_frame does not exist.\n[controller_server] Failed to make progress\n");
    const result=run('python3',['scripts/diagnose-ros-acceptance.py','--report',report,'--preflight',preflight,'--log',log,'--out',out]);
    assert.equal(result.status,0,result.stderr);
    const data=JSON.parse(readFileSync(out,'utf8'));
    assert.equal(data.acceptance_status,'failed');
    assert.equal(data.runtime_validation,'SEE_ACCEPTANCE_REPORT');
    assert.deepEqual(data.preflight_blockers,['package:nav2_msgs']);
    assert.ok(data.suspected_stages.some(stage=>stage.stage==='python_overlay'));
    assert.ok(data.suspected_stages.some(stage=>stage.stage==='nav2_action'));
    assert.ok(data.suspected_stages.some(stage=>stage.stage==='collision_monitor_tf'));
    assert.ok(data.suspected_stages.some(stage=>stage.stage==='controller_progress'));
    assert.equal(data.last_goal.velocity_pipeline['/cmd_vel'].messages,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('v0.14 blocked acceptance generates diagnostics and never retains stale success', () => {
  const dir=mkdtempSync(join(tmpdir(),'alex-v14-no-ros-'));
  try {
    const report=join(dir,'report.json'),preflight=join(dir,'preflight.json'),log=join(dir,'launch.log'),diagnostics=join(dir,'diagnostics.json');
    writeFileSync(report,JSON.stringify({status:'passed',run_id:'earlier',legs:[{verified:true}]}));
    const env={...process.env,ALEX_ROS_REPORT:report,ALEX_ROS_PREFLIGHT:preflight,ALEX_ROS_LOG:log,ALEX_ROS_DIAGNOSTICS:diagnostics};
    delete env.ALEX_RUN_ROS_INTEGRATION;
    const result=run('bash',['scripts/run-ros-acceptance.sh'],{env});
    assert.equal(result.status,2,result.stderr);
    assert.equal(JSON.parse(readFileSync(report,'utf8')).status,'blocked');
    assert.equal(JSON.parse(readFileSync(diagnostics,'utf8')).acceptance_status,'blocked');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('v0.14 runner sources overlay before starting Nav2 and smoke, and artifact workflow includes diagnostics', () => {
  const runner=readFileSync(join(root,'scripts/run-ros-acceptance.sh'),'utf8');
  const source=runner.indexOf('source "$ROOT/scripts/prepare-ros-sim.sh"');
  assert.ok(source>0 && source<runner.indexOf('setsid bash -c') && source<runner.indexOf('npm run sim:smoke'));
  assert.match(runner,/ALEX_ROS_ACCEPTANCE_RUN_ID/);
  assert.match(runner,/--run-id/);
  for(const s of ['scripts/prepare-ros-sim.sh','scripts/launch-ros-sim.sh','scripts/run-ros-acceptance.sh']){
    const r=run('bash',['-n',s]);
    assert.equal(r.status,0,`${s}: ${r.stderr}`);
  }
  const flow=readFileSync(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
  assert.match(flow,/diagnostics\.json/);
  assert.match(flow,/workflow_dispatch/);
});
