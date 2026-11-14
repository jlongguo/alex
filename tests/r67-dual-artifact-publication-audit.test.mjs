import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const driver=join(root,'tests/fixtures/r67-publication-audit-driver.py');
const audit=join(root,'scripts/github-actions-ros-publication-audit.py');
const RUN='987654321';
const ATTEMPT='3';
const SHA='0123456789abcdef0123456789abcdef01234567';
const MAIN_ID='111111111';
const ATTEST_ID='222222222';
const MAIN_DIGEST='a'.repeat(64);
const ATTEST_DIGEST='b'.repeat(64);

const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:15000,
 env:{...process.env,...(env??{})}
});
const scenario=name=>run('python3',[driver,name]);

test('R67 GitHub-hosted publication audit 同时核验 producer job 与双 Artifact',{timeout:15000},()=>{
 const result=scenario('success');
 assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout);
 assert.equal(data.schema,'alex.dev/github-actions-ros-publication-audit/v1');
 assert.equal(data.status,'verified');
 assert.equal(data.audit_runner,'github-hosted');
 assert.equal(data.closure_strategy,'post-producer-dual-artifact-rest-readback-no-third-artifact');
 assert.equal(data.context.id,RUN);
 assert.equal(data.context.attempt,3);
 assert.equal(data.context.commit_sha,SHA);
 assert.equal(data.jobs.producer.name,'nav2-simulation');
 assert.equal(data.jobs.producer.conclusion,'success');
 assert.ok(data.jobs.producer.labels.includes('alex-ros-sim'));
 assert.equal(data.jobs.auditor.name,'publication-audit');
 assert.equal(data.jobs.auditor.status,'in_progress');
 assert.equal(data.artifacts.evidence.id,MAIN_ID);
 assert.equal(data.artifacts.evidence.digest_sha256,MAIN_DIGEST);
 assert.equal(data.artifacts.attestation.id,ATTEST_ID);
 assert.equal(data.artifacts.attestation.digest_sha256,ATTEST_DIGEST);
 assert.equal(data._test_artifact_fetches,1);
 assert.equal(data._test_job_fetches,1);
 assert.equal(data.release_approved,false);
 assert.equal(data.physical_safety_certified,false);
});

