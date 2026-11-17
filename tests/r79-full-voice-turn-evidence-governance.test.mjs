import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {FULL_VOICE_SEED_TEXT} from '../scripts/full-voice-turn-acceptance.mjs';

const root=resolve(import.meta.dirname,'..');
const writer=join(root,'scripts/write-full-voice-turn-artifact-attestation.py');
const attestationVerifier=join(root,'scripts/verify-full-voice-turn-artifact-attestation.py');
const setVerifier=join(root,'scripts/verify-full-voice-turn-evidence-set.py');
const gate=join(root,'scripts/runtime-acceptance-gate.py');
const actionsDriver=join(root,'tests/fixtures/r79-full-voice-turn-actions-driver.py');

const RUN='876543210',ATTEMPT='2';
const SHA='0123456789abcdef0123456789abcdef01234567';
const ARTIFACT_ID='111111111',DIGEST='a'.repeat(64);
const TURN='11111111-1111-4111-8111-111111111111';
const run=(command,args,env)=>spawnSync(command,args,{
 cwd:root,encoding:'utf8',timeout:25000,env:{...process.env,...(env??{})}
});
const canonical=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
};
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

function fullTurnReport(){
 const base={
  schema:'alex.dev/full-voice-turn-acceptance/v1',
  status:'passed',mode:'real-physical-provider-e2e',turnId:TURN,
  context:{source:'github-actions-self-hosted',runId:RUN,attempt:2,commitSha:SHA,
   job:'full-voice-turn',runnerFingerprintSha256:'d'.repeat(64)},
  devices:{captureFingerprintSha256:'b'.repeat(64),playbackFingerprintSha256:'c'.repeat(64),
   rawIdentifiersStored:false,physicalPathApproved:true},
  input:{source:'provider-seed-through-physical-speaker-mic',seedTextStored:false,
   seedTextSha256:createHash('sha256').update(FULL_VOICE_SEED_TEXT).digest('hex')},
  checks:['provider_seed_pcm_tts','physical_speaker_to_microphone_input',
   'provider_asr_from_physical_capture','provider_llm_stream',
   'provider_reply_pcm_tts','physical_reply_speaker_to_microphone_proof'],
  stages:{
   seed_tts:{status:'pass',pcmBytes:9600,frames:2},
   physical_input:{status:'pass',captureDurationMs:1000,rms:0.08,peak:0.3},
   asr:{status:'pass',transcriptChars:36,seedMatch:true},
   llm:{status:'pass',replyChars:24,streamedChars:24},
   reply_tts:{status:'pass',pcmBytes:9600,frames:2},
   physical_output:{status:'pass',captureDurationMs:1000,rms:0.07,peak:0.25}
  },
  latency:{seedTtsFirstPcmMs:10,seedTtsCompleteMs:20,physicalInputLoopMs:1000,
   asrMs:30,llmFirstTokenMs:40,llmCompleteMs:80,ttsFirstPcmMs:15,ttsCompleteMs:25,
   speakerPlaybackProofMs:1000,totalTurnMs:2200},
  privacy:{rawAudioStored:false,transcriptStored:false,responseTextStored:false,
   deviceIdentifiersStored:false,credentialsStored:false},
  temporaryAudioDeleted:true,releaseApproved:false,physicalSafetyCertified:false
 };
 return {...base,evidenceDigestSha256:digest(base)};
}
const env=()=>({
 GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',
 GITHUB_REPOSITORY:'jlongguo/alex',GITHUB_JOB:'full-voice-turn',
 RUNNER_ENVIRONMENT:'self-hosted',
 GITHUB_WORKFLOW_REF:'jlongguo/alex/.github/workflows/full-voice-turn-acceptance.yml@refs/heads/main',
 GITHUB_RUN_ID:RUN,GITHUB_RUN_ATTEMPT:ATTEMPT,GITHUB_SHA:SHA,
 ALEX_FULL_VOICE_TURN_ARTIFACT_ID:ARTIFACT_ID,
 ALEX_FULL_VOICE_TURN_ARTIFACT_DIGEST:DIGEST
});
async function temp(fn){
 const dir=await mkdtemp(join(tmpdir(),'alex-r79-full-turn-'));
 try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
function driver(kind,scenario){return run('python3',[actionsDriver,kind,scenario]);}

test('R79 Full Voice Turn 证据脚本全部可被 Python 编译',()=>{
 const files=[
  'write-full-voice-turn-artifact-attestation.py',
  'verify-full-voice-turn-artifact-attestation.py',
  'github-actions-full-voice-turn-readback.py',
  'verify-full-voice-turn-evidence-set.py',
  'github-actions-full-voice-turn-publication-audit.py'
 ].map(x=>join(root,'scripts',x));
 const checked=run('python3',['-m','py_compile',...files]);
 assert.equal(checked.status,0,checked.stderr);
});

test('R79 Attestation 只绑定 Full Voice Turn report 与 immutable Artifact 元数据',{timeout:20000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'full-turn');await mkdir(folder);
  const report=join(folder,'report.json'),attestation=join(folder,'artifact-attestation.json');
  await writeFile(report,JSON.stringify(fullTurnReport())+'\n');
  let checked=run('python3',[writer,'--folder',folder,'--out',attestation],env());
  assert.equal(checked.status,0,checked.stderr);
  const doc=JSON.parse(await readFile(attestation,'utf8'));
  assert.equal(doc.schema,'alex.dev/full-voice-turn-artifact-attestation/v1');
  assert.deepEqual(doc.files.map(x=>x.filename),['report.json']);
  assert.equal(doc.artifact.id,ARTIFACT_ID);
  assert.equal(doc.artifact.digest_sha256,DIGEST);
  checked=run('python3',[
   attestationVerifier,'--attestation',attestation,'--folder',folder,
   '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  const changed=fullTurnReport();changed.latency.totalTurnMs=9999;
  await writeFile(report,JSON.stringify(changed)+'\n');
  checked=run('python3',[
   attestationVerifier,'--attestation',attestation,'--folder',folder,
   '--artifact-id',ARTIFACT_ID,'--artifact-digest',DIGEST,
   '--run-id',RUN,'--attempt',ATTEMPT,'--commit-sha',SHA
  ]);
  assert.equal(checked.status,1);
  assert.match(checked.stderr,/FULL_VOICE_TURN_ATTESTATION_DOWNLOADED_FILE_MISMATCH/);
 });
});

