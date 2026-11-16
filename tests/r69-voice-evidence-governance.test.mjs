import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const workflowEvidence=join(root,'scripts/voice-workflow-evidence.py');
const writer=join(root,'scripts/write-voice-artifact-attestation.py');
const attestationVerifier=join(root,'scripts/verify-voice-artifact-attestation.py');
const setVerifier=join(root,'scripts/verify-voice-evidence-set.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const actionsDriver=join(root,'tests/fixtures/r69-voice-actions-driver.py');

const VOICE_RUN='66666666-6666-4666-8666-666666666666';
const WORKFLOW_RUN='876543210';
const ATTEMPT='2';
const SHA='0123456789abcdef0123456789abcdef01234567';
const ARTIFACT_ID='111111111';
const DIGEST='a'.repeat(64);

const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:20000,
 env:{...process.env,...(env??{})}
});

const actionsEnv=()=>({
 GITHUB_ACTIONS:'true',
 GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_REPOSITORY:'jlongguo/alex',
 GITHUB_JOB:'voice-provider',
 RUNNER_ENVIRONMENT:'github-hosted',
 GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/voice-provider-acceptance.yml@refs/heads/main',
 GITHUB_RUN_ID:WORKFLOW_RUN,
 GITHUB_RUN_ATTEMPT:ATTEMPT,
 GITHUB_SHA:SHA,
 ALEX_VOICE_ARTIFACT_ID:ARTIFACT_ID,
 ALEX_VOICE_ARTIFACT_DIGEST:DIGEST
});

function validReal(runId=VOICE_RUN){
 return {
  schema:'alex.dev/voice-runtime-acceptance/v1',
  run_id:runId,status:'passed',provider_mode:'real',
  input:{source:'synthetic-provider-tts',acoustic_capture_verified:false},
  checks:[
   'https_seed_tts','https_asr','https_llm_stream',
   'https_pcm_tts','provider_revocation','provider_usage_aggregate'
  ],
  stages:{
   seed_tts:{status:'pass',elapsed_ms:10,audio_bytes:256},
   asr:{status:'pass',elapsed_ms:20,transcript_chars:30,seed_match:true},
   llm:{status:'pass',elapsed_ms:30,reply_chars:20,streamed_chars:20},
   tts:{status:'pass',elapsed_ms:40,response_bytes:7200,frames:2},
   revocation:{status:'pass',elapsed_ms:50,provider_session_cancelled:true,
    stale_session_blocked:true}
  },
  usage:{requests:2,completed:1,cancelled:1,failed:0,inflight:0,
   response_bytes:7200,response_samples:3600,frames:2,
   measurement:'provider-response-pcm-not-invoice'},
  provider_calls:{seed_tts:1,asr:1,llm_stream:1,streaming_tts:2},
  privacy:{raw_audio_stored:false,transcript_stored:false,
   response_text_stored:false,credentials_stored:false},
  release_approved:false,physical_safety_certified:false
 };
}

async function temp(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r69-voice-'));
 try{return await fn(dir);}
 finally{await rm(dir,{recursive:true,force:true});}
}

function driver(kind,scenario){
 return run('python3',[actionsDriver,kind,scenario]);
}

