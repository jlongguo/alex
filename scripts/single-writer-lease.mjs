// R41 单实例写入保护：使用 O_EXCL 在状态目录创建本地所有权标记。
// 不自动删除崩溃残留的标记，避免 PID 复用或竞争式清理导致双写。
import {open,mkdir,readFile,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=code=>{throw new Error(code);};
export async function acquireWriterLease(file){
 if(typeof file!=='string'||!file)fail('INVALID_WRITER_LEASE_FILE');
 const path=resolve(file),nonce=randomUUID();
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 let handle;
 try{handle=await open(path,'wx',0o600);}
 catch(error){
  if(error?.code==='EEXIST')fail('ALEX_INSTANCE_ALREADY_RUNNING');
  throw error;
 }
 const owner={schemaVersion:1,pid:process.pid,nonce,createdAt:new Date().toISOString()};
 try{
  await handle.writeFile(JSON.stringify(owner)+'\n','utf8');
  await handle.sync();
 }catch(error){
  await handle.close();
  // 创建后写失败只清理由本进程刚刚创建的标记。
  await unlink(path);
  throw error;
 }
 let closed=false;
 return Object.freeze({
  path,
  owner:structuredClone(owner),
  async release(){
   if(closed)return false;
   closed=true;
   // 仅在标记仍属于当前租约时释放。未知所有权必须保留并报错。
   let current;
   try{current=JSON.parse(await readFile(path,'utf8'));}
   catch(error){
    await handle.close();
    if(error?.code==='ENOENT')fail('ALEX_WRITER_LEASE_LOST');
    throw error;
   }
   if(current?.nonce!==nonce||current?.pid!==process.pid){
    await handle.close();
    fail('ALEX_WRITER_LEASE_LOST');
   }
   await unlink(path);
   await handle.close();
   return true;
  }
 });
}