test('R79 GitHub readback 精确核对当前 Full Voice Turn Artifact ID/Digest/Run',{timeout:20000},()=>{
 let result=driver('readback','success');
 assert.equal(result.status,0,result.stderr);
 let data=JSON.parse(result.stdout);
 assert.equal(data.artifact.id,ARTIFACT_ID);
 assert.equal(data.context.runner_environment,'self-hosted');
 for(const [scenario,code] of [
  ['wrong-digest','FULL_VOICE_TURN_READBACK_ARTIFACT_DIGEST_MISMATCH'],
  ['expired','FULL_VOICE_TURN_READBACK_ARTIFACT_EXPIRED'],
  ['wrong-run','FULL_VOICE_TURN_READBACK_ARTIFACT_RUN_MISMATCH'],
  ['wrong-context','FULL_VOICE_TURN_READBACK_UNAPPROVED_CONTEXT']
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

test('R79 publication audit 强制 full-voice-turn producer 来自 alex-acoustic self-hosted',{timeout:20000},()=>{
 let result=driver('publication','success');
 assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout);
 assert.ok(data.jobs.producer.labels.includes('alex-acoustic'));
 assert.ok(data.jobs.producer.labels.includes('self-hosted'));
 assert.ok(data.jobs.auditor.labels.includes('ubuntu-latest'));
 for(const [scenario,code] of [
  ['wrong-attest-digest','FULL_VOICE_TURN_PUBLICATION_ARTIFACT_DIGEST_MISMATCH'],
  ['producer-failed','FULL_VOICE_TURN_PUBLICATION_PRODUCER_NOT_SUCCESSFUL'],
  ['producer-labels','FULL_VOICE_TURN_PUBLICATION_PRODUCER_LABELS_MISMATCH'],
  ['auditor-labels','FULL_VOICE_TURN_PUBLICATION_AUDITOR_LABELS_MISMATCH'],
  ['job-order','FULL_VOICE_TURN_PUBLICATION_JOB_ORDER_INVALID'],
  ['same-ids','FULL_VOICE_TURN_PUBLICATION_ARTIFACT_IDS_REUSED'],
  ['wrong-context','FULL_VOICE_TURN_PUBLICATION_UNAPPROVED_CONTEXT']
 ]){
  result=driver('publication',scenario);
  assert.equal(result.status,1,scenario);
  assert.match(result.stderr,new RegExp(code),scenario);
 }
});

test('R79 coherent set 拒绝跨 Commit 和被替换的 Full Voice Turn report',{timeout:30000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'full-turn');await mkdir(folder);
  const report=join(folder,'report.json'),attestation=join(folder,'artifact-attestation.json');
  const readback=join(folder,'github-actions-readback.json');
  await writeFile(report,JSON.stringify(fullTurnReport())+'\n');
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
  const altered=fullTurnReport();altered.stages.llm.replyChars=99;
  await writeFile(report,JSON.stringify(altered)+'\n');
  checked=verify();assert.equal(checked.status,1);
 });
});

