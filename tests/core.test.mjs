import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeCore, MAP, occupied, findPath, parseIntent, SimulatedRobot } from '../dist/index.js';

const nav=(core, destination, actor='parent')=>core.navigate({actor,capability:destination==='dock'?'navigation.dock':'navigation.goto',params:{destination}});

test('P0: robot capabilities and installed skills are registered',()=>{
  const home=new HomeCore();
  assert.equal(home.listDevices().length,1);
  assert.ok(home.listDevices()[0].capabilities.includes('navigation.goto'));
  assert.deepEqual(home.skills.list().map(s=>s.id),['learning.english','story.interactive','quiz.science','home.status']);
});

test('P0: all named map destinations have routes from dock and no unsafe cells',()=>{
  const dock=MAP.destinations.dock;
  for(const [name,target] of Object.entries(MAP.destinations)){
    const path=findPath(dock,target);
    assert.ok(path.length>0,`No route to ${name}`);
    for(const p of path)assert.equal(occupied(p.x,p.y),false,`${name} route hits obstacle at ${p.x},${p.y}`);
    assert.deepEqual(path.at(-1),target);
  }
});

test('P1: deterministic intent router does not pretend to be a model',()=>{
  assert.deepEqual(parseIntent('请去书桌'),{type:'navigate',destination:'study_desk'});
  assert.deepEqual(parseIntent('讲个故事'),{type:'skill',id:'story.interactive'});
  assert.deepEqual(parseIntent('紧急停止'),{type:'stop'});
  assert.deepEqual(parseIntent('帮我预测明天彩票'),{type:'unknown'});
});

test('P2: navigation completes, task state and events are consistent',()=>{
  const home=new HomeCore();
  const result=nav(home,'study_desk');
  assert.equal(result.ok,true);
  assert.equal(result.task.status,'running');
  for(let i=0;i<400&&!home.state().tasks[0].status.startsWith('suc');i++)home.tick(0.4);
  assert.equal(home.state().tasks[0].status,'succeeded');
  assert.equal(home.state().tasks[0].progress,100);
  assert.equal(home.state().activeTaskId,null);
  assert.ok(Math.hypot(home.state().robot.x-17,home.state().robot.y-16)<.001);
  assert.ok(home.state().events.some(e=>e.type==='task.updated'&&e.message.includes('Arrived')));
});

test('P2: command replacement cancels former task only if new command is valid',()=>{
  const home=new HomeCore();
  nav(home,'story_corner');
  const id=home.state().activeTaskId;
  assert.throws(()=>nav(home,'invalid'),/INVALID_DESTINATION/);
  assert.equal(home.state().activeTaskId,id);
  const next=nav(home,'sofa');
  assert.equal(next.ok,true);
  const old=home.state().tasks.find(t=>t.id===id);
  assert.equal(old.status,'cancelled');
  assert.equal(old.reason,'Superseded by a new command');
});

test('P2: obstacle insertion stops a moving robot and marks task stopped',()=>{
  const home=new HomeCore();
  nav(home,'story_corner');
  home.tick(0.4);
  assert.equal(home.setObstacle(true,'parent').ok,true);
  assert.equal(home.state().robot.movement,'stopped');
  assert.equal(home.state().tasks[0].status,'stopped');
  assert.equal(home.state().activeTaskId,null);
  assert.equal(home.setObstacle(false,'parent').ok,true);
});

test('P2: emergency stop latches, child cannot clear it and cannot move while latched',()=>{
  const home=new HomeCore();
  nav(home,'study_desk');
  assert.equal(home.emergencyStop('child').ok,true);
  assert.equal(home.state().robot.emergencyStopped,true);
  assert.equal(home.state().tasks[0].status,'stopped');
  assert.equal(home.resetEmergencyStop('child').ok,false);
  assert.equal(nav(home,'study_desk','parent').ok,false);
  assert.equal(home.resetEmergencyStop('parent').ok,true);
  assert.equal(nav(home,'study_desk','parent').ok,true);
});

test('P1: child permissions deny docking and privileged skill invocation',()=>{
  const home=new HomeCore();
  assert.equal(nav(home,'dock','child').ok,false);
  assert.equal(home.invokeSkill('home.status','child').ok,false);
  assert.equal(home.invokeSkill('learning.english','child').ok,true);
  assert.equal(home.invokeSkill('story.interactive','child').ok,true);
  assert.equal(home.invokeSkill('home.status','parent').ok,true);
});

test('P2: child may invoke emergency stop but not modify simulated environment',()=>{
  const home=new HomeCore();
  assert.equal(home.setObstacle(true,'child').ok,false);
  assert.equal(home.state().robot.obstaclePresent,false);
  assert.equal(home.emergencyStop('child').ok,true);
});

test('P2: invalid speeds and disconnected robot cannot move',()=>{
  const robot=new SimulatedRobot();
  assert.throws(()=>robot.navigate('sofa',999),/INVALID_SPEED/);
  robot.setOnline(false);
  assert.throws(()=>robot.navigate('sofa'),/DEVICE_OFFLINE/);
});

test('P1: event stream publishes structured task events',()=>{
  const home=new HomeCore();
  const events=[];
  const unsub=home.subscribe(e=>events.push(e));
  nav(home,'sofa');
  assert.ok(events.some(e=>e.type==='task.updated'));
  unsub();
  const n=events.length;
  home.emergencyStop('parent');
  assert.equal(events.length,n);
});