async function createSet(base,{workflowRun=WORKFLOW_RUN,attempt=ATTEMPT,sha=SHA}={}){
 const folder=join(base,'voice');
 await mkdir(folder,{recursive:true});
 const runtime=join(folder,'runtime-report.json');
 const workflow=join(folder,'workflow-evidence.json');
 const attestation=join(folder,'artifact-attestation.json');
 const readback=join(folder,'github-actions-readback.json');
 const env={...actionsEnv(),
  GITHUB_RUN_ID:String(workflowRun),GITHUB_RUN_ATTEMPT:String(attempt),GITHUB_SHA:sha};

 let checked=run('python3',[workflowEvidence,'--reset','--out',workflow,'--report',runtime],env);
 assert.equal(checked.status,0,checked.stderr);
 await writeFile(runtime,JSON.stringify(validReal())+'\n');
 checked=run('python3',[workflowEvidence,'--collect','--out',workflow,'--report',runtime],env);
 assert.equal(checked.status,0,checked.stderr);
 checked=run('python3',[
  workflowEvidence,'--verify','--out',workflow,'--report',runtime,
  '--expect-run-id',String(workflowRun),'--expect-attempt',String(attempt),
  '--expect-sha',sha
 ],env);
 assert.equal(checked.status,0,checked.stderr);

 const readbackResult=driver('readback','success');
 assert.equal(readbackResult.status,0,readbackResult.stderr);
 const readbackDoc=JSON.parse(readbackResult.stdout);
 delete readbackDoc._test_artifact_fetches;
 if(String(workflowRun)!==WORKFLOW_RUN||String(attempt)!==ATTEMPT||sha!==SHA){
  readbackDoc.context.id=String(workflowRun);
  readbackDoc.context.attempt=Number(attempt);
  readbackDoc.context.commit_sha=sha;
  readbackDoc.context.workflow_ref='jlongguo/alex/.github/workflows/voice-provider-acceptance.yml@refs/heads/main';
 }
 await writeFile(readback,JSON.stringify(readbackDoc)+'\n');

 checked=run('python3',[writer,'--folder',folder,'--out',attestation],env);
 assert.equal(checked.status,0,checked.stderr);
 checked=run('python3',[
  attestationVerifier,'--attestation',attestation,'--folder',folder,
  '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
  '--run-id',String(workflowRun),'--attempt',String(attempt),'--commit-sha',sha
 ]);
 assert.equal(checked.status,0,checked.stderr);

 return {folder,runtime,workflow,attestation,readback,
  workflowRun:String(workflowRun),attempt:Number(attempt),sha};
}

function verifySet(set,overrides={}){
 return run('python3',[
  setVerifier,
  '--folder',overrides.folder??set.folder,
  '--attestation',overrides.attestation??set.attestation,
  '--github-readback',overrides.readback??set.readback,
  '--artifact-id',overrides.artifactId??ARTIFACT_ID,
  '--artifact-digest',overrides.digest??DIGEST,
  '--run-id',overrides.workflowRun??set.workflowRun,
  '--attempt',String(overrides.attempt??set.attempt),
  '--commit-sha',overrides.sha??set.sha
 ]);
}

test('R69 workflow evidence 绑定真实 Voice report 的 Run/Attempt/SHA、run_id 与文件哈希',{timeout:20000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'voice');
  await mkdir(folder,{recursive:true});
  const runtime=join(folder,'runtime-report.json');
  const evidence=join(folder,'workflow-evidence.json');
  const env=actionsEnv();
  let checked=run('python3',[workflowEvidence,'--reset','--out',evidence,'--report',runtime],env);
  assert.equal(checked.status,0,checked.stderr);
  await writeFile(runtime,JSON.stringify(validReal())+'\n');
  checked=run('python3',[workflowEvidence,'--collect','--out',evidence,'--report',runtime],env);
  assert.equal(checked.status,0,checked.stderr);
  const doc=JSON.parse(await readFile(evidence,'utf8'));
  assert.equal(doc.schema,'alex.dev/voice-workflow-evidence/v1');
  assert.equal(doc.status,'assembled');
  assert.equal(doc.context.workflow_run_id,WORKFLOW_RUN);
  assert.equal(doc.context.workflow_run_attempt,2);
  assert.equal(doc.context.commit_sha,SHA);
  assert.equal(doc.report.run_id,VOICE_RUN);
  assert.match(doc.report.sha256,/^[0-9a-f]{64}$/);
  assert.equal(doc.release_approved,false);

  checked=run('python3',[
   workflowEvidence,'--verify','--out',evidence,'--report',runtime,
   '--expect-run-id',WORKFLOW_RUN,'--expect-attempt',ATTEMPT,'--expect-sha',SHA
  ],env);
  assert.equal(checked.status,0,checked.stderr);

  const altered=validReal();
  altered.stages.tts.elapsed_ms=41;
  await writeFile(runtime,JSON.stringify(altered)+'\n');
  checked=run('python3',[
   workflowEvidence,'--verify','--out',evidence,'--report',runtime,
   '--expect-run-id',WORKFLOW_RUN,'--expect-attempt',ATTEMPT,'--expect-sha',SHA
  ],env);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/VOICE_EVIDENCE_REPORT_HASH_OR_RUN_MISMATCH/);
 });
});

