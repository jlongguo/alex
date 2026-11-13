// v0.10: EXPERIMENTAL Nav2 action adapter for simulation only.
// Uses a child rclpy action client. No GPIO, Twist, or motor transport is implemented.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MAP, occupied} from '../dist/robot/map.js';
import {SIM_DESTINATIONS,SIM_MAP_VERSION,initialPose} from './navigation-simulator.mjs';

const DEFAULT_SCRIPT=fileURLToPath(new URL('../robotics/ros2/nav2_action_client.py',import.meta.url));
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const between=(n,lo,hi)=>finite(n)&&n>=lo&&n<=hi;
const targetFor=name=>MAP.destinations[name];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const round=n=>Math.round(n*10000)/10000;

// 这些结果不能证明 Nav2 目标已经结束；同一桥实例禁止继续提交新目标。
const UNCERTAIN_STOP_REASONS=new Set([
  'NAV2_CANCEL_UNCONFIRMED','NAV2_CANCEL_NOT_ACKNOWLEDGED',
  'NAV2_CANCEL_TERMINAL_NOT_CANCELED','NAV2_COMPLETED_AFTER_CANCELLATION',
  'NAV2_GOAL_SUBMISSION_UNCONFIRMED','NAV2_DISCONNECTED',
  'NAV2_PROCESS_EXIT','NAV2_STARTUP_TIMEOUT','NAV2_PROTOCOL_OVERFLOW',
  'NAV2_PROTOCOL_FRAME_TOO_LARGE','INVALID_NAV2_JSON','INVALID_NAV2_FEEDBACK',
  'NAV2_OUTSIDE_APPROVED_GRID'
]);

/** Convert the *fictional* 0.1m grid to a ROS map simulation configured to match it. */
export function toNav2Goal(destination){
  if(!SIM_DESTINATIONS.includes(destination))throw new Error('INVALID_SIM_DESTINATION');
  const cell=targetFor(destination);
  return Object.freeze({destination,frame_id:'map',x:round(cell.x*MAP.cellMeters),y:round(cell.y*MAP.cellMeters),yaw:0});
}
export function toGridPose(p){
  if(!p||!between(p.x,-100,100)||!between(p.y,-100,100)||!between(p.yaw,-Math.PI,Math.PI))throw new Error('INVALID_NAV2_POSE');
  const pose={x:round(p.x/MAP.cellMeters),y:round(p.y/MAP.cellMeters),heading:round(p.yaw)};
  if(occupied(pose.x,pose.y))throw new Error('NAV2_OUTSIDE_APPROVED_GRID');
  return pose;
}

