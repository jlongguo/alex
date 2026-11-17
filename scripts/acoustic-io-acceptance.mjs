#!/usr/bin/env node
// R76 真实声学 I/O 验收：仅允许 Linux self-hosted runner + ALSA 物理路径。
// CI 可调用纯分析函数测试算法，但 run 模式绝不使用 fake media、虚拟浏览器声卡或合成输入冒充真实设备。
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile,mkdir,rename,unlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const ACOUSTIC_SCHEMA='alex.dev/acoustic-io-acceptance/v1';
export const SAMPLE_RATE=48000;
export const STIMULUS_FREQUENCIES=Object.freeze([731,1103,1667]);
const SHA=/^[0-9a-f]{40}$/;
const DIGITS=/^[1-9][0-9]{0,19}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');

function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
const digest=value=>sha(canonical(value));
const round=value=>Math.round(value*1000)/1000;

export function createCalibrationWav({
 sampleRate=SAMPLE_RATE,durationMs=1800,frequencies=STIMULUS_FREQUENCIES
}={}){
 if(sampleRate!==SAMPLE_RATE||!Number.isInteger(durationMs)||durationMs<1000||durationMs>4000||
  !Array.isArray(frequencies)||frequencies.length!==3)
  fail('ACOUSTIC_STIMULUS_INVALID');
 const samples=Math.round(sampleRate*durationMs/1000);
 const pcm=Buffer.alloc(samples*2);
 const fade=Math.round(sampleRate*0.05);
 for(let i=0;i<samples;i++){
  const edge=Math.min(1,i/fade,(samples-1-i)/fade);
  const envelope=Math.max(0,Math.min(1,edge));
  let value=0;
  for(const f of frequencies)value+=Math.sin(2*Math.PI*f*i/sampleRate);
  value=(value/frequencies.length)*0.62*envelope;
  pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(value*32767))),i*2);
 }
 return encodePcm16MonoWav(pcm,sampleRate);
}

function encodePcm16MonoWav(pcm,sampleRate){
 const out=Buffer.alloc(44+pcm.length);
 out.write('RIFF',0);out.writeUInt32LE(36+pcm.length,4);out.write('WAVE',8);
 out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);
 out.writeUInt16LE(1,22);out.writeUInt32LE(sampleRate,24);
 out.writeUInt32LE(sampleRate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
 out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);
 return out;
}

export function parsePcm16MonoWav(bytes){
 const data=Buffer.from(bytes);
 if(data.length<44||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')
  fail('ACOUSTIC_WAV_INVALID');
 let offset=12,format=null,pcm=null;
 while(offset+8<=data.length){
  const id=data.toString('ascii',offset,offset+4),size=data.readUInt32LE(offset+4);
  const start=offset+8,end=start+size;
  if(end>data.length)fail('ACOUSTIC_WAV_INVALID');
  if(id==='fmt '){
   if(size<16)fail('ACOUSTIC_WAV_INVALID');
   format={
    encoding:data.readUInt16LE(start),channels:data.readUInt16LE(start+2),
    sampleRate:data.readUInt32LE(start+4),bits:data.readUInt16LE(start+14)
   };
  }else if(id==='data')pcm=data.subarray(start,end);
  offset=end+(size%2);
 }
 if(!format||!pcm||format.encoding!==1||format.channels!==1||
  format.sampleRate!==SAMPLE_RATE||format.bits!==16||pcm.length<9600||pcm.length%2)
  fail('ACOUSTIC_WAV_FORMAT_INVALID');
 const samples=new Float64Array(pcm.length/2);
 for(let i=0;i<samples.length;i++)samples[i]=pcm.readInt16LE(i*2)/32768;
 return {sampleRate:format.sampleRate,samples,durationMs:Math.round(samples.length/SAMPLE_RATE*1000)};
}

function goertzel(samples,frequency,sampleRate){
 const coeff=2*Math.cos(2*Math.PI*frequency/sampleRate);
 let s1=0,s2=0;
 for(const x of samples){
  const s0=x+coeff*s1-s2;s2=s1;s1=s0;
 }
 return Math.max(0,(s1*s1+s2*s2-coeff*s1*s2)/(samples.length*samples.length));
}

export function analyzeAcousticCapture(wavBytes,{
 frequencies=STIMULUS_FREQUENCIES,minRms=0.004,minRatio=2.5
}={}){
 const {sampleRate,samples,durationMs}=parsePcm16MonoWav(wavBytes);
 let sum=0,peak=0,clipped=0;
 for(const x of samples){
  sum+=x*x;peak=Math.max(peak,Math.abs(x));if(Math.abs(x)>=0.995)clipped++;
 }
 const rms=Math.sqrt(sum/samples.length);
 const tones=frequencies.map(f=>{
  const target=goertzel(samples,f,sampleRate);
  const side=(goertzel(samples,f-83,sampleRate)+goertzel(samples,f+83,sampleRate))/2;
  const ratio=target/Math.max(side,1e-12);
  return {frequencyHz:f,power:round(target),sidePower:round(side),ratio:round(ratio),
   detected:target>=1e-6&&ratio>=minRatio};
 });
 const clippingRatio=clipped/samples.length;
 const pass=rms>=minRms&&peak>=0.02&&clippingRatio<=0.02&&tones.every(x=>x.detected);
 return {
  pass,sampleRate,channels:1,bitsPerSample:16,durationMs,
  rms:round(rms),peak:round(peak),clippingRatio:round(clippingRatio),tones
 };
}

function actionContext(env){
 if(env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='self-hosted'||
  env.GITHUB_JOB!=='acoustic-io'||!DIGITS.test(env.GITHUB_RUN_ID??'')||
  !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))||Number(env.GITHUB_RUN_ATTEMPT)<1||
  !SHA.test(env.GITHUB_SHA??'')||env.ALEX_ACOUSTIC_PHYSICAL_PATH_APPROVED!=='true')
  fail('ACOUSTIC_SELF_HOSTED_CONTEXT_REQUIRED');
 if(process.platform!=='linux'||process.arch!=='x64')
  fail('ACOUSTIC_LINUX_X64_REQUIRED');
 const runner=String(env.RUNNER_NAME??'').trim();
 if(!runner)fail('ACOUSTIC_RUNNER_NAME_REQUIRED');
 return {
  source:'github-actions-self-hosted',
  runId:env.GITHUB_RUN_ID,attempt:Number(env.GITHUB_RUN_ATTEMPT),
  commitSha:env.GITHUB_SHA,job:env.GITHUB_JOB,
  runnerFingerprintSha256:sha(runner+'|'+String(env.RUNNER_OS??'')+'|'+String(env.RUNNER_ARCH??''))
 };
}

