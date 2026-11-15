import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const bundler=join(root,'scripts/ros-workflow-evidence-bundle.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const SHA='0123456789abcdef0123456789abcdef01234567';
const ACTIONS={
 GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_REPOSITORY:'jlongguo/alex',GITHUB_JOB:'nav2-simulation',
 RUNNER_ENVIRONMENT:'self-hosted',
 GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
 GITHUB_RUN_ID:'76543210',GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:SHA
};
const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 env:{...process.env,...(env??{})}
});
const py=(args,env)=>run('python3',[bundler,...args],env);
const leg=(goal,x,y)=>({
 goal,x,y,pose_x:x,pose_y:y,position_error_m:0.02,
 feedback_count:12,odom_distance_m:1.4,wall_seconds:14.5,verified:true
});
const common={
 graph:{
  missing:[],ready_candidate:true,map_valid:true,tf_fresh:true,
  nav2_action_ready:true,clock_observations:5,odom_samples:5,
  scan_ranges:90,observed_tf_edges:['odom->base_link','map->odom','base_link->lidar_link']
 },
 nav2_lifecycle:{state_id:3,active_responses:3,last_error:null},
 cancel:{
  goal:'study_desk',goal_accepted:true,
  cancel_request_sent:true,cancel_acknowledged:true,
  terminal_status:'CANCELED',tf_fresh:true,odom_advanced:true,
  position_drift_m:0.01,observation_seconds:1.55,nonzero_velocity_commands:0
 },
 checks:[
  'clock_scan_odom_map_tf_nav2_ready','bt_navigator_lifecycle_active',
  'nav2_cancel_acknowledged','nav2_cancel_terminal','post_cancel_stop_observed'
 ]
};
function reports(){
 const route={
  schema:'alex.dev/ros-acceptance/v1',mode:'route',
  status:'passed',simulation_only:true,run_id:'r60-route-one',
  checks:['clock_scan_odom_map_tf_nav2_ready'],
  legs:[leg('study_desk',1.7,1.6),leg('story_corner',4.9,1.7),leg('dock',0.7,2.8)]
 };
 const cancel={
  ...structuredClone(common),
  schema:'alex.dev/ros-cancel-acceptance/v1',
  mode:'cancel-probe',status:'passed',simulation_only:true,
  release_approved:false,physical_safety_certified:false,
  run_id:'r60-cancel-two',legs:[]
 };
 const recovery={
  ...structuredClone(common),
  schema:'alex.dev/ros-recovery-acceptance/v1',
  mode:'recover-probe',status:'passed',simulation_only:true,
  release_approved:false,physical_safety_certified:false,
  run_id:'r60-recovery-three',
  checks:[
   ...common.checks,
   'post_cancel_recovery_desk_verified','post_cancel_return_dock_verified'
  ],
  legs:[leg('study_desk',1.7,1.6),leg('dock',0.7,2.8)],
  recovery:{
   source:'same-gazebo-session',cancel_verified:true,
   recovery_goals:['study_desk','dock'],return_to_dock_verified:true
  },
  last_goal:{
   goal:'dock',action_status:'SUCCEEDED',
   feedback_count:12,odom_distance_m:1.4
  }
 };
 const bridge={
  schema:'alex.dev/nav2-bridge-live-acceptance/v1',
  mode:'bridge-probe',status:'passed',source:'node-python-nav2-live',
  simulation_only:true,physical_safety_certified:false,release_approved:false,
  execution_class:'live-gazebo',
  runtime_chain:'node->python-rclpy->nav2-action',
  independent_tf_verified:false,run_id:'44444444-4444-4444-8444-444444444444',
  reason:null,
  checks:[
   'node_bridge_study_desk_arrived','node_bridge_dock_arrived',
   'node_bridge_feedback_observed','node_bridge_same_instance_reused'
  ],
  legs:[
   {goal:'study_desk',status:'arrived',verified:true,elapsed_ms:1200,
    feedback_count:3,moving_feedback_count:1,arrived_feedback_count:1,
    first_sequence:1,last_sequence:3,max_progress:100,map_version:'alex-home-grid-v1',
    final_pose:{x:17,y:16,heading:0}},
   {goal:'dock',status:'arrived',verified:true,elapsed_ms:1300,
    feedback_count:3,moving_feedback_count:1,arrived_feedback_count:1,
    first_sequence:1,last_sequence:3,max_progress:100,map_version:'alex-home-grid-v1',
    final_pose:{x:7,y:28,heading:0}}
  ],
  bridge:{active:false,stop_unconfirmed:false,final_pose:{x:7,y:28,heading:0}}
 };
 return [
  ['acceptance-report.json',route],
  ['cancel-acceptance-report.json',cancel],
  ['recovery-acceptance-report.json',recovery],
  ['bridge-acceptance-report.json',bridge]
 ];
}
async function withDir(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r60-bundle-'));
 try{await fn({dir,bundle:join(dir,'workflow-evidence-bundle.json')});}
 finally{await rm(dir,{recursive:true,force:true});}
}
async function seedReports(dir,docs=reports()){
 for(const [name,body] of docs)await writeFile(join(dir,name),JSON.stringify(body));
}
const reset=(bundle,env=ACTIONS)=>py(['--reset','--bundle',bundle],env);
const collect=(bundle,env=ACTIONS)=>py(['--collect','--bundle',bundle],env);
const verify=(bundle,options=[])=>py([
 '--verify','--bundle',bundle,'--expect-run-id',ACTIONS.GITHUB_RUN_ID,
 '--expect-sha',SHA,...options
]);
async function assembled(dir,bundle){
 const cleared=reset(bundle);
 assert.equal(cleared.status,0,cleared.stderr);
 await seedReports(dir);
 const checked=collect(bundle);
 assert.equal(checked.status,0,checked.stderr);
 return JSON.parse(await readFile(bundle,'utf8'));
}