export class Nav2SimulationBridge {
  constructor({simulationOnly=false,python='python3',scriptPath=DEFAULT_SCRIPT,spawnProcess=spawn,
    startupMs=10000,goalTimeoutMs=55000,cancelGraceMs=5000}={}){
    if(simulationOnly!==true)throw new Error('ROS2_SIMULATION_ONLY_FLAG_REQUIRED');
    if(!between(startupMs,500,30000)||!between(goalTimeoutMs,1000,300000)||!between(cancelGraceMs,100,10000))throw new Error('INVALID_NAV2_TIMEOUT');
    this.python=python;this.scriptPath=scriptPath;this.spawnProcess=spawnProcess;
    this.startupMs=startupMs;this.goalTimeoutMs=goalTimeoutMs;this.cancelGraceMs=cancelGraceMs;
    this.pose=initialPose();this.active=false;this.stopUnconfirmed=false;
  }
  async navigate(destination,{onFeedback=async()=>{},isCancelled=()=>false}={}){
    if(this.active)throw new Error('NAV2_BUSY');
    // 未确认前一个 Nav2 目标已终止，不能允许新任务覆盖潜在运行中的目标。
    if(this.stopUnconfirmed)throw new Error('NAV2_STOP_UNCONFIRMED');
    const goal=toNav2Goal(destination),target=targetFor(destination);
    if(isCancelled())return {status:'cancelled',pose:{...this.pose}};
    this.active=true;
    let child,buffer='',settled=false,seq=0,started=false,cancelSent=false,cancelCause=null,lastPose=null,lastProgress=0;
    let resolveFinal;const done=new Promise(resolve=>resolveFinal=resolve);
    const finish=(status,reason)=>{
      if(settled)return;
      if(status==='failed'&&(UNCERTAIN_STOP_REASONS.has(reason)
        ||(typeof reason==='string'&&(
          reason.startsWith('NAV2_PROCESS_ERROR:')||
          reason.startsWith('NAV2_FEEDBACK_ERROR:')
        ))))this.stopUnconfirmed=true;
      settled=true;
      resolveFinal({status,pose:{...this.pose},...(reason?{reason}:{})});
    };
    const write=obj=>{try{if(child?.stdin?.writable)child.stdin.write(JSON.stringify(obj)+'\n');}catch{}};
    // Feedback is delivered in order; terminal results wait for prior onFeedback writes.
    let feedbackSerial=Promise.resolve();
    const emit=f=>{feedbackSerial=feedbackSerial.then(()=>onFeedback({...f,sequence:++seq,mapVersion:SIM_MAP_VERSION}));feedbackSerial.catch(e=>finish('failed',`NAV2_FEEDBACK_ERROR: ${e.message}`));};
    const receive=msg=>{
      if(settled||!msg||typeof msg!=='object')return;
      if(msg.type==='ready'){started=true;return;}
      if(msg.type==='feedback'){
        if(!started||!between(msg.distance_remaining,0,1000))return finish('failed','INVALID_NAV2_FEEDBACK');
        let pose;try{pose=toGridPose(msg.pose);}catch(e){return finish('failed',e.message)}
        this.pose=pose;lastPose=pose;
        const initial=Math.max(1,Math.hypot(initialPose().x-target.x,initialPose().y-target.y)*MAP.cellMeters);
        lastProgress=Math.max(lastProgress,Math.min(99,Math.floor((1-msg.distance_remaining/initial)*100)));
        emit({phase:'moving',progress:lastProgress,pose:{...pose}});return;
      }
      if(msg.type==='result'){
        if(!['succeeded','failed','cancelled','rejected'].includes(msg.status))return finish('failed','INVALID_NAV2_RESULT');
        if(msg.status==='succeeded'){
          // 成功终态与取消请求竞争时，既非“到达”，也非“取消已确认”。
          if(cancelSent||isCancelled())return finish('failed','NAV2_COMPLETED_AFTER_CANCELLATION');
          // Never invent a final location: a successful action alone is not proof of arrival.
          if(!lastPose||Math.hypot(lastPose.x-target.x,lastPose.y-target.y)>0.5)return finish('failed','NAV2_GOAL_POSE_NOT_VERIFIED');
          emit({phase:'arrived',progress:100,pose:{...lastPose}});
          feedbackSerial.then(()=>finish('arrived'),e=>finish('failed',e.message));
        }else if(msg.status==='cancelled'&&cancelCause==='timeout'){
          // 目标超时属于失败，即使 Python 已确认取消也不得归为用户主动取消。
          finish('failed','NAV2_GOAL_TIMEOUT_CANCELLED');
        }else finish(msg.status==='cancelled'?'cancelled':'failed',String(msg.reason??msg.status).slice(0,120));
      }
    };
    try{
      child=this.spawnProcess(this.python,[this.scriptPath,'--ros-args','-p','use_sim_time:=true'],{
        stdio:['pipe','pipe','pipe'],env:{...process.env,ALEX_ROS_SIMULATION_ONLY:'1'},shell:false
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data',data=>{
        buffer+=data;if(buffer.length>32000)return finish('failed','NAV2_PROTOCOL_OVERFLOW');
        let ix;while((ix=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,ix);buffer=buffer.slice(ix+1);
          if(!line.trim())continue;if(line.length>4096)return finish('failed','NAV2_PROTOCOL_FRAME_TOO_LARGE');
          try{receive(JSON.parse(line));}catch{finish('failed','INVALID_NAV2_JSON');}
        }
      });
      child.on('error',err=>finish('failed',`NAV2_PROCESS_ERROR: ${err.code??'UNKNOWN'}`));
      child.on('exit',()=>finish('failed','NAV2_PROCESS_EXIT'));
      emit({phase:'planning',progress:0,pose:{...this.pose}});
      write({type:'navigate',goal});
      const start=Date.now();let cancelAt=0;
      while(!settled){
        const elapsed=Date.now()-start;
        if(!cancelSent){
          const requestedByUser=isCancelled();
          if(requestedByUser||elapsed>this.goalTimeoutMs){
            cancelSent=true;cancelCause=requestedByUser?'user':'timeout';
            cancelAt=Date.now();write({type:'cancel'});
          }
        }
        if(!started&&elapsed>this.startupMs)finish('failed','NAV2_STARTUP_TIMEOUT');
        // 取消 ACK/终态无证据时必须失败；不能为了响应用户取消而谎报已停止。
        if(cancelSent&&Date.now()-cancelAt>this.cancelGraceMs)finish('failed','NAV2_CANCEL_UNCONFIRMED');
        if(!settled)await Promise.race([done,delay(25)]);
      }
      await feedbackSerial.catch(()=>{});
      return await done;
    }finally{
      this.active=false;
      if(child&&!child.killed){child.kill('SIGTERM');}
    }
  }
}
