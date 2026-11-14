import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const writer=join(root,'scripts/write-ros-artifact-attestation.py');
const verifier=join(root,'scripts/verify-ros-artifact-attestation.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const SHA='0123456789abcdef0123456789abcdef01234567';
const DIGEST='a'.repeat(64);
const ARTIFACT_ID='123456789';
const RUN_ID='987654321';
const ATTEMPT='2';
const FILES=[
 'acceptance-report.json',
 'cancel-acceptance-report.json',
 'recovery-acceptance-report.json',
 'bridge-acceptance-report.json',
 'workflow-evidence-bundle.json'
];

const actionsEnv=()=>({
 GITHUB_ACTIONS:'true',
 GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_REPOSITORY:'jlongguo/alex',
 GITHUB_JOB:'nav2-simulation',
 RUNNER_ENVIRONMENT:'self-hosted',
 GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/ros-sim-acceptance.yml@refs/heads/main',
 GITHUB_RUN_ID:RUN_ID,
 GITHUB_RUN_ATTEMPT:ATTEMPT,
 GITHUB_SHA:SHA,
 ALEX_ROS_ARTIFACT_ID:ARTIFACT_ID,
 ALEX_ROS_ARTIFACT_DIGEST:DIGEST
});

const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 env:{...process.env,...(env??{})}
});

async function temp(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r64-artifact-'));
 try{
  const folder=join(dir,'ros');
  const attestation=join(dir,'artifact-attestation.json');
  await mkdir(folder,{recursive:true});
  for(let i=0;i<FILES.length;i++){
   await writeFile(join(folder,FILES[i]),JSON.stringify({
    fixture:'r64-structure-only',index:i,file:FILES[i]
   })+'\n');
  }
  await fn({dir,folder,attestation});
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
}

function create(folder,attestation,env=actionsEnv()){
 return run('python3',[writer,'--folder',folder,'--out',attestation],env);
}
function verify(folder,attestation,args=[]){
 return run('python3',[
  verifier,
  '--attestation',attestation,
  '--folder',folder,
  '--artifact-id',ARTIFACT_ID,
  '--artifact-digest',DIGEST,
  '--run-id',RUN_ID,
  '--attempt',ATTEMPT,
  '--commit-sha',SHA,
  ...args
 ]);
}

test('R64 attestation 绑定 Artifact ID/Digest、Run/Attempt/SHA 与五份关键文件哈希',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  const made=create(folder,attestation);
  assert.equal(made.status,0,made.stderr);
  const data=JSON.parse(await readFile(attestation,'utf8'));
  assert.equal(data.schema,'alex.dev/ros-artifact-attestation/v1');
  assert.equal(data.status,'attested');
  assert.equal(data.source,'github-actions-upload-artifact');
  assert.equal(data.context.workflow_run_id,RUN_ID);
  assert.equal(data.context.workflow_run_attempt,2);
  assert.equal(data.context.commit_sha,SHA);
  assert.deepEqual(data.artifact,{
   name:'alex-ros-gazebo-acceptance',
   id:ARTIFACT_ID,
   digest_sha256:DIGEST,
   immutable:true
  });
  assert.equal(data.files.length,5);
  assert.deepEqual(data.files.map(x=>x.filename),FILES);
  assert.match(data.workflow_bundle_sha256,/^[0-9a-f]{64}$/);
  assert.equal(data.release_approved,false);
  assert.equal(data.physical_safety_certified,false);
  const checked=verify(folder,attestation);
  assert.equal(checked.status,0,checked.stderr);
 });
});

test('R66 R64 attestation verifier 接受 GitHub REST 的 sha256: Digest 表示',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  assert.equal(create(folder,attestation).status,0);
  const checked=run('python3',[
   verifier,'--attestation',attestation,'--folder',folder,
   '--artifact-id',ARTIFACT_ID,'--artifact-digest','sha256:'+DIGEST,
   '--run-id',RUN_ID,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
 });
});

test('R64 下载后的任何关键证据被改写都必须破坏 attestation 校验',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  assert.equal(create(folder,attestation).status,0);
  for(const name of FILES){
   const original=await readFile(join(folder,name),'utf8');
   await writeFile(join(folder,name),original+' ');
   const checked=verify(folder,attestation);
   assert.equal(checked.status,1,name);
   assert.match(checked.stderr,/ARTIFACT_ATTESTATION_DOWNLOADED_FILE_MISMATCH/);
   await writeFile(join(folder,name),original);
   assert.equal(verify(folder,attestation).status,0,name);
  }
 });
});

test('R64 Artifact 外部元数据任一不匹配都 fail closed',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  assert.equal(create(folder,attestation).status,0);
  const mutations=[
   ['--artifact-id','999999999'],
   ['--artifact-digest','b'.repeat(64)],
   ['--run-id','111111111'],
   ['--attempt','3'],
   ['--commit-sha','f'.repeat(40)]
  ];
  for(const pair of mutations){
   const args=[
    verifier,'--attestation',attestation,'--folder',folder,
    '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
    '--run-id',RUN_ID,'--attempt',ATTEMPT,'--commit-sha',SHA
   ];
   const key=args.indexOf(pair[0]);
   args[key+1]=pair[1];
   const checked=run('python3',args);
   assert.equal(checked.status,1,pair[0]);
  }
 });
});