test('R60/R63 四份独立 Nav2 验收报告绑定同一工作流、commit、四种不同 run ID',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  const manifest=await assembled(dir,bundle);
  assert.equal(manifest.status,'assembled');
  assert.equal(manifest.source,'github-actions-manual-self-hosted');
  assert.equal(manifest.context.workflow_run_id,ACTIONS.GITHUB_RUN_ID);
  assert.equal(manifest.context.workflow_run_attempt,2);
  assert.equal(manifest.context.commit_sha,SHA);
  assert.equal(manifest.release_approved,false);
  assert.equal(manifest.physical_safety_certified,false);
  assert.deepEqual(manifest.reports.map(x=>x.kind),['route','cancel','recovery','bridge']);
  assert.equal(new Set(manifest.reports.map(x=>x.run_id)).size,4);
  for(const item of manifest.reports){
   assert.match(item.sha256,/^[0-9a-f]{64}$/);
   assert.ok(item.size_bytes>0);
   assert.ok(!JSON.stringify(item).includes(dir));
  }
  const check=verify(bundle,['--expect-attempt','2']);
  assert.equal(check.status,0,check.stderr);
  assert.match(check.stdout,/STRUCTURE_ONLY/);
 });
});

test('R60 新工作流启动后禁止重用旧 PASS、没有 reset 也禁止收集',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  await seedReports(dir);
  const uninitialized=collect(bundle);
  assert.equal(uninitialized.status,1);
  const cleared=reset(bundle);
  assert.equal(cleared.status,0,cleared.stderr);
  const stale=collect(bundle);
  assert.equal(stale.status,1);
  assert.match(stale.stderr,/EVIDENCE_STALE_SCENARIO_REPORT/);
  const report=JSON.parse(await readFile(bundle,'utf8'));
  assert.equal(report.status,'blocked');
  assert.deepEqual(report.reports,[]);
  await seedReports(dir);
  assert.equal(collect(bundle).status,0);
  assert.equal(reset(bundle).status,0);
  assert.equal(verify(bundle).status,1,'新一次 reset 必须失效旧的 assembled');
 });
});

