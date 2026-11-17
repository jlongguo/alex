import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const writer=join(root,'scripts/write-acoustic-artifact-attestation.py');
const attestationVerifier=join(root,'scripts/verify-acoustic-artifact-attestation.py');
const setVerifier=join(root,'scripts/verify-acoustic-evidence-set.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const actionsDriver=join(root,'tests/fixtures/r77-acoustic-actions-driver.py');

const RUN='876543210',ATTEMPT='2';
const SHA='0123456789abcdef0123456789abcdef01234567';
const ARTIFACT_ID='111111111',DIGEST='a'.repeat(64);
const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:20000,env:{...process.env,...(env??{})}
});
const canonical=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
};
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

function acousticReport(){
 const base={
  schema:'alex.dev/acoustic-io-acceptance/v1',status:'passed',
  mode:'real-alsa-physical-loop',
  context:{source:'github-actions-self-hosted',runId:RUN,attempt:2,commitSha:SHA,
   job:'acoustic-io',runnerFingerprintSha256:'d'.repeat(64)},
  devices:{captureFingerprintSha256:'b'.repeat(64),playbackFingerprintSha256:'c'.repeat(64),
   physicalPathApproved:true,rawIdentifiersStored:false},
  stimulus:{sampleRate:48000,channels:1,bitsPerSample:16,
   frequenciesHz:[731,1103,1667],durationMs:1800},
  capture:{pass:true,sampleRate:48000,channels:1,bitsPerSample:16,durationMs:4000,
   rms:0.08,peak:0.4,clippingRatio:0,
   tones:[731,1103,1667].map(f=>({frequencyHz:f,power:0.01,sidePower:0.001,
    ratio:10,detected:true}))},
  checks:['alsa_real_capture','alsa_real_playback','multi_tone_loop_detected',
   'physical_path_operator_approved','temporary_audio_deleted'],
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,
   deviceIdentifiersStored:false,credentialsStored:false},
  temporaryAudioDeleted:true,acousticCaptureVerified:true,speakerPlaybackVerified:true,
  releaseApproved:false,physicalSafetyCertified:false
 };
 return {...base,evidenceDigestSha256:digest(base)};
}
const env=()=>({
 GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_REPOSITORY:'jlongguo/alex',GITHUB_JOB:'acoustic-io',
 RUNNER_ENVIRONMENT:'self-hosted',
 GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/acoustic-io-acceptance.yml@refs/heads/main',
 GITHUB_RUN_ID:RUN,GITHUB_RUN_ATTEMPT:ATTEMPT,GITHUB_SHA:SHA,
 ALEX_ACOUSTIC_ARTIFACT_ID:ARTIFACT_ID,ALEX_ACOUSTIC_ARTIFACT_DIGEST:DIGEST
});
async function temp(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r77-acoustic-'));
 try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
function driver(kind,scenario){return run('python3',[actionsDriver,kind,scenario]);}

test('R77 Acoustic 证据脚本全部可被 Python 编译',()=>{
 const files=[
  'write-acoustic-artifact-attestation.py','verify-acoustic-artifact-attestation.py',
  'github-actions-acoustic-readback.py','verify-acoustic-evidence-set.py',
  'github-actions-acoustic-publication-audit.py'
 ].map(x=>join(root,'scripts',x));
 const checked=run('python3',['-m','py_compile',...files]);
 assert.equal(checked.status,0,checked.stderr);
});

test('R77 Attestation 只绑定 report.json 与 immutable Artifact 元数据',{timeout:20000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'acoustic');await mkdir(folder);
  const report=join(folder,'report.json'),attestation=join(folder,'artifact-attestation.json');
  await writeFile(report,JSON.stringify(acousticReport())+'\n');
  let checked=run('python3',[writer,'--folder',folder,'--out',attestation],env());
  assert.equal(checked.status,0,checked.stderr);
  const doc=JSON.parse(await readFile(attestation,'utf8'));
  assert.equal(doc.schema,'alex.dev/acoustic-artifact-attestation/v1');
  assert.deepEqual(doc.files.map(x=>x.filename),['report.json']);
  assert.equal(doc.artifact.id,ARTIFACT_ID);
  assert.equal(doc.artifact.digest_sha256,DIGEST);
  checked=run('python3',[
   attestationVerifier,'--attestation',attestation,'--folder',folder,
   '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  await writeFile(report,JSON.stringify({...acousticReport(),status:'failed'})+'\n');
  checked=run('python3',[
   attestationVerifier,'--attestation',attestation,'--folder',folder,
   '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/ACOUSTIC_ATTESTATION_DOWNLOADED_FILE_MISMATCH/);
 });
});

test('R77 GitHub readback 精确核对当前 Acoustic Artifact ID/Digest/Run',{timeout:20000},()=>{
 let result=driver('readback','success');
 assert.equal(result.status,0,result.stderr);
 let data=JSON.parse(result.stdout);
 assert.equal(data.artifact.id,ARTIFACT_ID);
 assert.equal(data.context.runner_environment,'self-hosted');
 for(const [scenario,code] of [
  ['wrong-digest','ACOUSTIC_READBACK_ARTIFACT_DIGEST_MISMATCH'],
  ['expired','ACOUSTIC_READBACK_ARTIFACT_EXPIRED'],
  ['wrong-run','ACOUSTIC_READBACK_ARTIFACT_RUN_MISMATCH'],
  ['wrong-context','ACOUSTIC_READBACK_UNAPPROVED_CONTEXT']
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

test('R77 publication audit 强制 producer 是 alex-acoustic self-hosted，auditor 是 GitHub-hosted',{timeout:20000},()=>{
 let result=driver('publication','success');
 assert.equal(result.status,0,result.stderr);
 let data=JSON.parse(result.stdout);
 assert.ok(data.jobs.producer.labels.includes('alex-acoustic'));
 assert.ok(data.jobs.producer.labels.includes('self-hosted'));
 assert.ok(data.jobs.auditor.labels.includes('ubuntu-latest'));
 for(const [scenario,code] of [
  ['wrong-attest-digest','ACOUSTIC_PUBLICATION_ARTIFACT_DIGEST_MISMATCH'],
  ['producer-failed','ACOUSTIC_PUBLICATION_PRODUCER_NOT_SUCCESSFUL'],
  ['producer-labels','ACOUSTIC_PUBLICATION_PRODUCER_LABELS_MISMATCH'],
  ['auditor-labels','ACOUSTIC_PUBLICATION_AUDITOR_LABELS_MISMATCH'],
  ['job-order','ACOUSTIC_PUBLICATION_JOB_ORDER_INVALID'],
  ['same-ids','ACOUSTIC_PUBLICATION_ARTIFACT_IDS_REUSED'],
  ['wrong-context','ACOUSTIC_PUBLICATION_UNAPPROVED_CONTEXT']
 ]){
  result=driver('publication',scenario);
  assert.equal(result.status,1,scenario);
  assert.match(result.stderr,new RegExp(code),scenario);
 }
});

test('R77 coherent set 拒绝跨 Commit 与被替换 report',{timeout:30000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'acoustic');await mkdir(folder);
  const report=join(folder,'report.json'),attestation=join(folder,'artifact-attestation.json');
  const readback=join(folder,'github-actions-readback.json');
  await writeFile(report,JSON.stringify(acousticReport())+'\n');
  let checked=run('python3',[writer,'--folder',folder,'--out',attestation],env());
  assert.equal(checked.status,0,checked.stderr);
  const readbackResult=driver('readback','success');
  assert.equal(readbackResult.status,0,readbackResult.stderr);
  const readbackDoc=JSON.parse(readbackResult.stdout);delete readbackDoc._test_artifact_fetches;
  await writeFile(readback,JSON.stringify(readbackDoc)+'\n');
  const verify=(sha=SHA)=>run('python3',[
   setVerifier,'--folder',folder,'--attestation',attestation,
   '--github-readback',readback,'--artifact-id',ARTIFACT_ID,
   '--artifact-digest',DIGEST,'--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',sha
  ]);
  checked=verify();assert.equal(checked.status,0,checked.stderr);
  checked=verify('f'.repeat(40));assert.equal(checked.status,1);
  const altered=acousticReport();altered.capture.rms=0.2;
  await writeFile(report,JSON.stringify(altered)+'\n');
  checked=verify();assert.equal(checked.status,1);
 });
});

test('R77 Acoustic workflow 双 Artifact + REST readback + 独立 publication audit，且不上传 WAV',{timeout:15000},async()=>{
 const source=await readFile(join(root,'.github/workflows/acoustic-io-acceptance.yml'),'utf8');
 const producer=source.indexOf('acoustic-io:');
 const mainUpload=source.indexOf('id: acoustic_evidence_upload');
 const readback=source.indexOf('github-actions-acoustic-readback.py --audit');
 const attest=source.indexOf('write-acoustic-artifact-attestation.py');
 const secondUpload=source.indexOf('id: acoustic_attestation_upload');
 const audit=source.indexOf('publication-audit:');
 assert.ok(producer>=0&&mainUpload>producer&&readback>mainUpload&&attest>readback&&
  secondUpload>attest&&audit>secondUpload);
 assert.match(source,/runs-on: \[self-hosted, linux, x64, alex-acoustic\]/);
 assert.match(source,/publication-audit:[\s\S]*runs-on: ubuntu-latest/);
 assert.equal((source.match(/uses: actions\/upload-artifact@[0-9a-f]{40}/g)||[]).length,2);
 assert.doesNotMatch(source,/\.wav\s*$/m);
 assert.doesNotMatch(source,/capture\.wav|stimulus\.wav/);
});


test('R77 Runtime Gate 只有 coherent Acoustic set 才解除四个 Acoustic 发布门槛',{timeout:30000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'acoustic');await mkdir(folder);
  const report=join(folder,'report.json');
  const attestation=join(folder,'artifact-attestation.json');
  const readback=join(folder,'github-actions-readback.json');
  await writeFile(report,JSON.stringify(acousticReport())+'\n');

  let checked=run('python3',[writer,'--folder',folder,'--out',attestation],env());
  assert.equal(checked.status,0,checked.stderr);
  const readbackResult=driver('readback','success');
  assert.equal(readbackResult.status,0,readbackResult.stderr);
  const readbackDoc=JSON.parse(readbackResult.stdout);delete readbackDoc._test_artifact_fetches;
  await writeFile(readback,JSON.stringify(readbackDoc)+'\n');

  checked=run('python3',[
   gate,
   '--acoustic-evidence-folder',folder,
   '--acoustic-evidence-attestation',attestation,
   '--acoustic-evidence-github-readback',readback,
   '--acoustic-evidence-artifact-id',ARTIFACT_ID,
   '--acoustic-evidence-artifact-digest',DIGEST,
   '--acoustic-evidence-run-id',RUN,
   '--acoustic-evidence-attempt',ATTEMPT,
   '--acoustic-evidence-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  const data=JSON.parse(checked.stdout);
  assert.equal(data.acoustic_io,'verified-by-set');
  assert.equal(data.acoustic_artifact_attestation,'verified-by-set');
  assert.equal(data.acoustic_evidence_set,'verified-coherent');
  assert.equal(data.acoustic_github_readback,'verified-by-set');
  assert.deepEqual(data.subjects.acoustic,{
   run_id:RUN,attempt:Number(ATTEMPT),commit_sha:SHA
  });
  for(const item of [
   'REAL_ACOUSTIC_IO','ACOUSTIC_ACTIONS_ARTIFACT_ATTESTATION',
   'ACOUSTIC_COHERENT_EVIDENCE_SET','ACOUSTIC_GITHUB_ACTIONS_READBACK_AUDIT'
  ])assert.ok(!data.remaining.includes(item),item);

  const mixed=run('python3',[
   gate,'--acoustic-report',report,'--acoustic-run-id',RUN,
   '--acoustic-evidence-folder',folder,
   '--acoustic-evidence-attestation',attestation,
   '--acoustic-evidence-github-readback',readback,
   '--acoustic-evidence-artifact-id',ARTIFACT_ID,
   '--acoustic-evidence-artifact-digest',DIGEST,
   '--acoustic-evidence-run-id',RUN,
   '--acoustic-evidence-attempt',ATTEMPT,
   '--acoustic-evidence-sha',SHA
  ]);
  assert.equal(mixed.status,2);
  assert.match(mixed.stderr,/ACOUSTIC_EVIDENCE_SET_CANNOT_MIX_INDIVIDUAL_ARGS/);
 });
});
