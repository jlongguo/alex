import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const pkg=join(root,'robotics/ros2/alex_sim/alex_sim');
const smoke=readFileSync(join(root,'robotics/ros2/alex_sim/scripts/ros_smoke.py'),'utf8');

function verify(lines) {
 const program=['import sys','from types import SimpleNamespace as NS','sys.path.insert(0,'+JSON.stringify(pkg)+')','from nav2_lifecycle import Nav2LifecycleGate',...lines].join('\n');
 const p=spawnSync('python3',['-c',program],{cwd:root,encoding:'utf8',timeout:10000});
 assert.equal(p.status,0,p.stderr);
}

test('Nav2 lifecycle gate refuses advertised action while configuring, accepts only ACTIVE',()=>{
 verify([
  'class F:',
  '    def __init__(self,id): self.id=id',
  '    def done(self): return True',
  "    def result(self): return NS(current_state=NS(id=self.id,label={2:'inactive',3:'active'}[self.id]))",
  'g=Nav2LifecycleGate()',
  'assert not g.poll(now=0,service_ready=True,action_ready=True,request_state=lambda:F(2))',
  'assert not g.poll(now=.1,service_ready=True,action_ready=True,request_state=lambda:F(3))',
  'assert not g.poll(now=.6,service_ready=True,action_ready=True,request_state=lambda:F(3))',
  'assert g.poll(now=.7,service_ready=True,action_ready=True,request_state=lambda:F(3))',
  "assert g.snapshot()['state_label']=='active'",
  "assert g.snapshot()['active_responses']==1",
 ]);
});

test('ACTIVE lifecycle without available action still refuses goal',()=>{
 verify([
  'class F:',
  '    def done(self): return True',
  "    def result(self): return NS(current_state=NS(id=3,label='active'))",
  'g=Nav2LifecycleGate()',
  'assert not g.poll(now=0,service_ready=True,action_ready=False,request_state=F)',
  'assert not g.poll(now=.1,service_ready=True,action_ready=False,request_state=F)',
  "assert g.snapshot()['state_id']==3",
  'assert not g.poll(now=.6,service_ready=True,action_ready=True,request_state=F)',
  'assert g.poll(now=.7,service_ready=True,action_ready=True,request_state=F)'
 ]);
});

test('unavailable or timed-out lifecycle cannot masquerade as ACTIVE',()=>{
 verify([
  'class F:',
  '    def __init__(self): self.cancelled=False',
  '    def done(self): return False',
  '    def cancel(self): self.cancelled=True',
  'f=F()',
  'g=Nav2LifecycleGate(response_timeout=1)',
  'assert not g.poll(now=0,service_ready=False,action_ready=True,request_state=lambda:None)',
  'assert not g.poll(now=1,service_ready=True,action_ready=True,request_state=lambda:f)',
  'assert not g.poll(now=1.5,service_ready=True,action_ready=True,request_state=lambda:None)',
  'assert not g.poll(now=2.5,service_ready=False,action_ready=True,request_state=lambda:None)',
  'assert f.cancelled',
  "assert g.snapshot()['last_error']=='GET_STATE_RESPONSE_TIMEOUT'"
 ]);
});

test('ROS smoke checks lifecycle ACTIVE before each goal, keeps strict feedback and TF verification',()=>{
 assert.match(smoke,/create_client\(GetState, '\/bt_navigator\/get_state'\)/);
 assert.match(smoke,/spin_until\(navigator_is_active, min\(args.timeout, 120\)/);
 const goal=smoke.slice(smoke.indexOf('    def run_goal(goal):'));
 assert.ok(goal.indexOf('require_active_navigator()')>=0);
 assert.ok(goal.indexOf('require_active_navigator()')<goal.indexOf('send_goal_async('));
 assert.match(smoke,/NAV2_LIFECYCLE_ACTIVE/);
 assert.match(smoke,/NAV2_GOAL_REJECTED/);
 assert.match(smoke,/summarize_leg\(goal, pose/);
 assert.match(smoke,/clock_scan_odom_map_tf_nav2_ready/);
});
