import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectWriterLease} from '../scripts/inspect-writer-lease.mjs';
import {acquireWriterLease} from '../scripts/single-writer-lease.mjs';
test('R41 锁诊断在未创建标记时只读返回 absent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-diagnose-'));
 try{assert.deepEqual(await inspectWriterLease(join(dir,'lock')),{status:'absent',
  safeToStart:true,manualReview:false});}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('R41 锁诊断能识别当前进程，但不自动解锁或泄露随机所有者',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-diagnose-'));
 try{
  const path=join(dir,'lock'),lease=await acquireWriterLease(path);
  const result=await inspectWriterLease(path);
  assert.equal(result.status,'present');
  assert.equal(result.pid,process.pid);
  assert.equal(result.processState,'responsive');
  assert.equal(result.safeToStart,false);
  assert.equal(result.manualReview,true);
  assert.equal(Object.hasOwn(result,'nonce'),false);
  await lease.release();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R41 锁诊断对损坏和不存在 PID 均失败关闭，不建议自动删除',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-diagnose-'));
 try{
  const path=join(dir,'lock');
  await writeFile(path,'bad-json');
  assert.deepEqual(await inspectWriterLease(path),{status:'invalid',
   safeToStart:false,manualReview:true});
  await writeFile(path,JSON.stringify({
   schemaVersion:1,pid:2147483647,nonce:'00000000-0000-4000-8000-000000000000',
   createdAt:'2026-11-11T00:00:00Z'
  }));
  const result=await inspectWriterLease(path);
  assert.equal(result.status,'present');
  assert.equal(result.safeToStart,false);
  assert.equal(result.manualReview,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
