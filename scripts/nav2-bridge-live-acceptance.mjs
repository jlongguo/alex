#!/usr/bin/env node
// R63：真实 Node -> Python rclpy -> Nav2 Action 桥验收。
// 仅允许隔离 Gazebo/ROS Jazzy 仿真；不发送 Twist/GPIO，也不连接实体机器人。
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Nav2SimulationBridge} from './ros2-navigation.mjs';

const SCHEMA='alex.dev/nav2-bridge-live-acceptance/v1';
const MODE='bridge-probe';
const SOURCE='node-python-nav2-live';
const REQUIRED_CHECKS=[
  'node_bridge_study_desk_arrived',
  'node_bridge_dock_arrived',
  'node_bridge_feedback_observed',
  'node_bridge_same_instance_reused'
];
const GOALS=['study_desk','dock'];
const safeRunId=value=>typeof value==='string'
  &&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safeReason=value=>{
  const code=String(value??'').split(':',1)[0].trim();
  if(/^[A-Z][A-Z0-9_]{2,79}$/.test(code))return code;
  if(code==='rejected')return 'NAV2_GOAL_REJECTED';
  return 'NAV2_BRIDGE_RUNTIME_FAILED';
};
const now=()=>new Date().toISOString();

async function atomicWrite(path,data){
  const target=resolve(path);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temporary=target+'.tmp';
  await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{mode:0o600});
  await rename(temporary,target);
}
async function readObject(path){
  const raw=await readFile(resolve(path),'utf8');
  if(raw.length>192*1024)throw Error('NAV2_BRIDGE_REPORT_TOO_LARGE');
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw Error('NAV2_BRIDGE_REPORT_INVALID');
  return value;
}
function baseReport(runId,status,reason){
  return {
    schema:SCHEMA,mode:MODE,status,source:SOURCE,
    simulation_only:true,physical_safety_certified:false,release_approved:false,
    runtime_chain:'node->python-rclpy->nav2-action',
    independent_tf_verified:false,
    run_id:runId,reason,
    created_at:now(),updated_at:now(),
    checks:[],legs:[],
    bridge:{active:false,stop_unconfirmed:false,final_pose:null}
  };
}
export async function resetReport(path,{makeRunId=randomUUID}={}){
  const runId=makeRunId();
  if(!safeRunId(runId))throw Error('NAV2_BRIDGE_INVALID_RUN_ID');
  const report=baseReport(runId,'blocked','PREFLIGHT_PENDING');
  await atomicWrite(path,report);
  return report;
}
export async function failReport(path,reason='ACCEPTANCE_EXITED_BEFORE_RESULT'){
  let report;
  try{report=await readObject(path);}catch{return false;}
  if(report.schema!==SCHEMA||report.mode!==MODE||report.status!=='running'
    ||!safeRunId(report.run_id))return false;
  report.status='failed';
  report.reason=safeReason(reason);
  report.updated_at=now();
  await atomicWrite(path,report);
  return true;
}
function requireLiveEnvironment(){
  if(process.env.ALEX_ROS_SIMULATION_ONLY!=='1'
    ||process.env.ALEX_RUN_ROS_INTEGRATION!=='1')
    throw Error('NAV2_BRIDGE_SIMULATION_FLAGS_REQUIRED');
  if(process.env.ROS_DISTRO!=='jazzy'
    ||process.env.ROS_DOMAIN_ID!=='77'
    ||process.env.ROS_AUTOMATIC_DISCOVERY_RANGE!=='LOCALHOST')
    throw Error('NAV2_BRIDGE_ISOLATED_JAZZY_DOMAIN_REQUIRED');
}
const finite=n=>typeof n==='number'&&Number.isFinite(n);
function sanitizePose(pose){
  if(!pose||!finite(pose.x)||!finite(pose.y)||!finite(pose.heading))
    throw Error('NAV2_BRIDGE_INVALID_FINAL_POSE');
  return {
    x:Math.round(pose.x*10000)/10000,
    y:Math.round(pose.y*10000)/10000,
    heading:Math.round(pose.heading*10000)/10000
  };
}
async function runLeg(bridge,goal){
  const feedback=[];
  const started=Date.now();
  const outcome=await bridge.navigate(goal,{
    onFeedback:async event=>{
      if(!event||typeof event!=='object')throw Error('NAV2_BRIDGE_INVALID_FEEDBACK');
      feedback.push({
        sequence:event.sequence,
        phase:event.phase,
        progress:event.progress,
        pose:sanitizePose(event.pose)
      });
      if(feedback.length>10000)throw Error('NAV2_BRIDGE_FEEDBACK_OVERFLOW');
    }
  });
  const elapsedMs=Date.now()-started;
  if(outcome.status!=='arrived')
    throw Object.assign(Error(safeReason(outcome.reason??'NAV2_BRIDGE_NOT_ARRIVED')),
      {bridgeOutcome:outcome});
  const moving=feedback.filter(x=>x.phase==='moving');
  const arrived=feedback.filter(x=>x.phase==='arrived');
  const planning=feedback.filter(x=>x.phase==='planning');
  if(planning.length!==1||moving.length<1||arrived.length!==1)
    throw Error('NAV2_BRIDGE_FEEDBACK_INCOMPLETE');
  for(let i=1;i<feedback.length;i++){
    if(!Number.isSafeInteger(feedback[i].sequence)
      ||feedback[i].sequence!==feedback[i-1].sequence+1)
      throw Error('NAV2_BRIDGE_FEEDBACK_SEQUENCE_INVALID');
  }
  if(feedback.at(-1)?.phase!=='arrived'||feedback.at(-1)?.progress!==100)
    throw Error('NAV2_BRIDGE_FEEDBACK_TERMINAL_INVALID');
  return {
    goal,status:'arrived',verified:true,
    elapsed_ms:elapsedMs,
    feedback_count:feedback.length,
    moving_feedback_count:moving.length,
    arrived_feedback_count:arrived.length,
    first_sequence:feedback[0].sequence,
    last_sequence:feedback.at(-1).sequence,
    max_progress:Math.max(...feedback.map(x=>x.progress)),
    final_pose:sanitizePose(outcome.pose)
  };
}
export async function runAcceptance(path,{Bridge=Nav2SimulationBridge}={}){
  requireLiveEnvironment();
  const prior=await readObject(path);
  if(prior.schema!==SCHEMA||prior.mode!==MODE||prior.status!=='blocked'
    ||prior.reason!=='PREFLIGHT_PENDING'||!safeRunId(prior.run_id))
    throw Error('NAV2_BRIDGE_REPORT_NOT_RESET');
  const expected=process.env.ALEX_ROS_ACCEPTANCE_RUN_ID;
  if(!safeRunId(expected)||expected!==prior.run_id)
    throw Error('NAV2_BRIDGE_RUN_ID_MISMATCH');
  const report={
    ...baseReport(prior.run_id,'running','NODE_BRIDGE_RUNTIME_STARTED'),
    created_at:prior.created_at,
    updated_at:now()
  };
  await atomicWrite(path,report);
  const bridge=new Bridge({simulationOnly:true});
  try{
    for(const goal of GOALS){
      const leg=await runLeg(bridge,goal);
      report.legs.push(leg);
      report.checks.push(
        goal==='study_desk'?'node_bridge_study_desk_arrived':'node_bridge_dock_arrived'
      );
      report.bridge={
        active:bridge.active===true,
        stop_unconfirmed:bridge.stopUnconfirmed===true,
        final_pose:sanitizePose(bridge.pose)
      };
      report.updated_at=now();
      await atomicWrite(path,report);
    }
    if(report.legs.some(x=>x.feedback_count<3))
      throw Error('NAV2_BRIDGE_FEEDBACK_INCOMPLETE');
    report.checks.push('node_bridge_feedback_observed','node_bridge_same_instance_reused');
    if(bridge.active!==false||bridge.stopUnconfirmed!==false)
      throw Error('NAV2_BRIDGE_NOT_IDLE_AFTER_ROUTE');
    report.bridge={
      active:false,stop_unconfirmed:false,
      final_pose:sanitizePose(bridge.pose)
    };
    report.status='passed';
    report.reason=null;
    report.updated_at=now();
    await atomicWrite(path,report);
    return report;
  }catch(error){
    report.status='failed';
    report.reason=safeReason(error?.message);
    report.bridge={
      active:bridge.active===true,
      stop_unconfirmed:bridge.stopUnconfirmed===true,
      final_pose:(bridge.pose?sanitizePose(bridge.pose):null)
    };
    report.updated_at=now();
    await atomicWrite(path,report);
    throw error;
  }
}

function parseArgs(argv){
  const args={};
  for(let i=0;i<argv.length;i++){
    const value=argv[i];
    if(['--reset','--run','--fail'].includes(value)){args[value.slice(2)]=true;continue;}
    if(['--report','--reason'].includes(value)&&argv[i+1]){
      args[value.slice(2)]=argv[++i];continue;
    }
    throw Error('NAV2_BRIDGE_INVALID_ARGS');
  }
  if([args.reset,args.run,args.fail].filter(Boolean).length!==1||!args.report)
    throw Error('NAV2_BRIDGE_INVALID_ARGS');
  return args;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const args=parseArgs(process.argv.slice(2));
    if(args.reset){
      const report=await resetReport(args.report);
      console.log(JSON.stringify({status:report.status,run_id:report.run_id}));
    }else if(args.fail){
      const changed=await failReport(args.report,args.reason);
      console.log(JSON.stringify({status:changed?'failed':'unchanged'}));
    }else{
      const report=await runAcceptance(args.report);
      console.log(JSON.stringify({
        schema:report.schema,status:report.status,run_id:report.run_id,
        checks:report.checks
      }));
    }
  }catch(error){
    console.error(safeReason(error?.message));
    process.exitCode=1;
  }
}
