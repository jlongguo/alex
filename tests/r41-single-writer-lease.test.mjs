import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireWriterLease} from '../scripts/single-writer-lease.mjs';

test('R41 同一目录只允许一个本地写入实例；正常释放后可再次启动',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-lock-'));
 try{
  const path=join(dir,'.alex-writer.lock');
  const first=await acquireWriterLease(path);
  const owner=JSON.parse(await readFile(path,'utf8'));
  assert.equal(owner.pid,process.pid);
  assert.equal(owner.nonce,first.owner.nonce);
  await assert.rejects(acquireWriterLease(path),/ALEX_INSTANCE_ALREADY_RUNNING/);
  assert.equal((await first.release()),true);
  assert.equal((await first.release()),false);
  const next=await acquireWriterLease(path);
  assert.notEqual(next.owner.nonce,first.owner.nonce);
  await next.release();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R41 遗留或被替换的租约拒绝被其他持有者释放',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-lease-'));
 try{
  const path=join(dir,'lease.lock'),lease=await acquireWriterLease(path);
  await writeFile(path,JSON.stringify({...lease.owner,nonce:'foreign-owner'}));
  await assert.rejects(lease.release(),/ALEX_WRITER_LEASE_LOST/);
  assert.equal(JSON.parse(await readFile(path,'utf8')).nonce,'foreign-owner');
  await assert.rejects(acquireWriterLease(path),/ALEX_INSTANCE_ALREADY_RUNNING/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R41 崩溃后遗留标记必须拒绝自动抢占，避免误判 PID 可重用',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r41-stale-'));
 try{
  const path=join(dir,'lease.lock');
  await writeFile(path,JSON.stringify({schemaVersion:1,pid:0,nonce:'stale',createdAt:'2000-01-01T00:00:00Z'}));
  await assert.rejects(acquireWriterLease(path),/ALEX_INSTANCE_ALREADY_RUNNING/);
  assert.ok((await stat(path)).isFile());
 }finally{await rm(dir,{recursive:true,force:true});}
});