test('R69 workflow reset 后禁止复用旧 Voice PASS 报告',{timeout:20000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'voice');
  await mkdir(folder,{recursive:true});
  const runtime=join(folder,'runtime-report.json');
  const evidence=join(folder,'workflow-evidence.json');
  await writeFile(runtime,JSON.stringify(validReal())+'\n');
  const reset=run('python3',[workflowEvidence,'--reset','--out',evidence,'--report',runtime],actionsEnv());
  assert.equal(reset.status,0,reset.stderr);
  const collect=run('python3',[workflowEvidence,'--collect','--out',evidence,'--report',runtime],actionsEnv());
  assert.equal(collect.status,1);
  assert.match(collect.stderr,/VOICE_EVIDENCE_STALE_RUNTIME_REPORT/);
 });
});

test('R69 Artifact attestation 绑定主 Artifact ID/Digest 与两份关键 Voice 文件',{timeout:20000},async()=>{
 await temp(async dir=>{
  const set=await createSet(dir);
  const doc=JSON.parse(await readFile(set.attestation,'utf8'));
  assert.equal(doc.schema,'alex.dev/voice-artifact-attestation/v1');
  assert.equal(doc.artifact.id,ARTIFACT_ID);
  assert.equal(doc.artifact.digest_sha256,DIGEST);
  assert.deepEqual(doc.files.map(x=>x.filename),[
   'runtime-report.json','workflow-evidence.json'
  ]);
  const original=await readFile(set.runtime,'utf8');
  await writeFile(set.runtime,original+' ');
  const checked=run('python3',[
   attestationVerifier,'--attestation',set.attestation,'--folder',set.folder,
   '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
   '--run-id',WORKFLOW_RUN,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/VOICE_ATTESTATION_DOWNLOADED_FILE_MISMATCH/);
 });
});

test('R69 GitHub readback 精确按当前 Artifact ID 核验 Digest/Run，允许历史同名 Artifact',{timeout:20000},()=>{
 let result=driver('readback','success');
 assert.equal(result.status,0,result.stderr);
 let data=JSON.parse(result.stdout);
 assert.equal(data.artifact.id,ARTIFACT_ID);
 assert.equal(data.artifact.digest_sha256,DIGEST);

 result=driver('readback','historical-same-name');
 assert.equal(result.status,0,result.stderr);

 for(const [scenario,code] of [
  ['wrong-digest','VOICE_READBACK_ARTIFACT_DIGEST_MISMATCH'],
  ['expired','VOICE_READBACK_ARTIFACT_EXPIRED'],
  ['wrong-run','VOICE_READBACK_ARTIFACT_RUN_MISMATCH'],
  ['wrong-context','VOICE_READBACK_UNAPPROVED_CONTEXT']
 ]){
  result=driver('readback',scenario);
  assert.equal(result.status,1,scenario);
  assert.match(result.stderr,new RegExp(code),scenario);
 }
 result=driver('readback','propagation-delay');
 assert.equal(result.status,0,result.stderr);
 data=JSON.parse(result.stdout);
 assert.equal(data._test_artifact_fetches,2);
});

test('R69 final publication audit 核验 producer success 与双 Artifact，传播延迟有界重读',{timeout:20000},()=>{
 let result=driver('publication','success');
 assert.equal(result.status,0,result.stderr);
 let data=JSON.parse(result.stdout);
 assert.equal(data.jobs.producer.conclusion,'success');
 assert.ok(data.jobs.producer.labels.includes('ubuntu-latest'));
 assert.equal(data.artifacts.evidence.id,ARTIFACT_ID);
 assert.equal(data.artifacts.attestation.id,'222222222');

 result=driver('publication','historical-same-name');
 assert.equal(result.status,0,result.stderr);

 for(const [scenario,code] of [
  ['wrong-attest-digest','VOICE_PUBLICATION_ARTIFACT_DIGEST_MISMATCH'],
  ['producer-failed','VOICE_PUBLICATION_PRODUCER_NOT_SUCCESSFUL'],
  ['producer-labels','VOICE_PUBLICATION_PRODUCER_LABELS_MISMATCH'],
  ['auditor-labels','VOICE_PUBLICATION_AUDITOR_LABELS_MISMATCH'],
  ['job-order','VOICE_PUBLICATION_JOB_ORDER_INVALID'],
  ['same-ids','VOICE_PUBLICATION_ARTIFACT_IDS_REUSED'],
  ['wrong-context','VOICE_PUBLICATION_UNAPPROVED_CONTEXT']
 ]){
  result=driver('publication',scenario);
  assert.equal(result.status,1,scenario);
  assert.match(result.stderr,new RegExp(code),scenario);
 }

 result=driver('publication','propagation-delay');
 assert.equal(result.status,0,result.stderr);
 data=JSON.parse(result.stdout);
 assert.equal(data._test_artifact_fetches,2);

 result=driver('publication','jobs-delay');
 assert.equal(result.status,0,result.stderr);
 data=JSON.parse(result.stdout);
 assert.equal(data._test_job_fetches,2);
});

test('R69 coherent Voice set 统一通过，跨 Run/Commit/文件替换全部拒绝',{timeout:30000},async()=>{
 await temp(async dir=>{
  const set=await createSet(dir);
  let checked=verifySet(set);
  assert.equal(checked.status,0,checked.stderr);
  assert.match(checked.stdout,/coherently verified/);

  checked=verifySet(set,{workflowRun:'999999999'});
  assert.equal(checked.status,1);

  checked=verifySet(set,{sha:'f'.repeat(40)});
  assert.equal(checked.status,1);

  const original=await readFile(set.runtime,'utf8');
  const changed=validReal();
  changed.stages.llm.elapsed_ms=31;
  await writeFile(set.runtime,JSON.stringify(changed)+'\n');
  checked=verifySet(set);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/VOICE_EVIDENCE_|VOICE_ATTESTATION_/);
  await writeFile(set.runtime,original);
 });
});

