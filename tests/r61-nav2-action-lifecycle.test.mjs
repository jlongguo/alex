import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const fixture=join(root,'tests/fixtures/mock-ros2-nav2-action.py');
const client=join(root,'robotics/ros2/nav2_action_client.py');

function execute(scenario){
 const p=spawnSync('python3',[fixture,scenario],{
  cwd:root,encoding:'utf8',timeout:5000,
  env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}
 });
 assert.equal(p.error?.code,undefined,'离线 Action 契约子进程超时或无法启动');
 const frames=p.stdout.trim().split('\n').filter(Boolean).map(line=>{
  try{return JSON.parse(line);}
  catch(e){throw Error('NON_JSON_ACTION_OUTPUT: '+line.slice(0,100));}
 });
 const terminal=frames.filter(x=>x.type==='result');
 assert.equal(terminal.length,1,scenario+' must produce one terminal result: '+p.stdout+' / '+p.stderr);
 return {exit:p.status,frames,result:terminal[0],stderr:p.stderr};
}

const cases=[
 // 场景、预计终态、原因码、退出码。纯 Python mock，不进入实际 ROS DDS 域。
 ['success','succeeded',null,0],
 ['goal_rejected','rejected','NAV2_GOAL_REJECTED',1],
 ['action_failed','failed','NAV2_ACTION_FAILED',2],
 ['clock_missing','failed','SIMULATION_CLOCK_MISSING',2],
 ['action_missing','failed','NAV2_ACTION_UNAVAILABLE',2],
 ['goal_stall','failed','NAV2_GOAL_SUBMISSION_UNCONFIRMED',2],
 ['ros_disconnected','failed','NAV2_DISCONNECTED',2],
 ['cancel_early','cancelled','NAV2_CANCEL_BEFORE_GOAL',1],
 ['cancel_pending','cancelled',null,0],
 ['cancel_happy','cancelled',null,0],
 ['cancel_ack_rejected','failed','NAV2_CANCEL_NOT_ACKNOWLEDGED',2],
 ['cancel_ack_stall','failed','NAV2_CANCEL_UNCONFIRMED',2],
 ['cancel_ack_after_terminal','failed','NAV2_CANCEL_UNCONFIRMED',2],
 ['result_before_ack_reject','failed','NAV2_CANCEL_NOT_ACKNOWLEDGED',2],
 ['late_success','failed','NAV2_CANCEL_TERMINAL_NOT_CANCELED',2],
 ['result_stall','failed','NAV2_GOAL_TIMEOUT_CANCELLED',2],
];

for(const [scenario,status,reason,exit] of cases){
 test('R61 Action 生命周期故障契约：'+scenario,{timeout:6500},()=>{
  const observed=execute(scenario);
  assert.equal(observed.exit,exit,scenario+' '+observed.stderr);
  assert.equal(observed.result.status,status,scenario);
  if(reason===null){
   assert.equal(observed.result.reason,undefined,scenario);
  }else{
   assert.equal(observed.result.reason,reason,scenario);
  }
  assert.ok(!observed.stderr.includes('Traceback'),scenario);
  if(scenario==='goal_stall'||scenario==='cancel_ack_stall'){
   assert.ok(observed.frames.some(x=>x.type==='ready'),scenario);
  }
  if(scenario==='cancel_early'){
   assert.ok(!observed.frames.some(x=>x.type==='ready'),
    '发出 Nav2 Action 前取消，不允许对上层宣称已准备提交');
  }
 });
}

test('R61 直接脚本必须拒绝非隔离 DDS 域，且不传输 ROS Action',{timeout:6500},()=>{
 const result=execute('wrong_domain');
 assert.equal(result.exit,88);
 assert.equal(result.result.status,'exception');
 assert.equal(result.result.reason,'RuntimeError');
 assert.ok(!result.frames.some(x=>x.type==='ready'));
});

test('R61 布尔值坐标不应当因为 Python bool 派生自 int 被接受',{timeout:6500},()=>{
 const result=execute('bool_goal');
 assert.equal(result.exit,88);
 assert.equal(result.result.status,'exception');
 assert.equal(result.result.reason,'ValueError');
 assert.ok(!result.frames.some(x=>x.type==='ready'));
});

test('R61 所有关键等待均有界，取消必须同时验证 ACK 与最终 CANCELED',{timeout:6500},()=>{
 const source=readFileSync(client,'utf8');
 assert.match(source,/GOAL_RESPONSE_WAIT_SECONDS\s*=\s*8\.0/);
 assert.match(source,/GOAL_RESULT_WAIT_SECONDS\s*=\s*75\.0/);
 assert.match(source,/CANCEL_CONFIRM_WAIT_SECONDS\s*=\s*3\.0/);
 assert.match(source,/NAV2_GOAL_SUBMISSION_UNCONFIRMED/);
 assert.match(source,/NAV2_CANCEL_NOT_ACKNOWLEDGED/);
 assert.match(source,/NAV2_CANCEL_TERMINAL_NOT_CANCELED/);
 assert.match(source,/NAV2_COMPLETED_AFTER_CANCELLATION/);
 assert.match(source,/goal_handle\.cancel_goal_async\(\)/);
 assert.match(source,/GoalStatus\.STATUS_CANCELED/);
 const p=spawnSync('python3',['-c',
  'from pathlib import Path; import sys; compile(Path(sys.argv[1]).read_text(),sys.argv[1],"exec")',
  client],{encoding:'utf8',timeout:3000});
 assert.equal(p.status,0,p.stderr);
});
