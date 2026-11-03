import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Nav2SimulationBridge,toNav2Goal,toGridPose} from '../scripts/ros2-navigation.mjs';
import {SIM_MAP_VERSION} from '../scripts/navigation-simulator.mjs';

const peer=fileURLToPath(new URL('./fixtures/fake-nav2-client.mjs',import.meta.url));
const fixture=(mode='success')=>{
  const {spawn}=requireSpawn();
  return new Nav2SimulationBridge({simulationOnly:true,python:process.execPath,scriptPath:peer,
    spawnProcess:(command,args,options)=>spawn(command,args,{...options,env:{...options.env,ALEX_TEST_NAV2_MODE:mode}}),
    startupMs:1000,goalTimeoutMs:2000,cancelGraceMs:500});
};
function requireSpawn(){return {spawn:importSpawn}}
import {spawn as importSpawn} from 'node:child_process';

test('v0.10 Nav2 is explicitly simulation-only; destinations convert grid cells to meters',()=>{
  assert.throws(()=>new Nav2SimulationBridge(),/ROS2_SIMULATION_ONLY_FLAG_REQUIRED/);
  assert.deepEqual(toNav2Goal('study_desk'),{destination:'study_desk',frame_id:'map',x:1.7,y:1.6,yaw:0});
  assert.deepEqual(toGridPose({x:1.7,y:1.6,yaw:0}),{x:17,y:16,heading:0});
  assert.throws(()=>toNav2Goal('secret_location'),/INVALID_SIM_DESTINATION/);
  assert.throws(()=>toGridPose({x:500,y:1,yaw:0}),/INVALID_NAV2_POSE/);
  assert.throws(()=>toGridPose({x:0.7,y:0.5,yaw:0}),/NAV2_OUTSIDE_APPROVED_GRID/);
});

test('v0.10 Nav2 action feedback produces v2 ordered telemetry and verified arrival',async()=>{
  const nav=fixture(),frames=[];
  const result=await nav.navigate('study_desk',{onFeedback:async f=>frames.push(f)});
  assert.equal(result.status,'arrived');
  assert.deepEqual(frames.map(f=>f.sequence),[1,2,3]);
  assert.deepEqual(frames.map(f=>f.phase),['planning','moving','arrived']);
  assert.deepEqual(frames.map(f=>f.mapVersion),[SIM_MAP_VERSION,SIM_MAP_VERSION,SIM_MAP_VERSION]);
  assert.equal(frames.at(-1).progress,100);
  assert.deepEqual(frames.at(-1).pose,{x:17,y:16,heading:0});
});

test('v0.10 Nav2 cannot fabricate arrival when Nav2 reports success far from goal',async()=>{
  const nav=fixture('far'),frames=[];
  const result=await nav.navigate('study_desk',{onFeedback:async f=>frames.push(f)});
  assert.equal(result.status,'failed');
  assert.equal(result.reason,'NAV2_GOAL_POSE_NOT_VERIFIED');
  assert.ok(!frames.some(f=>f.phase==='arrived'));
});

test('v0.10 Nav2 rejected goal never becomes success',async()=>{
  const result=await fixture('reject').navigate('study_desk');
  assert.equal(result.status,'failed');
});

test('v0.10 cancellation is sent to action peer; no arrived result',async()=>{
  const nav=fixture('hold'),frames=[];
  let cancel=false;
  setTimeout(()=>{cancel=true},100);
  const result=await nav.navigate('story_corner',{onFeedback:async f=>frames.push(f),isCancelled:()=>cancel});
  assert.equal(result.status,'cancelled');
  assert.ok(!frames.some(f=>f.phase==='arrived'));
});

test('v0.10 Nav2 bridge rejects concurrent navigation goals',async()=>{
  const nav=fixture('hold');let cancel=false;
  const first=nav.navigate('study_desk',{isCancelled:()=>cancel});
  await assert.rejects(()=>nav.navigate('story_corner'),/NAV2_BUSY/);
  cancel=true;
  assert.equal((await first).status,'cancelled');
});