test('R64 生成器只接受指定 workflow_dispatch、自托管 job 与合法 Artifact 输出',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  const patches=[
   {GITHUB_ACTIONS:'false'},
   {GITHUB_EVENT_NAME:'pull_request'},
   {GITHUB_REPOSITORY:'other/alex'},
   {GITHUB_JOB:'other-job'},
   {RUNNER_ENVIRONMENT:'github-hosted'},
   {GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/ci.yml@refs/heads/main'},
   {GITHUB_RUN_ID:'0'},
   {GITHUB_RUN_ATTEMPT:'0'},
   {GITHUB_SHA:'bad'},
   {ALEX_ROS_ARTIFACT_ID:'0'},
   {ALEX_ROS_ARTIFACT_DIGEST:'bad'}
  ];
  for(const patch of patches){
   const result=create(folder,attestation,{...actionsEnv(),...patch});
   assert.equal(result.status,1,JSON.stringify(patch));
  }
 });
});

test('R64 关键文件使用软链接或缺失时不得生成或验证证明',{timeout:15000},async()=>{
 await temp(async({folder,attestation,dir})=>{
  const target=join(folder,'bridge-acceptance-report.json');
  const original=await readFile(target,'utf8');
  await rm(target);
  await symlink(join(folder,'acceptance-report.json'),target);
  const made=create(folder,attestation);
  assert.equal(made.status,1);
  assert.match(made.stderr,/ARTIFACT_ATTESTATION_FILE_MISSING_OR_SYMLINK/);

  await rm(target);
  await writeFile(target,original);
  assert.equal(create(folder,attestation).status,0);
  await rm(join(folder,'workflow-evidence-bundle.json'));
  const checked=verify(folder,attestation);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/ARTIFACT_ATTESTATION_FILE_MISSING_OR_SYMLINK/);
 });
});

test('R64 Runtime Gate 只有完整 GitHub 外部元数据才能解除 Artifact attestation 缺口',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  assert.equal(create(folder,attestation).status,0);
  const checked=run('python3',[
   gate,
   '--ros-artifact-attestation',attestation,
   '--ros-artifact-folder',folder,
   '--ros-artifact-id',ARTIFACT_ID,
   '--ros-artifact-digest',DIGEST,
   '--ros-artifact-run-id',RUN_ID,
   '--ros-artifact-attempt',ATTEMPT,
   '--ros-artifact-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  const data=JSON.parse(checked.stdout);
  assert.equal(data.ros_artifact_attestation,'verified-metadata');
  assert.ok(!data.remaining.includes('GAZEBO_ACTIONS_ARTIFACT_ATTESTATION'));
  assert.ok(data.remaining.includes('GAZEBO_NAV2_THREE_LEG_RUNTIME'));
  assert.ok(data.remaining.includes('GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME'));
  assert.ok(data.remaining.includes('GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE'));
  assert.ok(data.remaining.includes('PHYSICAL_SAFETY_REVIEW'));
  assert.equal(data.release_approved,false);

  const partial=run('python3',[
   gate,'--ros-artifact-attestation',attestation,'--ros-artifact-folder',folder
  ]);
  assert.equal(partial.status,2);
  assert.match(partial.stderr,/ROS_ARTIFACT_ATTESTATION_METADATA_REQUIRED_TOGETHER/);
 });
});

test('R64 Runtime Gate 对错误 Artifact Digest 显式 blocked，而不是忽略证明',{timeout:15000},async()=>{
 await temp(async({folder,attestation})=>{
  assert.equal(create(folder,attestation).status,0);
  const checked=run('python3',[
   gate,
   '--ros-artifact-attestation',attestation,
   '--ros-artifact-folder',folder,
   '--ros-artifact-id',ARTIFACT_ID,
   '--ros-artifact-digest','b'.repeat(64),
   '--ros-artifact-run-id',RUN_ID,
   '--ros-artifact-attempt',ATTEMPT,
   '--ros-artifact-sha',SHA
  ]);
  assert.equal(checked.status,1,checked.stderr);
  const data=JSON.parse(checked.stdout);
  assert.equal(data.ros_artifact_attestation,'invalid');
  assert.equal(data.status,'blocked');
 });
});

test('R64 Workflow 先上传 immutable evidence，再生成证明并单独上传 attestation',{timeout:15000},async()=>{
 const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
 const evidence=workflow.indexOf('id: ros_evidence_upload');
 const createIndex=workflow.indexOf('write-ros-artifact-attestation.py');
 const verifyIndex=workflow.indexOf('verify-ros-artifact-attestation.py');
 const attestationUpload=workflow.indexOf('name: alex-ros-gazebo-attestation');
 assert.ok(evidence>=0);
 assert.ok(createIndex>evidence);
 assert.ok(verifyIndex>createIndex);
 assert.ok(attestationUpload>verifyIndex);
 assert.match(workflow,/steps\.ros_evidence_upload\.outputs\.artifact-id/);
 assert.match(workflow,/steps\.ros_evidence_upload\.outputs\.artifact-digest/);
 assert.equal((workflow.match(/uses: actions\/upload-artifact@v4/g)||[]).length,2);
 assert.equal((workflow.match(/include-hidden-files: true/g)||[]).length,2,
  '.local/ros 位于隐藏目录，两个 Artifact 都必须显式允许固定清单中的隐藏路径');
 assert.doesNotMatch(workflow,/actions\/upload-artifact@v[56789]/);
});
