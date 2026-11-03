import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
function simulate(script) {
  const dir=mkdtempSync(join(tmpdir(),'alex-gz-transport-'));
  const cmd=join(dir,'gz'),report=join(dir,'report.json');
  writeFileSync(cmd,'#!/bin/sh\n'+script+'\n');chmodSync(cmd,0o755);
  try {
    const r=spawnSync('python3',['scripts/probe-gz-transport.py','--out',report],{
      cwd:root,encoding:'utf8',timeout:12000,env:{...process.env,PATH:dir+':'+process.env.PATH}
    });
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(readFileSync(report,'utf8'));
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('Advertised Gazebo topics are NOT treated as published samples',()=>{
  const v=simulate('if [ "$1 $2" = "topic --list" ]; then printf "/world/alex_home/clock\\n/odom\\n/scan\\n"; elif [ "$1 $2" = "service --list" ]; then echo /world/alex_home/control; else exit 1; fi');
  assert.equal(v.world_control_available,true);
  assert.equal(v.samples.clock.advertised,true);
  assert.equal(v.samples.clock.message_received,false);
  assert.match(v.hint,/clock has no sample/);
});
test('A paused Gazebo world is separately diagnosed',()=>{
  const v=simulate('if [ "$1 $2" = "topic --list" ]; then printf "/world/alex_home/stats\\n/world/alex_home/clock\\n"; elif [ "$1 $2" = "service --list" ]; then echo /world/alex_home/control; elif [ "$4" = "/world/alex_home/stats" ]; then echo "paused: true"; else echo "sec: 1"; fi');
  assert.equal(v.world_paused,true);
  assert.match(v.hint,/paused/);
});
test('World service absence distinguishes Gazebo startup failure',()=>{
  const v=simulate('if [ "$1 $2" = "topic --list" ]; then echo /clock; fi');
  assert.equal(v.world_control_available,false);
  assert.match(v.hint,/world service missing/);
});
test('Launcher preserves fail-closed acceptance and adds root-cause evidence',()=>{
  const run=readFileSync(join(root,'scripts/run-ros-acceptance.sh'),'utf8');
  const docker=readFileSync(join(root,'scripts/docker-sim.sh'),'utf8');
  const cfg=readFileSync(join(root,'robotics/ros2/alex_sim/config/bridge.yaml'),'utf8');
  assert.match(run,/probe-gz-transport\.py/);
  assert.match(run,/head -n 100 "\$log"/);
  assert.match(run,/tail -n 90 "\$log"/);
  assert.match(run,/exit "\$smoke_status"/);
  assert.match(docker,/gz-transport\.json/);
  assert.match(cfg,/gz_topic_name: \/world\/alex_home\/clock[\s\S]*?qos_profile: CLOCK/);
});