test('R67 主 Artifact 或 attestation Artifact 的 Digest/归属/过期状态异常全部拒绝',{timeout:15000},()=>{
 const cases=[
  ['wrong-main-digest','PUBLICATION_AUDIT_ARTIFACT_DIGEST_MISMATCH'],
  ['wrong-attest-digest','PUBLICATION_AUDIT_ARTIFACT_DIGEST_MISMATCH'],
  ['expired-attestation','PUBLICATION_AUDIT_ARTIFACT_EXPIRED'],
  ['wrong-attestation-run','PUBLICATION_AUDIT_ARTIFACT_RUN_MISMATCH'],
  ['duplicate-attestation','PUBLICATION_AUDIT_ARTIFACT_NOT_UNIQUE'],
  ['same-artifact-ids','PUBLICATION_AUDIT_ARTIFACT_IDS_REUSED']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R67 producer job 必须已成功完成且具备完整 self-hosted 仿真 labels',{timeout:15000},()=>{
 const cases=[
  ['producer-failed','PUBLICATION_AUDIT_PRODUCER_NOT_SUCCESSFUL'],
  ['producer-labels','PUBLICATION_AUDIT_PRODUCER_LABELS_MISMATCH'],
  ['producer-runner-name','PUBLICATION_AUDIT_PRODUCER_RUNNER_NAME_MISSING'],
  ['wrong-attempt','PUBLICATION_AUDIT_PRODUCER_NOT_SUCCESSFUL'],
  ['job-order','PUBLICATION_AUDIT_JOB_ORDER_INVALID']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R67 审计 Job 必须是 GitHub-hosted ubuntu-latest 且正在当前 Attempt 执行',{timeout:15000},()=>{
 const cases=[
  ['auditor-status','PUBLICATION_AUDIT_AUDITOR_JOB_INVALID'],
  ['auditor-label','PUBLICATION_AUDIT_AUDITOR_LABELS_MISMATCH'],
  ['wrong-context','PUBLICATION_AUDIT_UNAPPROVED_CONTEXT']
 ];
 for(const [name,code] of cases){
  const result=scenario(name);
  assert.equal(result.status,1,name);
  assert.match(result.stderr,new RegExp(code),name);
 }
});

test('R67 仅对 Artifact/Jobs API 传播延迟做有界重读',{timeout:15000},()=>{
 const artifactDelay=scenario('artifact-propagation');
 assert.equal(artifactDelay.status,0,artifactDelay.stderr);
 const artifactData=JSON.parse(artifactDelay.stdout);
 assert.equal(artifactData._test_artifact_fetches,2);

 const jobsDelay=scenario('jobs-propagation');
 assert.equal(jobsDelay.status,0,jobsDelay.stderr);
 const jobsData=JSON.parse(jobsDelay.stdout);
 assert.equal(jobsData._test_job_fetches,2);
});

test('R67 离线 publication report verifier 绑定两个 Artifact ID/Digest 与 Run/Attempt/SHA',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r67-publication-'));
 try{
  const generated=scenario('success');
  assert.equal(generated.status,0,generated.stderr);
  const data=JSON.parse(generated.stdout);
  delete data._test_artifact_fetches;
  delete data._test_job_fetches;
  const report=join(dir,'publication-audit.json');
  await writeFile(report,JSON.stringify(data));

  const checked=run('python3',[
   audit,'--verify','--report',report,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA,
   '--main-artifact-id',MAIN_ID,'--main-artifact-digest','sha256:'+MAIN_DIGEST,
   '--attestation-artifact-id',ATTEST_ID,
   '--attestation-artifact-digest',ATTEST_DIGEST
  ]);
  assert.equal(checked.status,0,checked.stderr);

  const wrong=run('python3',[
   audit,'--verify','--report',report,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA,
   '--main-artifact-id',MAIN_ID,'--main-artifact-digest',MAIN_DIGEST,
   '--attestation-artifact-id',ATTEST_ID,
   '--attestation-artifact-digest','c'.repeat(64)
  ]);
  assert.equal(wrong.status,1);
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});

test('R67 Workflow 使用两个 Job，最终 GitHub-hosted audit 依赖 producer 成功且不创建第三个 Artifact',{timeout:15000},async()=>{
 const workflow=await readFile(join(root,'.github/workflows/ros-sim-acceptance.yml'),'utf8');
 const producer=workflow.indexOf('nav2-simulation:');
 const auditJob=workflow.indexOf('publication-audit:');
 const secondUpload=workflow.indexOf('id: ros_attestation_upload');
 const publicationRun=workflow.indexOf('github-actions-ros-publication-audit.py --audit');
 assert.ok(producer>=0);
 assert.ok(secondUpload>producer);
 assert.ok(auditJob>secondUpload);
 assert.ok(publicationRun>auditJob);
 assert.match(workflow,/approval-gate:/);
 assert.match(workflow,/ALEX_SIM_RUNNER_APPROVED is not true; refusing to schedule ROS acceptance/);
 assert.match(workflow,/nav2-simulation:[\s\S]*needs: approval-gate/);
 assert.match(workflow,/needs: nav2-simulation/);
 assert.match(workflow,/needs\.nav2-simulation\.result == 'success'/);
 assert.match(workflow,/runs-on: ubuntu-latest/);
 assert.match(workflow,/ALEX_ROS_ATTESTATION_ARTIFACT_ID: \$\{\{ needs\.nav2-simulation\.outputs\.attestation-artifact-id \}\}/);
 assert.match(workflow,/ALEX_ROS_ATTESTATION_ARTIFACT_DIGEST: \$\{\{ needs\.nav2-simulation\.outputs\.attestation-artifact-digest \}\}/);
 assert.equal((workflow.match(/uses: actions\/upload-artifact@v4/g)||[]).length,2,
  '最终审计不得再生成第三个证明 Artifact');
});

test('R67 publication audit 只允许 GitHub API GET，不把 token 写入报告或日志',{timeout:15000},async()=>{
 const source=await readFile(audit,'utf8');
 assert.doesNotMatch(source,/method=['"]POST['"]|method=['"]PUT['"]|method=['"]PATCH['"]|method=['"]DELETE['"]/);
 assert.doesNotMatch(source,/print\([^\n]*GITHUB_TOKEN/);
 assert.doesNotMatch(source,/['"]token['"]\s*:/);
 assert.match(source,/actions\/runs/);
 assert.match(source,/jobs\?filter=latest/);
 assert.match(source,/artifacts\?per_page=100/);
});
