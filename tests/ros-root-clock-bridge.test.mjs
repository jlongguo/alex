import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');

function mockGazebo(script){
 const dir=mkdtempSync(join(tmpdir(),'alex-rootclock-'));
 const gz=join(dir,'gz'),out=join(dir,'report.json');
 writeFileSync(gz,'#!/bin/sh\n'+script+'\n');chmodSync(gz,0o755);
 try {
  const r=spawnSync('python3',['scripts/probe-gz-transport.py','--out',out],{
   cwd:root,encoding:'utf8',timeout:12000,env:{...process.env,PATH:dir+':'+process.env.PATH}
  });
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(readFileSync(out,'utf8'));
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('Gazebo root clock bridge aligns with actual clock source and ROS CLOCK QoS',()=>{
 const cfg=readFileSync(join(root,'robotics/ros2/alex_sim/config/bridge.yaml'),'utf8');
 assert.match(cfg,/ros_topic_name: \/clock[\s\S]*?gz_topic_name: \/clock[\s\S]*?qos_profile: CLOCK/);
 assert.doesNotMatch(cfg,/gz_topic_name: \/world\/alex_home\/clock/);
});
test('direct Gazebo root clock samples are detected despite empty topic discovery',()=>{
 const report=mockGazebo('if [ "$1 $2" = "topic --list" ]; then exit 0; fi\nif [ "$1 $2" = "service --list" ]; then echo /world/alex_home/control; exit 0; fi\nif [ "$1 $2 $3 $4" = "topic -e -t /clock" ]; then echo "sim { sec: 1 }"; exit 0; fi\nif [ "$1 $2 $3 $4" = "topic -e -t /odom" ]; then echo "pose { position { x: 1 } }"; exit 0; fi\nexit 1');
 assert.deepEqual(report.topics,[]);
 assert.equal(report.samples.clock.message_received,true);
 assert.equal(report.samples.clock.topic,'/clock');
 assert.equal(report.samples.odom.message_received,true);
 assert.equal(report.samples.clock.advertised,false);
});
test('missing Gazebo scan remains a diagnosis, never navigation success',()=>{
 const report=mockGazebo('if [ "$1 $2" = "topic --list" ]; then exit 0; fi\nif [ "$1 $2" = "service --list" ]; then echo /world/alex_home/control; exit 0; fi\ncase "$4" in /clock|/odom) echo "tick: 1";; esac');
 assert.match(report.hint,/scan absent/);
 assert.equal(report.samples.scan.message_received,false);
});
