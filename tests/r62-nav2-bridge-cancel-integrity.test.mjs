import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Nav2SimulationBridge} from '../scripts/ros2-navigation.mjs';

const fixture=fileURLToPath(new URL('./fixtures/fake-nav2-client.mjs',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function bridgeFor(mode,settings={}){
 const children=[];
 const bridge=new Nav2SimulationBridge({
  simulationOnly:true,startupMs:500,goalTimeoutMs:1000,cancelGraceMs:150,
  ...settings,
  spawnProcess:(_command,_argv,options)=>{
   // 测试仅启动内置 JSONL 伪客户端；不载入 rclpy 或接入 ROS DDS。
   const child=spawn(process.execPath,[fixture],{
    stdio:options.stdio,shell:false,
    env:{...options.env,ALEX_TEST_NAV2_MODE:mode}
   });
   children.push(child);
   return child;
  }
 });
 return {bridge,children};
}

test('R62 用户取消未收到 Action ACK，必须失败而非谎报 cancelled',{timeout:5000},async()=>{
 let cancelled=false;
 const {bridge}=bridgeFor('ignore-cancel');
 const job=bridge.navigate('study_desk',{isCancelled:()=>cancelled});
 setTimeout(()=>{cancelled=true;},60);
 const result=await job;
 assert.equal(result.status,'failed');
 assert.equal(result.reason,'NAV2_CANCEL_UNCONFIRMED');
 assert.equal(bridge.active,false);
});

test('R62 用户取消有确认终态时仍保留 cancelled，不破坏旧接口',{timeout:5000},async()=>{
 let cancelled=false;
 const {bridge}=bridgeFor('hold');
 const job=bridge.navigate('study_desk',{isCancelled:()=>cancelled});
 setTimeout(()=>{cancelled=true;},65);
 const result=await job;
 assert.equal(result.status,'cancelled');
 assert.equal(result.reason,'cancelled');
 assert.equal(bridge.active,false);
});

test('R62 自动目标超时后，Nav2 确认取消仍属于失败，而不是用户取消',{timeout:5000},async()=>{
 const {bridge}=bridgeFor('hold');
 const value=await bridge.navigate('study_desk');
 assert.equal(value.status,'failed');
 assert.equal(value.reason,'NAV2_GOAL_TIMEOUT_CANCELLED');
 assert.equal(bridge.active,false);
});

test('R62 自动目标超时且取消无确认，必须保持不可确认失败',{timeout:5000},async()=>{
 const {bridge}=bridgeFor('ignore-cancel');
 const value=await bridge.navigate('study_desk');
 assert.equal(value.status,'failed');
 assert.equal(value.reason,'NAV2_CANCEL_UNCONFIRMED');
 assert.equal(bridge.active,false);
});

test('R62 用户取消时 Nav2 仍返回成功终态，绝不标成 cancelled 或 arrived',{timeout:5000},async()=>{
 let cancelled=false;
 const {bridge}=bridgeFor('success-after-cancel');
 const job=bridge.navigate('study_desk',{isCancelled:()=>cancelled});
 setTimeout(()=>{cancelled=true;},60);
 const value=await job;
 assert.equal(value.status,'failed');
 assert.equal(value.reason,'NAV2_COMPLETED_AFTER_CANCELLATION');
 assert.equal(bridge.active,false);
});

test('R62 Nav2 ACK 拒绝与 Action 终态不匹配均 fail closed',{timeout:5000},async()=>{
 for(const [mode,reason] of [
  ['cancel-rejected','NAV2_CANCEL_NOT_ACKNOWLEDGED'],
  ['cancel-terminal-mismatch','NAV2_CANCEL_TERMINAL_NOT_CANCELED']
 ]){
  let cancelled=false;
  const {bridge}=bridgeFor(mode);
  const job=bridge.navigate('study_desk',{isCancelled:()=>cancelled});
  setTimeout(()=>{cancelled=true;},60);
  const value=await job;
  assert.equal(value.status,'failed',mode);
  assert.equal(value.reason,reason,mode);
  assert.equal(bridge.active,false,mode);
 }
});

test('R62 取消故障结束后可接收下一次任务，但不会把之前错误带入新目标',{timeout:5000},async()=>{
 let mode='ignore-cancel';
 let cancelled=false;
 const {bridge}=bridgeFor(mode,{
  spawnProcess:(_command,_argv,options)=>spawn(process.execPath,[fixture],{
   stdio:options.stdio,shell:false,
   env:{...options.env,ALEX_TEST_NAV2_MODE:mode}
  })
 });
 const first=bridge.navigate('study_desk',{isCancelled:()=>cancelled});
 setTimeout(()=>{cancelled=true;},60);
 const failure=await first;
 assert.equal(failure.status,'failed');
 assert.equal(failure.reason,'NAV2_CANCEL_UNCONFIRMED');
 assert.equal(bridge.active,false);

 mode='success';
 cancelled=false;
 const phases=[];
 const success=await bridge.navigate('study_desk',{
  onFeedback:async x=>{phases.push(x.phase);}
 });
 assert.equal(success.status,'arrived');
 assert.equal(bridge.active,false);
 assert.ok(phases.includes('planning'));
 assert.ok(phases.includes('moving'));
 assert.ok(phases.includes('arrived'));
});

test('R62 已激活任务不能并发启动第二个 Nav2 Action',{timeout:5000},async()=>{
 let cancelled=false;
 const {bridge}=bridgeFor('hold');
 const first=bridge.navigate('study_desk',{isCancelled:()=>cancelled});
 await sleep(40);
 await assert.rejects(()=>bridge.navigate('story_corner'),/NAV2_BUSY/);
 cancelled=true;
 assert.equal((await first).status,'cancelled');
 assert.equal(bridge.active,false);
});

test('R62 子进程反馈处理异常导致 failed，而非假到达',{timeout:5000},async()=>{
 const {bridge}=bridgeFor('success');
 const value=await bridge.navigate('study_desk',{
  onFeedback:async({phase})=>{
   if(phase==='moving')throw Error('synthetic-feedback-failure');
  }
 });
 assert.equal(value.status,'failed');
 assert.match(value.reason,/NAV2_FEEDBACK_ERROR|synthetic-feedback-failure/);
 assert.equal(bridge.active,false);
});

test('R62 默认取消 Grace 超过 Python Action 客户端确认上限',{timeout:5000},async()=>{
 const bridge=new Nav2SimulationBridge({simulationOnly:true});
 assert.equal(bridge.cancelGraceMs,5000);
 assert.ok(bridge.cancelGraceMs>3000);
 assert.throws(()=>new Nav2SimulationBridge({simulationOnly:true,cancelGraceMs:0}),/INVALID_NAV2_TIMEOUT/);
});

test('R62 目标拒绝、位置未经证实的成功和正常到达，行为不回退',{timeout:5000},async()=>{
 for(const [mode,status,reason] of [
  ['reject','failed','rejected'],
  ['far','failed','NAV2_GOAL_POSE_NOT_VERIFIED'],
  ['success','arrived',undefined]
 ]){
  const {bridge}=bridgeFor(mode);
  const r=await bridge.navigate('study_desk');
  assert.equal(r.status,status,mode);
  assert.equal(r.reason,reason,mode);
  assert.equal(bridge.active,false,mode);
 }
});