test('R60 检测报告篡改、删除与错误 run ID/commit/attempt',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  await assembled(dir,bundle);
  const wrongSha=verify(bundle,['--expect-attempt','3']);
  assert.equal(wrongSha.status,1);
  assert.match(wrongSha.stderr,/EVIDENCE_WORKFLOW_ATTEMPT_MISMATCH/);
  const stale=py(['--verify','--bundle',bundle,'--expect-run-id','123456',
   '--expect-sha',SHA]);
  assert.equal(stale.status,1);
  const wrongCommit=py(['--verify','--bundle',bundle,
   '--expect-run-id',ACTIONS.GITHUB_RUN_ID,'--expect-sha','f'.repeat(40)]);
  assert.equal(wrongCommit.status,1);
  const target=join(dir,'cancel-acceptance-report.json');
  const doc=JSON.parse(await readFile(target,'utf8'));
  doc.cancel.position_drift_m=0.02;
  await writeFile(target,JSON.stringify(doc));
  assert.equal(verify(bundle).status,1,'内容变更即使仍满足取消业务阈值也必须拒绝');
  await rm(target);
  assert.equal(verify(bundle).status,1,'缺失的报告不得被历史哈希代替');
 });
});

test('R60/R63 拒绝同一个运行 ID 冒充四个独立场景',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  assert.equal(reset(bundle).status,0);
  const docs=reports();
  docs[1][1].run_id=docs[0][1].run_id;
  await seedReports(dir,docs);
  const bad=collect(bundle);
  assert.equal(bad.status,1);
  assert.match(bad.stderr,/EVIDENCE_REUSED_SCENARIO_RUN_ID/);
 });
});

test('R60 无授权 Workflow、非自托管 Runner、错误 SHA/Ref 都 fail closed',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  for(const patch of [
   {GITHUB_ACTIONS:'false'},
   {GITHUB_EVENT_NAME:'pull_request'},
   {RUNNER_ENVIRONMENT:'github-hosted'},
   {GITHUB_JOB:'other-job'},
   {GITHUB_REPOSITORY:'another/alex'},
   {GITHUB_SHA:'invalid'},
   {GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/ci.yml@refs/heads/main'},
   {GITHUB_RUN_ID:'0'},
   {GITHUB_RUN_ATTEMPT:'0'}
  ]){
   const bad=reset(bundle,{...ACTIONS,...patch});
   assert.equal(bad.status,1,JSON.stringify(patch));
  }
  assert.equal(reset(bundle).status,0);
  await seedReports(dir);
  assert.equal(collect(bundle,{...ACTIONS,GITHUB_RUN_ID:'76543211'}).status,1);
  assert.equal(collect(bundle,{...ACTIONS,GITHUB_SHA:'f'.repeat(40)}).status,1);
 });
});

test('R60 软链接与过大报告不允许装入工作流证据清单',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  assert.equal(reset(bundle).status,0);
  await seedReports(dir);
  const target=join(dir,'acceptance-report.json');
  await rm(target);
  await symlink(join(dir,'cancel-acceptance-report.json'),target);
  assert.equal(collect(bundle).status,1);
  await rm(target);
  await writeFile(target,'x'.repeat(300*1024));
  assert.equal(collect(bundle).status,1);
 });
});

