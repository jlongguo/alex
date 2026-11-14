import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const driver=join(root,'tests/fixtures/r66-github-readback-driver.py');
const readback=join(root,'scripts/github-actions-ros-readback.py');
const DIGEST='a'.repeat(64);
const RUN='987654321';
const SHA='0123456789abcdef0123456789abcdef01234567';

const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 env:{...process.env,...(env??{})}
});
const scenario=name=>run('python3',[driver,name]);

test('R66 真实 GitHub REST 数据形状可生成只读 readback，并规范化 sha256: Digest',{timeout:15000},()=>{
 const result=scenario('success');
 assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout);
 assert.equal(data.schema,'alex.dev/github-actions-ros-readback/v1');
 assert.equal(data.status,'verified');
 assert.equal(data.source,'github-rest-api-actions-read');
 assert.equal(data.read_only,true);
 assert.equal(data.context.id,RUN);
 assert.equal(data.context.attempt,2);
 assert.equal(data.context.commit_sha,SHA);
 assert.equal(data.context.event,'workflow_dispatch');
 assert.equal(data.context.status_at_readback,'in_progress');
 assert.equal(data.artifact.id,'123456789');
 assert.equal(data.artifact.digest_sha256,DIGEST);
 assert.equal(data.artifact.api_digest,'sha256:'+DIGEST);
 assert.equal(data.artifact.expired,false);
 assert.equal(data.api.actions_permission,'read');
 assert.equal(data._test_artifact_fetches,1);
 assert.equal(data.release_approved,false);
 assert.equal(data.physical_safety_certified,false);
});

test('R66 Artifact 列表短暂未传播时只做有界重读，并在第三次出现后通过',{timeout:15000},()=>{
 const result=scenario('propagation-delay');
 assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout);
 assert.equal(data._test_artifact_fetches,3);
 assert.equal(data.artifact.digest_sha256,DIGEST);
});

test('R66 Run/Workflow 上下文错误必须立即 fail closed',{timeout:15000},()=>{
 const cases=[
  ['wrong-run','GITHUB_READBACK_RUN_CONTEXT_MISMATCH'],
  ['wrong-attempt','GITHUB_READBACK_RUN_CONTEXT_MISMATCH'],
  ['wrong-sha','GITHUB_READBACK_RUN_CONTEXT_MISMATCH'],
  ['wrong-event','GITHUB_READBACK_WORKFLOW_MISMATCH'],
  ['wrong-workflow','GITHUB_READBACK_WORKFLOW_MISMATCH'],
  ['completed-failure','GITHUB_READBACK_RUN_NOT_SUCCESSFUL'],
  ['missing-token','GITHUB_READBACK_TOKEN_MISSING'],
  ['wrong-context','GITHUB_READBACK_UNAPPROVED_CONTEXT']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R66 Artifact 过期、Digest 错误、重复名称或归属错误全部拒绝',{timeout:15000},()=>{
 const cases=[
  ['expired','GITHUB_READBACK_ARTIFACT_EXPIRED'],
  ['wrong-digest','GITHUB_READBACK_ARTIFACT_DIGEST_MISMATCH'],
  ['duplicate','GITHUB_READBACK_ARTIFACT_NOT_UNIQUE'],
  ['wrong-artifact-run','GITHUB_READBACK_ARTIFACT_RUN_MISMATCH']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R66 离线 report verifier 同时接受 action 纯 hex 与 REST sha256:hex 输入',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r66-readback-'));
 try{
  const generated=scenario('success');
  assert.equal(generated.status,0,generated.stderr);
  const doc=JSON.parse(generated.stdout);
  delete doc._test_artifact_fetches;
  const report=join(dir,'readback.json');
  await writeFile(report,JSON.stringify(doc));

  for(const digest of [DIGEST,'sha256:'+DIGEST]){
   const checked=run('python3',[
    readback,'--verify','--report',report,
    '--artifact-id','123456789','--artifact-digest',digest,
    '--run-id',RUN,'--attempt','2','--commit-sha',SHA
   ]);
   assert.equal(checked.status,0,checked.stderr);
  }
  const wrong=run('python3',[
   readback,'--verify','--report',report,
   '--artifact-id','123456789','--artifact-digest','sha256:'+('b'.repeat(64)),
   '--run-id',RUN,'--attempt','2','--commit-sha',SHA
  ]);
  assert.equal(wrong.status,1);
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});

test('R66 手动 ROS Workflow 只授予 actions:read，并在 attestation 前完成 API readback',{timeout:15000},async()=>{
 const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
 const upload=workflow.indexOf('id: ros_evidence_upload');
 const audit=workflow.indexOf('github-actions-ros-readback.py --audit');
 const verify=workflow.indexOf('github-actions-ros-readback.py --verify');
 const attest=workflow.indexOf('write-ros-artifact-attestation.py');
 const setVerify=workflow.indexOf('verify-ros-evidence-set.py');
 const secondUpload=workflow.indexOf('name: alex-ros-gazebo-attestation');
 assert.match(workflow,/permissions:\n  contents: read\n  actions: read/);
 assert.ok(upload>=0);
 assert.ok(audit>upload);
 assert.ok(verify>audit);
 assert.ok(attest>verify);
 assert.ok(setVerify>attest);
 assert.ok(secondUpload>setVerify);
 assert.match(workflow,/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
 assert.match(workflow,/--github-readback \.local\/ros\/github-actions-readback\.json/);
 assert.match(workflow,/\.local\/ros\/github-actions-readback\.json/);
 assert.doesNotMatch(workflow,/actions: write/);
});

test('R66 默认 PR CI 不执行 GitHub REST readback，避免把普通测试变成网络依赖',{timeout:15000},async()=>{
 const ci=await readFile(join(root,'.github/workflows/ci.yml'),'utf8');
 assert.doesNotMatch(ci,/github-actions-ros-readback/);
 const source=await readFile(readback,'utf8');
 assert.match(source,/method='GET'/);
 assert.match(source,/https:\/\/api\.github\.com/);
 assert.doesNotMatch(source,/method='POST'|method='PUT'|method='PATCH'|method='DELETE'/);
 assert.doesNotMatch(source,/print\([^\n]*GITHUB_TOKEN/);
});
