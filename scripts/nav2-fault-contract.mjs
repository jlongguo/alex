// R57：仅针对内置伪 Nav2 子进程执行故障契约测试，不连接 ROS 网络或物理设备。
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Nav2SimulationBridge} from './ros2-navigation.mjs';

const FIXTURE=fileURLToPath(new URL('../tests/fixtures/fake-nav2-client.mjs',import.meta.url));
const REQUIRED=['rejected','user_cancelled','timeout_unconfirmed','recovery_after_failure'];
const safeRunId=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id);
const fail=(code)=>{throw Error(code);};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));

async function saveReport(path,data){
 const file=resolve(path);
 await mkdir(dirname(file),{recursive:true,mode:0o700});
 // 文件内容只允许结构化故障码和数值，不包含系统路径或进程日志。
 const tmp=file+'.tmp';
 await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});
 await rename(tmp,file);
}

export async function runNav2FaultContract({
 reportPath='.local/ros/nav2-fault-contract.json',
 makeRunId=randomUUID
}={}){
 const runId=makeRunId();
 if(!safeRunId(runId))fail('NAV2_FAULT_INVALID_RUN_ID');
 let mode='reject',cancelled=false;
 const children=new Set();
 const bridge=new Nav2SimulationBridge({
  simulationOnly:true,startupMs:500,goalTimeoutMs:1000,cancelGraceMs:120,
  spawnProcess:(_cmd,_args,options)=>{
   const child=spawn(process.execPath,[FIXTURE],{
    stdio:options.stdio,shell:false,
    env:{...options.env,ALEX_TEST_NAV2_MODE:mode}
   });
   children.add(child);
   child.once('exit',()=>children.delete(child));
   return child;
  }
 });
 const report={
  schema:'alex.dev/nav2-fault-contract/v1',run_id:runId,
  status:'running',source:'injected-subprocess',
  simulation_only:true,ros_runtime_verified:false,
  physical_safety_certified:false,release_approved:false,
  scenarios:{},checks:[]
 };
 async function scenario(id,modeName,options={}){
  mode=modeName;
  cancelled=false;
  if(options.cancelAfterMs!==undefined)
   setTimeout(()=>{cancelled=true;},options.cancelAfterMs).unref?.();
  const started=Date.now();
  const value=await bridge.navigate('study_desk',{
   isCancelled:()=>cancelled
  });
  const safeReason=typeof value.reason==='string'
   &&/^[A-Z0-9_]+$/.test(value.reason)?value.reason:null;
  report.scenarios[id]={
   status:value.status,
   reason:safeReason,
   elapsed_ms:Math.max(0,Date.now()-started),
   idle_after:bridge.active===false
  };
  return value;
 }
 try{
  const rejected=await scenario('rejected','reject');
  if(rejected.status!=='failed'||rejected.reason!=='rejected')
   fail('NAV2_FAULT_REJECT_NOT_OBSERVED');
  report.checks.push('rejected');

  const cancelledResult=await scenario('user_cancelled','hold',{cancelAfterMs:50});
  if(cancelledResult.status!=='cancelled')
   fail('NAV2_FAULT_CANCEL_NOT_OBSERVED');
  report.checks.push('user_cancelled');

  const timeout=await scenario('timeout_unconfirmed','ignore-cancel');
  if(timeout.status!=='failed'||timeout.reason!=='NAV2_CANCEL_UNCONFIRMED')
   fail('NAV2_FAULT_TIMEOUT_NOT_OBSERVED');
  report.checks.push('timeout_unconfirmed');

  const recovery=await scenario('recovery_after_failure','success');
  if(recovery.status!=='arrived')fail('NAV2_FAULT_RECOVERY_NOT_OBSERVED');
  report.checks.push('recovery_after_failure');

  if(REQUIRED.some(id=>report.scenarios[id]?.idle_after!==true))
   fail('NAV2_FAULT_ACTIVE_STATE_LEAK');
  report.status='passed';
  return report;
 }catch(error){
  report.status='failed';
  // 错误信息只允许固定错误码，拒绝写入供应商内容、路径或其他私有信息。
  report.error_code=/^NAV2_FAULT_[A-Z_]+$/.test(error?.message??'')
   ?error.message:'NAV2_FAULT_INTERNAL_ERROR';
  throw Object.assign(Error(report.error_code),{report});
 }finally{
  // 即使案例失败也终止剩余测试子进程，不留下模拟导航客户端。
  for(const child of children)child.kill('SIGTERM');
  await Promise.allSettled([...children].map(async child=>{
   if(child.exitCode===null)await Promise.race([
    new Promise(done=>child.once('exit',done)),sleep(200)
   ]);
  }));
  await saveReport(reportPath,report);
 }
}

export function verifyNav2FaultContract(report,expectedRunId=null){
 if(!report||typeof report!=='object'||Array.isArray(report)
  ||report.schema!=='alex.dev/nav2-fault-contract/v1'
  ||!safeRunId(report.run_id)
  ||report.status!=='passed'||report.source!=='injected-subprocess'
  ||report.simulation_only!==true||report.ros_runtime_verified!==false
  ||report.release_approved!==false||report.physical_safety_certified!==false)
  fail('NAV2_FAULT_INVALID_REPORT');
 if(expectedRunId!==null&&expectedRunId!==report.run_id)
  fail('NAV2_FAULT_RUN_ID_MISMATCH');
 if(!Array.isArray(report.checks)
   ||report.checks.length!==REQUIRED.length
   ||new Set(report.checks).size!==REQUIRED.length
   ||REQUIRED.some(id=>!report.checks.includes(id)))
  fail('NAV2_FAULT_INCOMPLETE_CHECKS');
 if(!report.scenarios||typeof report.scenarios!=='object'
   ||Object.keys(report.scenarios).length!==REQUIRED.length)
  fail('NAV2_FAULT_INCOMPLETE_SCENARIOS');
 const expected={
  rejected:['failed','rejected'],
  user_cancelled:['cancelled',null],
  timeout_unconfirmed:['failed','NAV2_CANCEL_UNCONFIRMED'],
  recovery_after_failure:['arrived',null]
 };
 for(const id of REQUIRED){
  const value=report.scenarios[id], [status,reason]=expected[id];
  if(!value||Object.keys(value).sort().join(',')!=='elapsed_ms,idle_after,reason,status'
    ||value.status!==status||value.reason!==reason
    ||value.idle_after!==true
    ||!Number.isSafeInteger(value.elapsed_ms)||value.elapsed_ms<0
    ||value.elapsed_ms>120000)
    fail('NAV2_FAULT_INVALID_SCENARIO');
 }
 return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length!==0&&(args.length!==2||args[0]!=='--report'||!args[1])){
  console.error('NAV2_FAULT_INVALID_ARGS');process.exitCode=2;
 }else{
  try{
   const report=await runNav2FaultContract({reportPath:args[1]});
   verifyNav2FaultContract(report,report.run_id);
   console.log(JSON.stringify({
    schema:report.schema,run_id:report.run_id,status:report.status,
    source:report.source,report:resolve(args[1]??'.local/ros/nav2-fault-contract.json')
   }));
  }catch(error){
   console.error(/^NAV2_FAULT_[A-Z_]+$/.test(error?.message??'')
    ?error.message:'NAV2_FAULT_INTERNAL_ERROR');
   process.exitCode=1;
  }
 }
}
