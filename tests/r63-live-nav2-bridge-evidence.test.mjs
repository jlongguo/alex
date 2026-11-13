import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  resetReport,runAcceptance,failReport
} from '../scripts/nav2-bridge-live-acceptance.mjs';

const root=resolve(import.meta.dirname,'..');
const verifier=join(root,'scripts/verify-nav2-bridge-live-report.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const RUN='33333333-3333-4333-8333-333333333333';

const run=(command,args,env)=>spawnSync(command,args,{
  cwd:root,encoding:'utf8',timeout:15000,
  env:{...process.env,...(env??{})}
});

function liveEnv(){
  return {
    ALEX_ROS_SIMULATION_ONLY:'1',
    ALEX_RUN_ROS_INTEGRATION:'1',
    ROS_DISTRO:'jazzy',
    ROS_DOMAIN_ID:'77',
    ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST',
    ALEX_ROS_ACCEPTANCE_RUN_ID:RUN
  };
}

function withEnv(values,fn){
  const prior=new Map();
  for(const [key,value] of Object.entries(values)){
    prior.set(key,process.env[key]);
    process.env[key]=value;
  }
  return Promise.resolve().then(fn).finally(()=>{
    for(const [key,value] of prior){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
  });
}

class FakeLiveBridge{
  constructor({simulationOnly}={}){
    assert.equal(simulationOnly,true);
    this.pose={x:7,y:28,heading:0};
    this.active=false;
    this.stopUnconfirmed=false;
    this.calls=[];
  }
  async navigate(goal,{onFeedback}={}){
    this.active=true;
    this.calls.push(goal);
    const target=goal==='study_desk'
      ?{x:17,y:16,heading:-0.2}
      :{x:7,y:28,heading:2.2};
    await onFeedback({sequence:1,phase:'planning',progress:0,pose:{...this.pose},mapVersion:'alex-home-grid-v1'});
    await onFeedback({sequence:2,phase:'moving',progress:60,pose:{x:(this.pose.x+target.x)/2,y:(this.pose.y+target.y)/2,heading:target.heading},mapVersion:'alex-home-grid-v1'});
    this.pose={...target};
    await onFeedback({sequence:3,phase:'arrived',progress:100,pose:{...target},mapVersion:'alex-home-grid-v1'});
    this.active=false;
    return {status:'arrived',pose:{...target}};
  }
}

class FailedBridge extends FakeLiveBridge{
  async navigate(){
    this.active=false;
    this.stopUnconfirmed=true;
    return {status:'failed',pose:{...this.pose},reason:'NAV2_CANCEL_UNCONFIRMED'};
  }
}

async function temp(fn){
  const dir=await mkdtemp(join(tmpdir(),'alex-r63-bridge-'));
  try{return await fn({dir,report:join(dir,'bridge-acceptance-report.json')});}
  finally{await rm(dir,{recursive:true,force:true});}
}

async function createSyntheticReport(report){
  await resetReport(report,{makeRunId:()=>RUN});
  await withEnv(liveEnv(),()=>runAcceptance(report,{Bridge:FakeLiveBridge}));
  return JSON.parse(await readFile(report,'utf8'));
}

test('R63 报告生成器要求同一 Node 桥连续完成 desk -> dock，并保留反馈证据',{timeout:10000},async()=>{
  await temp(async({report})=>{
    const data=await createSyntheticReport(report);
    assert.equal(data.status,'passed');
    assert.equal(data.source,'node-python-nav2-live');
    assert.equal(data.runtime_chain,'node->python-rclpy->nav2-action');
    assert.equal(data.independent_tf_verified,false);
    assert.equal(data.physical_safety_certified,false);
    assert.equal(data.release_approved,false);
    assert.deepEqual(data.legs.map(x=>x.goal),['study_desk','dock']);
    assert.deepEqual(data.legs.map(x=>x.final_pose),[
      {x:17,y:16,heading:-0.2},{x:7,y:28,heading:2.2}
    ]);
    for(const leg of data.legs){
      assert.equal(leg.feedback_count,3);
      assert.equal(leg.moving_feedback_count,1);
      assert.equal(leg.arrived_feedback_count,1);
      assert.equal(leg.first_sequence,1);
      assert.equal(leg.last_sequence,3);
      assert.equal(leg.max_progress,100);
    }
    assert.deepEqual(data.bridge,{
      active:false,stop_unconfirmed:false,final_pose:{x:7,y:28,heading:2.2}
    });
  });
});

test('R63 Python 验证器接受结构正确报告并拒绝 run ID、终点、过度声明和未知停止',{timeout:10000},async()=>{
  await temp(async({report})=>{
    const original=await createSyntheticReport(report);
    const good=run('python3',[verifier,'--report',report,'--run-id',RUN]);
    assert.equal(good.status,0,good.stderr);

    const mutations=[
      doc=>{doc.independent_tf_verified=true;},
      doc=>{doc.physical_safety_certified=true;},
      doc=>{doc.release_approved=true;},
      doc=>{doc.legs.reverse();},
      doc=>{doc.legs[0].final_pose.x=18;},
      doc=>{doc.legs[0].moving_feedback_count=0;},
      doc=>{doc.legs[1].last_sequence=99;},
      doc=>{doc.bridge.stop_unconfirmed=true;},
      doc=>{doc.checks.pop();},
      doc=>{doc.status='running';}
    ];
    for(const mutate of mutations){
      const doc=structuredClone(original);mutate(doc);
      await writeFile(report,JSON.stringify(doc));
      const checked=run('python3',[verifier,'--report',report,'--run-id',RUN]);
      assert.equal(checked.status,1,JSON.stringify(doc));
    }
    await writeFile(report,JSON.stringify(original));
    const stale=run('python3',[verifier,'--report',report,
      '--run-id','44444444-4444-4444-8444-444444444444']);
    assert.equal(stale.status,1);
  });
});

test('R63 运行失败时报告不会保留 PASS，且未知停止原因被结构化保存',{timeout:10000},async()=>{
  await temp(async({report})=>{
    await resetReport(report,{makeRunId:()=>RUN});
    await assert.rejects(
      ()=>withEnv(liveEnv(),()=>runAcceptance(report,{Bridge:FailedBridge})),
      /NAV2_CANCEL_UNCONFIRMED/
    );
    const data=JSON.parse(await readFile(report,'utf8'));
    assert.equal(data.status,'failed');
    assert.equal(data.reason,'NAV2_CANCEL_UNCONFIRMED');
    assert.equal(data.bridge.stop_unconfirmed,true);
    assert.equal(data.release_approved,false);
    assert.equal((await failReport(report,'REPORT_VERIFICATION_FAILED')),false,
      '已失败报告不应被第二次清理改写');
  });
});

test('R63 直接运行验收缺少仿真隔离环境时 fail closed，不接触 ROS',{timeout:10000},async()=>{
  await temp(async({report})=>{
    await resetReport(report,{makeRunId:()=>RUN});
    const env=liveEnv();
    env.ROS_DOMAIN_ID='0';
    await assert.rejects(
      ()=>withEnv(env,()=>runAcceptance(report,{Bridge:FakeLiveBridge})),
      /NAV2_BRIDGE_ISOLATED_JAZZY_DOMAIN_REQUIRED/
    );
    const data=JSON.parse(await readFile(report,'utf8'));
    assert.equal(data.status,'blocked');
    assert.equal(data.reason,'PREFLIGHT_PENDING');
  });
});

test('R63 runtime gate 单独核验桥报告，但不能解锁独立 TF、取消、恢复或物理安全门槛',{timeout:10000},async()=>{
  await temp(async({report})=>{
    await createSyntheticReport(report);
    const checked=run('python3',[gate,
      '--ros-bridge-report',report,'--ros-bridge-run-id',RUN
    ]);
    assert.equal(checked.status,0,checked.stderr);
    const data=JSON.parse(checked.stdout);
    assert.equal(data.ros_bridge_runtime,'verified');
    assert.equal(data.ros_runtime,'not_run');
    assert.equal(data.ros_cancel_runtime,'not_run');
    assert.equal(data.ros_recovery_runtime,'not_run');
    assert.ok(!data.remaining.includes('GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME'));
    assert.ok(data.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
    assert.ok(data.remaining.includes('GAZEBO_NAV2_CANCEL_RUNTIME'));
    assert.ok(data.remaining.includes('GAZEBO_NAV2_RECOVERY_RUNTIME'));
    assert.ok(data.remaining.includes('PHYSICAL_SAFETY_REVIEW'));
    assert.equal(data.release_approved,false);

    const incomplete=run('python3',[gate,'--ros-bridge-report',report]);
    assert.equal(incomplete.status,2);
    assert.match(incomplete.stderr,/ROS_BRIDGE_REPORT_AND_RUN_ID_REQUIRED_TOGETHER/);
  });
});

test('R63 shell wrapper 新模式在未授权环境中覆盖旧 PASS 并阻断执行',{timeout:10000},async()=>{
  await temp(async({report,dir})=>{
    await createSyntheticReport(report);
    const checked=run('bash',['scripts/run-ros-acceptance.sh'],{
      ALEX_ROS_ACCEPTANCE_MODE:'bridge-probe',
      ALEX_ROS_SIMULATION_ONLY:'0',
      ALEX_RUN_ROS_INTEGRATION:'0',
      ALEX_ROS_REPORT:report,
      ALEX_ROS_LOG:join(dir,'bridge.log'),
      ALEX_ROS_PREFLIGHT:join(dir,'preflight.json'),
      ALEX_ROS_DIAGNOSTICS:join(dir,'diag.json')
    });
    assert.equal(checked.status,2,checked.stderr);
    const data=JSON.parse(await readFile(report,'utf8'));
    assert.equal(data.schema,'alex.dev/nav2-bridge-live-acceptance/v1');
    assert.equal(data.status,'blocked');
    assert.deepEqual(data.legs,[]);
    assert.notEqual(data.run_id,RUN);
  });
});

test('R63 Workflow、Bundle 和 CLI 均包含 live bridge 阶段，且默认 PR CI 不执行 Gazebo',{timeout:10000},async()=>{
  const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
  const ci=await readFile(join(root,'.github/workflows/ci.yml'),'utf8');
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const shell=await readFile(join(root,'scripts/run-ros-acceptance.sh'),'utf8');
  assert.match(workflow,/npm run sim:accept-bridge/);
  assert.match(workflow,/bridge-acceptance-report\.json/);
  assert.ok(workflow.indexOf('npm run sim:accept-bridge')<
            workflow.indexOf('npm run sim:bundle-collect'));
  assert.doesNotMatch(ci,/sim:accept-bridge/);
  assert.match(pkg.scripts['sim:accept-bridge'],/bridge-probe/);
  assert.match(pkg.scripts['sim:verify-bridge-report'],/verify-nav2-bridge-live-report\.py/);
  assert.match(shell,/bridge-probe/);
  const syntax=run('bash',['-n','scripts/run-ros-acceptance.sh']);
  assert.equal(syntax.status,0,syntax.stderr);
});
