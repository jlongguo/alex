import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
 createCalibrationWav,parsePcm16MonoWav,analyzeAcousticCapture,
 verifyAcousticIoReport,STIMULUS_FREQUENCIES,SAMPLE_RATE
} from '../scripts/acoustic-io-acceptance.mjs';

const SHA='0123456789abcdef0123456789abcdef01234567';
const RUN='43800000001';
function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

test('R76 校准 WAV 是 PCM16 mono 48k，纯分析器能识别三频信号',()=>{
 const wav=createCalibrationWav();
 const parsed=parsePcm16MonoWav(wav);
 assert.equal(parsed.sampleRate,SAMPLE_RATE);
 assert.ok(parsed.durationMs>=1700);
 const analysis=analyzeAcousticCapture(wav);
 assert.equal(analysis.pass,true);
 assert.deepEqual(analysis.tones.map(x=>x.frequencyHz),STIMULUS_FREQUENCIES);
 assert.ok(analysis.tones.every(x=>x.detected));
});

test('R76 静音不能冒充真实声学回路',()=>{
 const wav=createCalibrationWav();
 const silent=Buffer.from(wav);
 silent.fill(0,44);
 const analysis=analyzeAcousticCapture(silent);
 assert.equal(analysis.pass,false);
 assert.ok(analysis.tones.some(x=>!x.detected));
});

function fixture(){
 const base={
  schema:'alex.dev/acoustic-io-acceptance/v1',status:'passed',
  mode:'real-alsa-physical-loop',
  context:{source:'github-actions-self-hosted',runId:RUN,attempt:2,commitSha:SHA,
   job:'acoustic-io',runnerFingerprintSha256:'a'.repeat(64)},
  devices:{captureFingerprintSha256:'b'.repeat(64),playbackFingerprintSha256:'c'.repeat(64),
   physicalPathApproved:true,rawIdentifiersStored:false},
  stimulus:{sampleRate:48000,channels:1,bitsPerSample:16,
   frequenciesHz:[...STIMULUS_FREQUENCIES],durationMs:1800},
  capture:{pass:true,sampleRate:48000,channels:1,bitsPerSample:16,durationMs:4000,
   rms:0.08,peak:0.4,clippingRatio:0,
   tones:STIMULUS_FREQUENCIES.map(f=>({frequencyHz:f,power:0.01,sidePower:0.001,
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

test('R76 verifier 绑定 self-hosted Run/Commit 且不接受报告篡改',()=>{
 const report=fixture();
 assert.equal(verifyAcousticIoReport(report,{expectedRunId:RUN,expectedCommit:SHA}),true);
 assert.throws(()=>verifyAcousticIoReport(report,{expectedCommit:'f'.repeat(40)}),
  /ACOUSTIC_COMMIT_MISMATCH/);
 const altered=structuredClone(report);altered.capture.rms=0.2;
 assert.throws(()=>verifyAcousticIoReport(altered),/ACOUSTIC_REPORT_DIGEST_MISMATCH/);
});

test('R76 fake/synthetic 模式和未批准物理路径不能通过 verifier',()=>{
 const fake=fixture();fake.mode='synthetic-test';
 fake.evidenceDigestSha256=digest(Object.fromEntries(Object.entries(fake)
  .filter(([key])=>key!=='evidenceDigestSha256')));
 assert.throws(()=>verifyAcousticIoReport(fake),/ACOUSTIC_REPORT_INVALID/);
 const unapproved=fixture();unapproved.devices.physicalPathApproved=false;
 assert.throws(()=>verifyAcousticIoReport(unapproved),/ACOUSTIC_REPORT_INVALID/);
});