test('R79 Runtime Gate 只有 Full Voice Turn coherent set 才升级为 verified-by-set',{timeout:30000},async()=>{
 await temp(async dir=>{
  const folder=join(dir,'full-turn');await mkdir(folder);
  const report=join(folder,'report.json');
  const attestation=join(folder,'artifact-attestation.json');
  const readback=join(folder,'github-actions-readback.json');
  await writeFile(report,JSON.stringify(fullTurnReport())+'\n');
  let checked=run('python3',[writer,'--folder',folder,'--out',attestation],env());
  assert.equal(checked.status,0,checked.stderr);
  const readbackResult=driver('readback','success');
  assert.equal(readbackResult.status,0,readbackResult.stderr);
  const readbackDoc=JSON.parse(readbackResult.stdout);delete readbackDoc._test_artifact_fetches;
  await writeFile(readback,JSON.stringify(readbackDoc)+'\n');

  checked=run('python3',[
   gate,
   '--full-voice-turn-evidence-folder',folder,
   '--full-voice-turn-evidence-attestation',attestation,
   '--full-voice-turn-evidence-github-readback',readback,
   '--full-voice-turn-evidence-artifact-id',ARTIFACT_ID,
   '--full-voice-turn-evidence-artifact-digest',DIGEST,
   '--full-voice-turn-evidence-run-id',RUN,
   '--full-voice-turn-evidence-attempt',ATTEMPT,
   '--full-voice-turn-evidence-sha',SHA
  ]);
  assert.equal(checked.status,0,checked.stderr);
  const data=JSON.parse(checked.stdout);
  assert.equal(data.full_voice_turn,'verified-by-set');
  assert.equal(data.full_voice_turn_artifact_attestation,'verified-by-set');
  assert.equal(data.full_voice_turn_evidence_set,'verified-coherent');
  assert.equal(data.full_voice_turn_github_readback,'verified-by-set');
  assert.deepEqual(data.subjects.full_voice_turn,{
   run_id:RUN,attempt:Number(ATTEMPT),commit_sha:SHA
  });
  for(const item of [
   'FULL_VOICE_TURN_PHYSICAL_E2E','FULL_VOICE_TURN_ACTIONS_ARTIFACT_ATTESTATION',
   'FULL_VOICE_TURN_COHERENT_EVIDENCE_SET','FULL_VOICE_TURN_GITHUB_ACTIONS_READBACK_AUDIT'
  ])assert.ok(!data.remaining.includes(item),item);

  const mixed=run('python3',[
   gate,'--full-voice-turn-report',report,'--full-voice-turn-run-id',RUN,
   '--full-voice-turn-evidence-folder',folder,
   '--full-voice-turn-evidence-attestation',attestation,
   '--full-voice-turn-evidence-github-readback',readback,
   '--full-voice-turn-evidence-artifact-id',ARTIFACT_ID,
   '--full-voice-turn-evidence-artifact-digest',DIGEST,
   '--full-voice-turn-evidence-run-id',RUN,
   '--full-voice-turn-evidence-attempt',ATTEMPT,
   '--full-voice-turn-evidence-sha',SHA
  ]);
  assert.equal(mixed.status,2);
  assert.match(mixed.stderr,/FULL_VOICE_TURN_EVIDENCE_SET_CANNOT_MIX_INDIVIDUAL_ARGS/);
 });
});

test('R79 workflow 必须双 Artifact + REST readback + 独立 publication audit，且不上传原始音频',async()=>{
 const source=await readFile(join(root,'.github/workflows/full-voice-turn-acceptance.yml'),'utf8');
 const producer=source.indexOf('full-voice-turn:');
 const mainUpload=source.indexOf('id: full_turn_evidence_upload');
 const readback=source.indexOf('github-actions-full-voice-turn-readback.py --audit');
 const attest=source.indexOf('write-full-voice-turn-artifact-attestation.py');
 const secondUpload=source.indexOf('id: full_turn_attestation_upload');
 const audit=source.indexOf('publication-audit:');
 assert.ok(producer>=0&&mainUpload>producer&&readback>mainUpload&&attest>readback&&
  secondUpload>attest&&audit>secondUpload);
 assert.match(source,/runs-on: \[self-hosted, linux, x64, alex-acoustic\]/);
 assert.match(source,/publication-audit:[\s\S]*runs-on: ubuntu-latest/);
 assert.equal((source.match(/uses: actions\/upload-artifact@[0-9a-f]{40}/g)||[]).length,2);
 assert.doesNotMatch(source,/\.wav\s*$/m);
 assert.doesNotMatch(source,/\.pcm\s*$/m);
});
