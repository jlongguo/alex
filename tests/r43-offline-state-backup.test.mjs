import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOfflineBackup,verifyOfflineBackup,planOfflineRestore}
 from '../scripts/offline-state-backup.mjs';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'alex-r43-backup-'));
 const state=join(root,'state'),backup=join(root,'snapshot'),restore=join(root,'restore');
 await mkdir(state);await mkdir(restore);
 await writeFile(join(state,'state.json'),JSON.stringify({schemaVersion:1,profiles:[]}));
 await writeFile(join(state,'skill-batch-wal.json'),JSON.stringify({schemaVersion:1,records:[]}));
 await writeFile(join(state,'audit.jsonl'),'{"action":"test"}\n');
 return {root,state,backup,restore,close:()=>rm(root,{recursive:true,force:true})};
}
test('R43 离线备份复制字节原样并输出可验证的清单',async()=>{
 const f=await fixture();try{
  const result=await createOfflineBackup({sourceDir:f.state,destinationDir:f.backup});
  assert.equal(result.files,3);
  assert.equal(result.verified.status,'verified');
  assert.equal(result.verified.restored,false);
  const manifest=JSON.parse(await readFile(join(f.backup,'backup-manifest.json'),'utf8'));
  assert.equal(manifest.files.length,3);
  assert.equal(manifest.schemaVersion,'alex.dev/offline-backup/v1');
  for(const name of manifest.files.map(x=>x.name))
   assert.deepEqual(await readFile(join(f.state,name)),await readFile(join(f.backup,name)));
  assert.equal((await planOfflineRestore({directory:f.backup,targetDir:f.restore})).restored,false);
  assert.deepEqual(await readdir(f.restore),[]);
 }finally{await f.close();}
});
test('R43 禁止覆盖已有备份目录，源数据不被修改',async()=>{
 const f=await fixture();try{
  const original=await readFile(join(f.state,'state.json'));
  await createOfflineBackup({sourceDir:f.state,destinationDir:f.backup});
  await assert.rejects(createOfflineBackup({sourceDir:f.state,destinationDir:f.backup}),
   /EEXIST/);
  assert.deepEqual(await readFile(join(f.state,'state.json')),original);
 }finally{await f.close();}
});
test('R43 有活跃或残留写者锁时拒绝快照',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.state,'.alex-writer.lock'),'stale or active');
  await assert.rejects(createOfflineBackup({sourceDir:f.state,destinationDir:f.backup}),
   /ALEX_BACKUP_REQUIRES_STOPPED_SERVER/);
  await assert.rejects(verifyOfflineBackup({directory:f.backup}));
 }finally{await f.close();}
});
test('R43 不会跟随状态文件软链，并拒绝隐藏临时写入',async()=>{
 const f=await fixture();try{
  await symlink(join(f.state,'state.json'),join(f.state,'memory.json'));
  await assert.rejects(createOfflineBackup({sourceDir:f.state,destinationDir:f.backup}),
   /ALEX_BACKUP_UNSAFE_STATE_FILE/);
  await rm(join(f.state,'memory.json'));
  await writeFile(join(f.state,'leftover.tmp'),'pending');
  await assert.rejects(createOfflineBackup({sourceDir:f.state,destinationDir:f.backup}),
   /ALEX_BACKUP_PENDING_TEMP_FILE/);
 }finally{await f.close();}
});
test('R43 清单 SHA 不匹配必须拒绝验收和恢复计划',async()=>{
 const f=await fixture();try{
  await createOfflineBackup({sourceDir:f.state,destinationDir:f.backup});
  await writeFile(join(f.backup,'state.json'),'{"schemaVersion":2,"profiles":[]}');
  await assert.rejects(verifyOfflineBackup({directory:f.backup}),/ALEX_BACKUP_FILE_MISMATCH/);
  await assert.rejects(planOfflineRestore({directory:f.backup,targetDir:f.restore}),
   /ALEX_BACKUP_FILE_MISMATCH/);
 }finally{await f.close();}
});
test('R43 清单无法引用目录穿越和未列入清单的数据',async()=>{
 const f=await fixture();try{
  await createOfflineBackup({sourceDir:f.state,destinationDir:f.backup});
  const file=join(f.backup,'backup-manifest.json'),value=JSON.parse(await readFile(file));
  value.files[0].name='../secret.json';
  await writeFile(file,JSON.stringify(value));
  await assert.rejects(verifyOfflineBackup({directory:f.backup}),/ALEX_BACKUP_INVALID_MANIFEST/);
 }finally{await f.close();}
});
test('R43 恢复预演禁止覆盖已有家庭状态，不执行任何恢复写入',async()=>{
 const f=await fixture();try{
  await createOfflineBackup({sourceDir:f.state,destinationDir:f.backup});
  await writeFile(join(f.restore,'state.json'),'{"keep":true}');
  await assert.rejects(planOfflineRestore({directory:f.backup,targetDir:f.restore}),
   /ALEX_RESTORE_TARGET_NOT_EMPTY/);
  assert.equal(await readFile(join(f.restore,'state.json'),'utf8'),'{"keep":true}');
 }finally{await f.close();}
});
test('R43 禁止源/目标路径相互包含，避免备份自包含和恢复自覆盖',async()=>{
 const f=await fixture();try{
  await assert.rejects(createOfflineBackup({
   sourceDir:f.state,destinationDir:join(f.state,'nested')}),
   /ALEX_BACKUP_OVERLAPPING_PATH/);
  await assert.rejects(createOfflineBackup({
   sourceDir:f.state,destinationDir:f.root}),
   /ALEX_BACKUP_OVERLAPPING_PATH/);
  await createOfflineBackup({sourceDir:f.state,destinationDir:f.backup});
  await assert.rejects(planOfflineRestore({directory:f.backup,targetDir:f.root}),
   /ALEX_BACKUP_OVERLAPPING_PATH/);
 }finally{await f.close();}
});
test('R43 JSON 文件损坏必须在备份开始前拒绝，原始源文件保留',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.state,'memory.json'),'{broken');
  await assert.rejects(createOfflineBackup({sourceDir:f.state,destinationDir:f.backup}),
   /ALEX_BACKUP_INVALID_JSON/);
  assert.equal(await readFile(join(f.state,'memory.json'),'utf8'),'{broken');
 }finally{await f.close();}
});
