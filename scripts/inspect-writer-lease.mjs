// R41 只读诊断本地独占标记，不提供解锁或抢占入口。
// PID 可能复用；探测不到进程不能证明安全解锁。
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function inspectWriterLease(file){
 if(typeof file!=='string'||!file)throw Error('INVALID_WRITER_LEASE_FILE');
 const path=resolve(file);
 let raw;
 try{raw=await readFile(path,'utf8');}
 catch(error){
  if(error?.code==='ENOENT')return {status:'absent',safeToStart:true,manualReview:false};
  throw error;
 }
 let value;
 try{value=JSON.parse(raw);}
 catch{return {status:'invalid',safeToStart:false,manualReview:true};}
 if(!value||value.schemaVersion!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||
  typeof value.nonce!=='string'||!/^[0-9a-f-]{36}$/.test(value.nonce)||
  typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||
  Object.keys(value).sort().join(',')!=='createdAt,nonce,pid,schemaVersion')
  return {status:'invalid',safeToStart:false,manualReview:true};
 let processState='unknown';
 try{
  process.kill(value.pid,0);
  processState='responsive';
 }catch(error){
  if(error?.code==='ESRCH')processState='not-found';
  else if(error?.code==='EPERM')processState='permission-denied';
  else throw error;
 }
 return {status:'present',pid:value.pid,createdAt:value.createdAt,processState,
  safeToStart:false,manualReview:true,
  note:'PID detection is advisory; verify process and WAL before any manual lock cleanup'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const file=process.argv[2];
 if(!file){
  console.error('用法: node scripts/inspect-writer-lease.mjs <锁文件路径>');
  process.exitCode=2;
 }else{
  try{
   const report=await inspectWriterLease(file);
   console.log(JSON.stringify(report,null,2));
   if(report.manualReview)process.exitCode=1;
  }catch(error){
   console.error(error.message);
   process.exitCode=2;
  }
 }
}
