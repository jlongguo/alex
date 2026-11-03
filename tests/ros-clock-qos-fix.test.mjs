import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..');
const script = readFileSync(join(root,'robotics/ros2/alex_sim/scripts/ros_smoke.py'),'utf8');

function probeWith(fake) {
  const temp=mkdtempSync(join(tmpdir(),'alex-gz-qos-'));
  const gz=join(temp,'gz'), report=join(temp,'report.json');
  writeFileSync(gz, '#!/bin/sh\n' + fake + '\n'); chmodSync(gz,0o755);
  try {
    const r=spawnSync('python3',[join(root,'scripts/probe-gz-transport.py'),'--out',report],
       {cwd:root,encoding:'utf8',timeout:15000,env:{...process.env, PATH:temp+':'+process.env.PATH}});
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(readFileSync(report,'utf8'));
  } finally {rmSync(temp,{recursive:true,force:true});}
}

test('acceptance /clock subscription explicitly requests BEST_EFFORT, not default RELIABLE',()=>{
  assert.match(script,/clock_qos\s*=\s*QoSProfile\(depth=10, reliability=ReliabilityPolicy\.BEST_EFFORT/);
  assert.match(script,/create_subscription\(Clock, '\/clock', clock_received, clock_qos\)/);
  assert.doesNotMatch(script,/create_subscription\(Clock, '\/clock', clock_received, 10\)/);
  assert.match(script,/create_subscription\(Odometry, '\/odom', received\('odom', latest_odom\), qos_profile_sensor_data\)/);
  assert.match(script,/verify_graph\(/);
  assert.match(script,/summarize_leg\(/);
});

test('probe does not claim world missing when Gazebo CLI fails',()=>{
  const r=probeWith('if [ "$1 $2" = "service --list" ]; then echo "failed to connect" >&2; exit 1; fi\nif [ "$1 $2" = "topic --list" ]; then echo /clock; exit 0; fi\nexit 1');
  assert.equal(r.world_control_available,null);
  assert.equal(r.services_status,'error');
  assert.match(r.services_stderr,/failed to connect/);
  assert.match(r.hint,/unverified/);
});

test('probe falls back to root /clock and uses Harmonic echo flags',()=>{
  const r=probeWith('if [ "$1 $2" = "service --list" ]; then echo /world/alex_home/control; exit 0; fi\nif [ "$1 $2" = "topic --list" ]; then printf "/clock\n/odom\n/scan\n"; exit 0; fi\nif [ "$1 $2 $3 $4" = "topic -e -t /clock" ]; then echo "sec: 10"; exit 0; fi\nexit 1');
  assert.equal(r.world_control_available,true);
  assert.equal(r.samples.clock.topic,'/clock');
  assert.equal(r.samples.clock.message_received,true);
});

test('missing service when discovery succeeds is distinct from unknown',()=>{
  const r=probeWith('if [ "$1 $2" = "service --list" ]; then echo /other/control; exit 0; fi\nif [ "$1 $2" = "topic --list" ]; then echo /clock; exit 0; fi\nexit 1');
  assert.equal(r.world_control_available,false);
  assert.match(r.hint,/service absent/);
});