function device(value,name){
 if(typeof value!=='string'||!value.trim()||value.length>160||value.includes('\0'))
  fail('ACOUSTIC_'+name+'_DEVICE_REQUIRED');
 return value.trim();
}

function commandAvailable(name){
 const result=spawnSync(name,['--version'],{encoding:'utf8',timeout:3000});
 return result.status===0||result.status===1;
}

async function waitChild(child,label,timeoutMs){
 const result=await Promise.race([
  once(child,'exit').then(([code,signal])=>({code,signal})),
  delay(timeoutMs).then(()=>({timeout:true}))
 ]);
 if(result.timeout){
  child.kill('SIGTERM');await delay(250);if(child.exitCode===null)child.kill('SIGKILL');
  fail('ACOUSTIC_'+label+'_TIMEOUT');
 }
 if(result.code!==0)fail('ACOUSTIC_'+label+'_FAILED');
}

async function atomicWrite(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.tmp-'+process.pid;
 try{
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  await rename(temp,path);
 }finally{try{await unlink(temp);}catch(error){if(error?.code!=='ENOENT')throw error;}}
}

export async function runAcousticIoAcceptance({
 env=process.env,reportPath='.local/acoustic/report.json'
}={}){
 const context=actionContext(env);
 const captureDevice=device(env.ALEX_ACOUSTIC_CAPTURE_DEVICE,'CAPTURE');
 const playbackDevice=device(env.ALEX_ACOUSTIC_PLAYBACK_DEVICE,'PLAYBACK');
 if(!commandAvailable('arecord')||!commandAvailable('aplay'))
  fail('ACOUSTIC_ALSA_TOOLS_REQUIRED');
 const workspace=await mkdtemp(join(tmpdir(),'alex-r76-acoustic-'));
 const tonePath=join(workspace,'stimulus.wav'),capturePath=join(workspace,'capture.wav');
 let capture=null;
 try{
  await writeFile(tonePath,createCalibrationWav(),{mode:0o600});
  capture=spawn('arecord',[
   '-q','-D',captureDevice,'-f','S16_LE','-c','1','-r',String(SAMPLE_RATE),
   '-d','4',capturePath
  ],{stdio:['ignore','ignore','pipe']});
  await delay(450);
  if(capture.exitCode!==null)fail('ACOUSTIC_CAPTURE_START_FAILED');
  const playback=spawn('aplay',['-q','-D',playbackDevice,tonePath],
   {stdio:['ignore','ignore','pipe']});
  await waitChild(playback,'PLAYBACK',8000);
  await waitChild(capture,'CAPTURE',8000);
  capture=null;
  const captured=await readFile(capturePath);
  const analysis=analyzeAcousticCapture(captured);
  if(!analysis.pass)fail('ACOUSTIC_LOOP_NOT_DETECTED');
  const base={
   schema:ACOUSTIC_SCHEMA,status:'passed',mode:'real-alsa-physical-loop',
   context,
   devices:{
    captureFingerprintSha256:sha(captureDevice),
    playbackFingerprintSha256:sha(playbackDevice),
    physicalPathApproved:true,rawIdentifiersStored:false
   },
   stimulus:{sampleRate:SAMPLE_RATE,channels:1,bitsPerSample:16,
    frequenciesHz:[...STIMULUS_FREQUENCIES],durationMs:1800},
   capture:analysis,
   checks:[
    'alsa_real_capture','alsa_real_playback','multi_tone_loop_detected',
    'physical_path_operator_approved','temporary_audio_deleted'
   ],
   privacy:{
    rawAudioStored:false,transcriptStored:false,responseTextStored:false,
    deviceIdentifiersStored:false,credentialsStored:false
   },
   temporaryAudioDeleted:true,
   acousticCaptureVerified:true,speakerPlaybackVerified:true,
   releaseApproved:false,physicalSafetyCertified:false
  };
  const report={...base,evidenceDigestSha256:digest(base)};
  await atomicWrite(resolve(reportPath),report);
  return report;
 }finally{
  if(capture&&capture.exitCode===null){capture.kill('SIGTERM');await delay(100);}
  await rm(workspace,{recursive:true,force:true});
 }
}

