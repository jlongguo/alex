import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const bundler=join(root,'scripts/ros-workflow-evidence-bundle.py');
const writer=join(root,'scripts/write-ros-artifact-attestation.py');
const verifier=join(root,'scripts/verify-ros-evidence-set.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');

const ARTIFACT_ID='123456789';
const DIGEST='a'.repeat(64);
const RUN_A='76543210';
const RUN_B='76543211';
const SHA_A='0123456789abcdef0123456789abcdef01234567';
const SHA_B='fedcba9876543210fedcba9876543210fedcba98';

const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:20000,
 env:{...process.env,...(env??{})}
});

const leg=(goal,x,y)=>({
 goal,x,y,pose_x:x,pose_y:y,position_error_m:0.02,
 feedback_count:12,odom_distance_m:1.4,wall_seconds:14.5,verified:true
});

function reports(suffix='a'){
 const common={
  graph:{
   missing:[],ready_candidate:true,map_valid:true,tf_fresh:true,
   nav2_action_ready:true,clock_observations:5,odom_samples:5,
   scan_ranges:90,
   observed_tf_edges:['odom->base_link','map->odom','base_link->lidar_link']
  },
  nav2_lifecycle:{state_id:3,active_responses:3,last_error:null},
  cancel:{
   goal:'study_desk',goal_accepted:true,
   cancel_request_sent:true,cancel_acknowledged:true,
   terminal_status:'CANCELED',tf_fresh:true,odom_advanced:true,
   position_drift_m:0.01,observation_seconds:1.55,
   nonzero_velocity_commands:0
  },
  checks:[
   'clock_scan_odom_map_tf_nav2_ready','bt_navigator_lifecycle_active',
   'nav2_cancel_acknowledged','nav2_cancel_terminal','post_cancel_stop_observed'
  ]
 };
 const route={
  schema:'alex.dev/ros-acceptance/v1',mode:'route',
  status:'passed',simulation_only:true,run_id:`r65-route-${suffix}`,
  checks:['clock_scan_odom_map_tf_nav2_ready'],
  legs:[leg('study_desk',1.7,1.6),leg('story_corner',4.9,1.7),leg('dock',0.7,2.8)]
 };
 const cancel={
  ...structuredClone(common),
  schema:'alex.dev/ros-cancel-acceptance/v1',
  mode:'cancel-probe',status:'passed',simulation_only:true,
  release_approved:false,physical_safety_certified:false,
  run_id:`r65-cancel-${suffix}`,legs:[]
 };
 const recovery={
  ...structuredClone(common),
  schema:'alex.dev/ros-recovery-acceptance/v1',
  mode:'recover-probe',status:'passed',simulation_only:true,
  release_approved:false,physical_safety_certified:false,
  run_id:`r65-recovery-${suffix}`,
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
   tf_fresh:true,feedback_count:12,odom_distance_m:1.4
  }
 };
 const bridge={
  schema:'alex.dev/nav2-bridge-live-acceptance/v1',
  mode:'bridge-probe',status:'passed',source:'node-python-nav2-live',
  execution_class:'live-gazebo',
  runtime_chain:'node->python-rclpy->nav2-action',
  independent_tf_verified:false,
  simulation_only:true,physical_safety_certified:false,release_approved:false,
  run_id:`44444444-4444-4444-8444-44444444444${suffix==='a'?'4':'5'}`,
  reason:null,
  checks:[
   'node_bridge_study_desk_arrived','node_bridge_dock_arrived',
   'node_bridge_feedback_observed','node_bridge_same_instance_reused'
  ],
  legs:[
   {goal:'study_desk',status:'arrived',verified:true,elapsed_ms:1200,
    feedback_count:3,moving_feedback_count:1,arrived_feedback_count:1,
    first_sequence:1,last_sequence:3,max_progress:100,
    map_version:'alex-home-grid-v1',final_pose:{x:17,y:16,heading:0}},
   {goal:'dock',status:'arrived',verified:true,elapsed_ms:1300,
    feedback_count:3,moving_feedback_count:1,arrived_feedback_count:1,
    first_sequence:1,last_sequence:3,max_progress:100,
    map_version:'alex-home-grid-v1',final_pose:{x:7,y:28,heading:0}}
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

function actionEnv({runId=RUN_A,attempt='1',sha=SHA_A}={}){
 return {
  GITHUB_ACTIONS:'true',
  GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_REPOSITORY:'jlongguo/alex',
  GITHUB_JOB:'nav2-simulation',
  RUNNER_ENVIRONMENT:'self-hosted',
  GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
  GITHUB_RUN_ID:runId,
  GITHUB_RUN_ATTEMPT:attempt,
  GITHUB_SHA:sha,
  ALEX_ROS_ARTIFACT_ID:ARTIFACT_ID,
  ALEX_ROS_ARTIFACT_DIGEST:DIGEST
 };
}

async function writeReports(folder,suffix){
 for(const [name,data] of reports(suffix))
  await writeFile(join(folder,name),JSON.stringify(data));
}

async function createSet(base,{runId=RUN_A,attempt='1',sha=SHA_A,suffix='a'}={}){
 const folder=join(base,'ros');
 const attestation=join(base,'artifact-attestation.json');
 await mkdir(folder,{recursive:true});
 const env=actionEnv({runId,attempt,sha});
 const bundle=join(folder,'workflow-evidence-bundle.json');

 const reset=run('python3',[bundler,'--reset','--bundle',bundle],env);
 assert.equal(reset.status,0,reset.stderr);
 await writeReports(folder,suffix);
 const collect=run('python3',[bundler,'--collect','--bundle',bundle],env);
 assert.equal(collect.status,0,collect.stderr);

 const made=run('python3',[writer,'--folder',folder,'--out',attestation],env);
 assert.equal(made.status,0,made.stderr);
 return {folder,attestation,runId,attempt:Number(attempt),sha};
}

function verifySet(set,overrides={}){
 return run('python3',[
  verifier,
  '--folder',overrides.folder??set.folder,
  '--attestation',overrides.attestation??set.attestation,
  '--artifact-id',overrides.artifactId??ARTIFACT_ID,
  '--artifact-digest',overrides.digest??DIGEST,
  '--run-id',overrides.runId??set.runId,
  '--attempt',String(overrides.attempt??set.attempt),
  '--commit-sha',overrides.sha??set.sha
 ]);
}

async function temp(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r65-set-'));
 try{return await fn(dir);}
 finally{await rm(dir,{recursive:true,force:true});}
}

test('R65 同一 Run/Attempt/Commit/Artifact 的完整 ROS evidence set 可统一通过',{timeout:20000},async()=>{
 await temp(async dir=>{
  const set=await createSet(dir);
  const checked=verifySet(set);
  assert.equal(checked.status,0,checked.stderr);
  assert.match(checked.stdout,/coherently verified/);
 });
});

test('R65 两套各自合法证据不能跨 Workflow Run 拼接',{timeout:20000},async()=>{
 await temp(async dir=>{
  const a=await createSet(join(dir,'a'),{runId:RUN_A,attempt:'1',sha:SHA_A,suffix:'a'});
  const b=await createSet(join(dir,'b'),{runId:RUN_B,attempt:'1',sha:SHA_A,suffix:'b'});
  assert.equal(verifySet(a).status,0);
  assert.equal(verifySet(b).status,0);

  const mixed=verifySet(a,{attestation:b.attestation});
  assert.equal(mixed.status,1);
  assert.match(mixed.stderr,/EVIDENCE_SET|EVIDENCE_|ARTIFACT_ATTESTATION_/);
 });
});

test('R65 同一 Run 的不同 Attempt 也不能混用',{timeout:20000},async()=>{
 await temp(async dir=>{
  const a=await createSet(join(dir,'a'),{runId:RUN_A,attempt:'1',sha:SHA_A,suffix:'a'});
  const b=await createSet(join(dir,'b'),{runId:RUN_A,attempt:'2',sha:SHA_A,suffix:'b'});
  assert.equal(verifySet(a).status,0);
  assert.equal(verifySet(b).status,0);
  const mixed=verifySet(a,{attestation:b.attestation});
  assert.equal(mixed.status,1);
 });
});

test('R65 不同 Commit SHA 的合法证据不能组成同一发布集合',{timeout:20000},async()=>{
 await temp(async dir=>{
  const a=await createSet(join(dir,'a'),{runId:RUN_A,attempt:'1',sha:SHA_A,suffix:'a'});
  const b=await createSet(join(dir,'b'),{runId:RUN_A,attempt:'1',sha:SHA_B,suffix:'b'});
  assert.equal(verifySet(a).status,0);
  assert.equal(verifySet(b).status,0);
  const mixed=verifySet(a,{attestation:b.attestation});
  assert.equal(mixed.status,1);
 });
});

test('R65 替换一份业务上仍合法的报告，也必须因 Bundle/Artifact 哈希不一致失败',{timeout:20000},async()=>{
 await temp(async dir=>{
  const a=await createSet(join(dir,'a'),{suffix:'a'});
  const b=await createSet(join(dir,'b'),{suffix:'b'});
  const replacement=await readFile(join(b.folder,'cancel-acceptance-report.json'),'utf8');
  await writeFile(join(a.folder,'cancel-acceptance-report.json'),replacement);
  const checked=verifySet(a);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/EVIDENCE_REPORT_HASH_OR_ID_MISMATCH|ARTIFACT_ATTESTATION_DOWNLOADED_FILE_MISMATCH/);
 });
});

test('R65 Runtime Gate coherent set 一次性核验六个 ROS 门槛，但保留真实语音和物理安全',{timeout:20000},async()=>{
 await temp(async dir=>{
  const set=await createSet(dir);
  const checked=run('python3',[
   gate,
   '--ros-evidence-folder',set.folder,
   '--ros-evidence-attestation',set.attestation,
   '--ros-evidence-artifact-id',ARTIFACT_ID,
   '--ros-evidence-artifact-digest',DIGEST,
   '--ros-evidence-run-id',set.runId,
   '--ros-evidence-attempt',String(set.attempt),
   '--ros-evidence-sha',set.sha
  ]);
  assert.equal(checked.status,0,checked.stderr);
  const data=JSON.parse(checked.stdout);
  assert.equal(data.ros_evidence_set,'verified-coherent');
  assert.equal(data.ros_runtime,'verified-by-set');
  assert.equal(data.ros_cancel_runtime,'verified-by-set');
  assert.equal(data.ros_recovery_runtime,'verified-by-set');
  assert.equal(data.ros_bridge_runtime,'verified-by-set');
  assert.equal(data.ros_workflow_bundle,'verified-by-set');
  assert.equal(data.ros_artifact_attestation,'verified-by-set');
  for(const item of [
   'GAZEBO_NAV2_THREE_LEG_RUNTIME',
   'GAZEBO_NAV2_CANCEL_RUNTIME',
   'GAZEBO_NAV2_RECOVERY_RUNTIME',
   'GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME',
   'GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE',
   'GAZEBO_ACTIONS_ARTIFACT_ATTESTATION',
   'GAZEBO_ROS_COHERENT_EVIDENCE_SET'
  ])assert.ok(!data.remaining.includes(item),item);
  assert.ok(data.remaining.includes('REAL_ASR_LLM_TTS_PROVIDER_E2E'));
  assert.ok(data.remaining.includes('PHYSICAL_SAFETY_REVIEW'));
  assert.equal(data.release_approved,false);
 });
});

test('R65 coherent set 禁止与另一组单项 ROS 参数混用',{timeout:20000},async()=>{
 await temp(async dir=>{
  const set=await createSet(dir);
  const route=join(set.folder,'acceptance-report.json');
  const routeDoc=JSON.parse(await readFile(route,'utf8'));
  const checked=run('python3',[
   gate,
   '--ros-evidence-folder',set.folder,
   '--ros-evidence-attestation',set.attestation,
   '--ros-evidence-artifact-id',ARTIFACT_ID,
   '--ros-evidence-artifact-digest',DIGEST,
   '--ros-evidence-run-id',set.runId,
   '--ros-evidence-attempt',String(set.attempt),
   '--ros-evidence-sha',set.sha,
   '--ros-report',route,
   '--ros-run-id',routeDoc.run_id
  ]);
  assert.equal(checked.status,2);
  assert.match(checked.stderr,/ROS_EVIDENCE_SET_CANNOT_MIX_INDIVIDUAL_ROS_ARGS/);
 });
});

test('R65 coherent set 参数必须一次完整提供，不能部分启用',{timeout:20000},()=>{
 const checked=run('python3',[
  gate,
  '--ros-evidence-folder','/tmp/not-used',
  '--ros-evidence-run-id',RUN_A
 ]);
 assert.equal(checked.status,2);
 assert.match(checked.stderr,/ROS_EVIDENCE_SET_METADATA_REQUIRED_TOGETHER/);
});

test('R65 Workflow 在 attestation 上传前执行统一 evidence-set 校验',{timeout:20000},async()=>{
 const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
 const artifactVerify=workflow.indexOf('verify-ros-artifact-attestation.py');
 const setVerify=workflow.indexOf('verify-ros-evidence-set.py');
 const attestUpload=workflow.indexOf('name: alex-ros-gazebo-attestation');
 assert.ok(artifactVerify>=0);
 assert.ok(setVerify>artifactVerify);
 assert.ok(attestUpload>setVerify);
 assert.match(workflow,/--run-id "\$GITHUB_RUN_ID"/);
 assert.match(workflow,/--attempt "\$GITHUB_RUN_ATTEMPT"/);
 assert.match(workflow,/--commit-sha "\$GITHUB_SHA"/);
});