test('R60 runtime gate 只把 Bundle 视为结构对账，仍需每项 ROS 与物理安全证据',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  const initial=run('python3',[gate]);
  assert.equal(initial.status,0,initial.stderr);
  const baseline=JSON.parse(initial.stdout);
  assert.equal(baseline.ros_workflow_bundle,'not_run');
  assert.ok(baseline.remaining.includes('GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE'));
  await assembled(dir,bundle);
  const checked=run('python3',[gate,
   '--ros-workflow-bundle',bundle,
   '--ros-workflow-run-id',ACTIONS.GITHUB_RUN_ID,
   '--ros-workflow-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  const result=JSON.parse(checked.stdout);
  assert.equal(result.ros_workflow_bundle,'verified-structure');
  assert.equal(result.ros_runtime,'not_run');
  assert.equal(result.ros_cancel_runtime,'not_run');
  assert.equal(result.ros_recovery_runtime,'not_run');
  assert.equal(result.ros_bridge_runtime,'not_run');
  assert.ok(result.remaining.includes('GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME'));
  assert.ok(result.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
  assert.ok(result.remaining.includes('GAZEBO_NAV2_CANCEL_RUNTIME'));
  assert.ok(result.remaining.includes('GAZEBO_NAV2_RECOVERY_RUNTIME'));
  assert.ok(!result.remaining.includes('GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE'));
  assert.equal(result.release_approved,false);
  assert.equal(result.physical_safety_certified,false);

  const tampered=run('python3',[gate,'--ros-workflow-bundle',bundle,
   '--ros-workflow-run-id',ACTIONS.GITHUB_RUN_ID,
   '--ros-workflow-sha','f'.repeat(40)]);
  assert.equal(tampered.status,1);
  assert.equal(JSON.parse(tampered.stdout).ros_workflow_bundle,'invalid');
  const incomplete=run('python3',[gate,'--ros-workflow-bundle',bundle]);
  assert.equal(incomplete.status,2);
  assert.match(incomplete.stderr,/ROS_WORKFLOW_BUNDLE_RUN_ID_AND_SHA_REQUIRED_TOGETHER/);
 });
});

test('R60 手动工作流先失效旧报告、后校验 Bundle、失败也上传清单',async()=>{
 const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
 const steps=[
  'Invalidate previous ROS workflow evidence',
  'npm run sim:accept',
  'npm run sim:accept-cancel',
  'npm run sim:accept-recovery',
  'npm run sim:accept-bridge',
  'npm run sim:bundle-collect',
  'npm run sim:bundle-verify',
  'Upload acceptance report and launch logs even on failure'
 ];
 let previous=-1;
 for(const name of steps){
  const index=workflow.indexOf(name);
  assert.ok(index>previous,'工作流步骤缺失或排序错乱: '+name);
  previous=index;
 }
 assert.match(workflow,/workflow-evidence-bundle\.json/);
 assert.match(workflow,/approval-gate:/);
 assert.match(workflow,/ALEX_SIM_RUNNER_APPROVED: \$\{\{ vars\.ALEX_SIM_RUNNER_APPROVED \}\}/);
 assert.match(workflow,/ALEX_SIM_RUNNER_APPROVED is not true; refusing to schedule ROS acceptance/);
 assert.match(workflow,/nav2-simulation:[\s\S]*needs: approval-gate/);
 assert.match(workflow,/runs-on: \[self-hosted, linux, x64, alex-ros-sim\]/);
});

test('R60 Bundle 的场景模式、报告证据或目录枚举被伪造时拒绝',{timeout:15000},async()=>{
 await withDir(async({dir,bundle})=>{
  assert.equal(reset(bundle).status,0);
  const candidates=[
   doc=>{doc.mode='route';},
   doc=>{doc.status='failed';},
   doc=>{doc.cancel.terminal_status='SUCCEEDED';},
   doc=>{doc.cancel.nonzero_velocity_commands=4;},
   doc=>{doc.graph.missing=['/clock'];}
  ];
  const original=reports()[1][1];
  const target=join(dir,'cancel-acceptance-report.json');
  await seedReports(dir);
  for(const change of candidates){
   const doc=structuredClone(original);change(doc);
   await writeFile(target,JSON.stringify(doc));
   const result=collect(bundle);
   assert.equal(result.status,1,JSON.stringify(doc));
  }
  await writeFile(target,JSON.stringify(original));
  assert.equal(collect(bundle).status,0);

  const manifest=JSON.parse(await readFile(bundle,'utf8'));
  manifest.reports[0].filename='../wrong-report.json';
  await writeFile(bundle,JSON.stringify(manifest));
  assert.equal(verify(bundle).status,1);
 });
});