export function verifyAcousticIoReport(report,{expectedRunId=null,expectedCommit=null}={}){
 if(!object(report)||report.schema!==ACOUSTIC_SCHEMA||report.status!=='passed'||
  report.mode!=='real-alsa-physical-loop'||!object(report.context)||
  report.context.source!=='github-actions-self-hosted'||!DIGITS.test(report.context.runId??'')||
  !Number.isSafeInteger(report.context.attempt)||report.context.attempt<1||
  !SHA.test(report.context.commitSha??'')||report.context.job!=='acoustic-io'||
  !HASH.test(report.context.runnerFingerprintSha256??'')||!object(report.devices)||
  !HASH.test(report.devices.captureFingerprintSha256??'')||
  !HASH.test(report.devices.playbackFingerprintSha256??'')||
  report.devices.physicalPathApproved!==true||report.devices.rawIdentifiersStored!==false||
  !object(report.stimulus)||report.stimulus.sampleRate!==SAMPLE_RATE||
  report.stimulus.channels!==1||report.stimulus.bitsPerSample!==16||
  JSON.stringify(report.stimulus.frequenciesHz)!==JSON.stringify(STIMULUS_FREQUENCIES)||
  report.stimulus.durationMs!==1800||!object(report.capture)||report.capture.pass!==true||
  report.capture.sampleRate!==SAMPLE_RATE||report.capture.channels!==1||
  report.capture.bitsPerSample!==16||!Array.isArray(report.capture.tones)||
  report.capture.tones.length!==STIMULUS_FREQUENCIES.length||
  report.capture.tones.some((x,i)=>!object(x)||x.frequencyHz!==STIMULUS_FREQUENCIES[i]||
   x.detected!==true||typeof x.ratio!=='number'||x.ratio<2.5)||
  typeof report.capture.rms!=='number'||report.capture.rms<0.004||
  typeof report.capture.peak!=='number'||report.capture.peak<0.02||
  typeof report.capture.clippingRatio!=='number'||report.capture.clippingRatio>0.02||
  !Array.isArray(report.checks)||
  !['alsa_real_capture','alsa_real_playback','multi_tone_loop_detected',
    'physical_path_operator_approved','temporary_audio_deleted']
   .every(x=>report.checks.includes(x))||
  !object(report.privacy)||Object.values(report.privacy).some(v=>v!==false)||
  report.temporaryAudioDeleted!==true||report.acousticCaptureVerified!==true||
  report.speakerPlaybackVerified!==true||report.releaseApproved!==false||
  report.physicalSafetyCertified!==false||!HASH.test(report.evidenceDigestSha256??''))
  fail('ACOUSTIC_REPORT_INVALID');
 if(expectedRunId!==null&&report.context.runId!==expectedRunId)
  fail('ACOUSTIC_RUN_ID_MISMATCH');
 if(expectedCommit!==null&&report.context.commitSha!==expectedCommit)
  fail('ACOUSTIC_COMMIT_MISMATCH');
 const {evidenceDigestSha256,...base}=report;
 if(digest(base)!==evidenceDigestSha256)fail('ACOUSTIC_REPORT_DIGEST_MISMATCH');
 return true;
}

async function loadReport(path){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>256*1024)
  fail('ACOUSTIC_REPORT_FILE_INVALID');
 return JSON.parse(await readFile(path,'utf8'));
}

async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='run'){
  if(args.length!==2||args[0]!=='--report')fail('ACOUSTIC_USAGE');
  const report=await runAcousticIoAcceptance({reportPath:args[1]});
  console.log('ACOUSTIC_IO_VERIFIED:'+report.context.runId+':'+report.context.commitSha);
  return;
 }
 if(mode==='verify'){
  let report=null,runId=null,commit=null;
  for(let i=0;i<args.length;i+=2){
   if(args[i]==='--report')report=args[i+1];
   else if(args[i]==='--run-id')runId=args[i+1];
   else if(args[i]==='--commit')commit=args[i+1];
   else fail('ACOUSTIC_USAGE');
  }
  if(!report)fail('ACOUSTIC_USAGE');
  const value=await loadReport(resolve(report));
  verifyAcousticIoReport(value,{expectedRunId:runId,expectedCommit:commit});
  console.log('ACOUSTIC_IO_REPORT_VERIFIED:'+value.context.runId+':'+value.context.commitSha);
  return;
 }
 fail('ACOUSTIC_USAGE');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