test('R69 Runtime Gate 单报告只解除 provider E2E；coherent set 才解除 Voice 治理门槛',{timeout:30000},async()=>{
 await temp(async dir=>{
  const standalone=join(dir,'standalone.json');
  await writeFile(standalone,JSON.stringify(validReal()));
  let checked=run('python3',[
   gate,'--voice-report',standalone,'--voice-run-id',VOICE_RUN
  ]);
  assert.equal(checked.status,0,checked.stderr);
  let data=JSON.parse(checked.stdout);
  assert.equal(data.voice_real_provider,'verified');
  assert.ok(!data.remaining.includes('REAL_ASR_LLM_TTS_PROVIDER_E2E'));
  for(const item of [
   'VOICE_PROVIDER_WORKFLOW_EVIDENCE',
   'VOICE_ACTIONS_ARTIFACT_ATTESTATION',
   'VOICE_PROVIDER_COHERENT_EVIDENCE_SET',
   'VOICE_GITHUB_ACTIONS_READBACK_AUDIT'
  ])assert.ok(data.remaining.includes(item),item);

  const set=await createSet(join(dir,'set'));
  checked=run('python3',[
   gate,
   '--voice-evidence-folder',set.folder,
   '--voice-evidence-attestation',set.attestation,
   '--voice-evidence-github-readback',set.readback,
   '--voice-evidence-artifact-id',ARTIFACT_ID,
   '--voice-evidence-artifact-digest',DIGEST,
   '--voice-evidence-run-id',WORKFLOW_RUN,
   '--voice-evidence-attempt',ATTEMPT,
   '--voice-evidence-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  data=JSON.parse(checked.stdout);
  assert.equal(data.voice_real_provider,'verified-by-set');
  assert.equal(data.voice_workflow_evidence,'verified-by-set');
  assert.equal(data.voice_artifact_attestation,'verified-by-set');
  assert.equal(data.voice_github_readback,'verified-by-set');
  assert.equal(data.voice_evidence_set,'verified-coherent');
  assert.deepEqual(data.subjects.voice,{
   run_id:WORKFLOW_RUN,attempt:Number(ATTEMPT),commit_sha:SHA
  });
  for(const item of [
   'REAL_ASR_LLM_TTS_PROVIDER_E2E',
   'VOICE_PROVIDER_WORKFLOW_EVIDENCE',
   'VOICE_ACTIONS_ARTIFACT_ATTESTATION',
   'VOICE_PROVIDER_COHERENT_EVIDENCE_SET',
   'VOICE_GITHUB_ACTIONS_READBACK_AUDIT'
  ])assert.ok(!data.remaining.includes(item),item);
  assert.ok(data.remaining.includes('PHYSICAL_SAFETY_REVIEW'));
  assert.equal(data.release_approved,false);

  const mixed=run('python3',[
   gate,
   '--voice-report',standalone,'--voice-run-id',VOICE_RUN,
   '--voice-evidence-folder',set.folder,
   '--voice-evidence-attestation',set.attestation,
   '--voice-evidence-github-readback',set.readback,
   '--voice-evidence-artifact-id',ARTIFACT_ID,
   '--voice-evidence-artifact-digest',DIGEST,
   '--voice-evidence-run-id',WORKFLOW_RUN,
   '--voice-evidence-attempt',ATTEMPT,
   '--voice-evidence-sha',SHA
  ]);
  assert.equal(mixed.status,2);
  assert.match(mixed.stderr,/VOICE_EVIDENCE_SET_CANNOT_MIX_INDIVIDUAL_VOICE_ARGS/);
 });
});

test('R69 Voice Workflow fail closed、两次 immutable upload、隐藏 .local 文件显式允许，最终审计不上传第三份证明',{timeout:15000},async()=>{
 const workflow=await readFile(join(root,'.github/workflows/voice-provider-acceptance.yml'),'utf8');
 const approval=workflow.indexOf('approval-gate:');
 const producer=workflow.indexOf('voice-provider:');
 const reset=workflow.indexOf('voice-workflow-evidence.py --reset');
 const accept=workflow.indexOf('npm run voice:accept');
 const collect=workflow.indexOf('voice-workflow-evidence.py --collect');
 const mainUpload=workflow.indexOf('id: voice_evidence_upload');
 const readback=workflow.indexOf('github-actions-voice-readback.py --audit');
 const attest=workflow.indexOf('write-voice-artifact-attestation.py');
 const secondUpload=workflow.indexOf('id: voice_attestation_upload');
 const finalAudit=workflow.indexOf('publication-audit:');
 assert.ok(approval>=0);
 assert.ok(producer>approval);
 assert.ok(reset>producer);
 assert.ok(accept>reset);
 assert.ok(collect>accept);
 assert.ok(mainUpload>collect);
 assert.ok(readback>mainUpload);
 assert.ok(attest>readback);
 assert.ok(secondUpload>attest);
 assert.ok(finalAudit>secondUpload);
 assert.match(workflow,/ALEX_VOICE_ACCEPTANCE_APPROVED is not true; refusing to consume provider quota/);
 assert.match(workflow,/voice-provider:[\s\S]*needs: approval-gate/);
 assert.match(workflow,/publication-audit:[\s\S]*needs: voice-provider/);
 assert.equal((workflow.match(/uses: actions\/upload-artifact@[0-9a-f]{40}/g)||[]).length,2);
 assert.equal((workflow.match(/include-hidden-files: true/g)||[]).length,2);
 assert.doesNotMatch(workflow,/if: \$\{\{ vars\.ALEX_VOICE_ACCEPTANCE_APPROVED/);
});

test('R69 GitHub API 审计代码只使用 GET，且 Token 不进入可序列化结果',{timeout:15000},async()=>{
 for(const path of [
  join(root,'scripts/github-actions-voice-readback.py'),
  join(root,'scripts/github-actions-voice-publication-audit.py')
 ]){
  const source=await readFile(path,'utf8');
  assert.doesNotMatch(source,/method=['"]POST['"]|method=['"]PUT['"]|method=['"]PATCH['"]|method=['"]DELETE['"]/);
  assert.doesNotMatch(source,/['"]token['"]\s*:/);
  assert.doesNotMatch(source,/print\([^\n]*GITHUB_TOKEN/);
 }
});
