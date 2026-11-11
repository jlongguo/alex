import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';
import {createOfflineBackup} from '../scripts/offline-state-backup.mjs';

const auth=()=>({AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'only-test-parent-password'});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'alex-r47-'));
 const source=join(root,'state'),backup=join(root,'backup');
 await mkdir(source);
 return {root,source,backup,close:()=>rm(root,{recursive:true,force:true})};
}
test('R47 干净安装目录缺少文件时只需人工复核，不能自动批准发布',async()=>{
 const f=await fixture();try{
  const r=await inspectReleasePreflight({stateDir:f.source,env:auth()});
  assert.equal(r.status,'manual-review-required');
  assert.equal(r.storage.existing,0);
  assert.equal(r.upgradeExecuted,false);
  assert.equal(r.releaseApproved,false);
  assert.ok(r.manual.includes('BACKUP_INTEGRITY'));
  assert.ok(!r.blocked.length);
 }finally{await f.close();}
});
test('R47 现存状态文件和可信备份 SHA 校验成功，不代表业务恢复验收',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'profiles.json'),'{"version":1,"profiles":[]}');
  await writeFile(join(f.source,'state.json'),'{"schemaVersion":1}');
  await createOfflineBackup({sourceDir:f.source,destinationDir:f.backup});
  const r=await inspectReleasePreflight({stateDir:f.source,backupDir:f.backup,env:auth()});
  assert.equal(r.storage.existing,2);
  assert.ok(!r.blocked.length);
  assert.equal(r.checks.find(c=>c.id==='BACKUP_INTEGRITY').status,'pass');
  assert.ok(r.manual.includes('REAL_USER_ACCEPTANCE'));
  assert.equal(r.rollbackExecuted,false);
 }finally{await f.close();}
});
test('R47 检测写者锁并拒绝把活动服务状态当成安全升级环境',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'.alex-writer.lock'),'stale-or-live');
  const r=await inspectReleasePreflight({stateDir:f.source,env:auth()});
  assert.equal(r.status,'blocked');
  assert.ok(r.blocked.includes('SERVER_STOPPED'));
  assert.equal(r.readOnly,true);
 }finally{await f.close();}
});
test('R47 自定义状态文件离开默认备份目录时必须阻断',async()=>{
 const f=await fixture();try{
  const external=join(f.root,'external.json');
  await writeFile(external,'{"version":1,"profiles":[]}');
  const r=await inspectReleasePreflight({stateDir:f.source,env:{
   ...auth(),PROFILES_FILE:external}});
  assert.ok(r.blocked.includes('BACKUP_SCOPE'));
  assert.equal(r.storage.outsideDefaultBackup,1);
  assert.equal(JSON.stringify(r).includes(external),false);
 }finally{await f.close();}
});
test('R47 自定义写入锁路径无法由默认备份判定停机',async()=>{
 const f=await fixture();try{
  const r=await inspectReleasePreflight({stateDir:f.source,env:{
   ...auth(),ALEX_SERVER_LOCK_FILE:join(f.root,'another.lock')}});
  assert.ok(r.blocked.includes('WRITER_LOCK_SCOPE'));
 }finally{await f.close();}
});
test('R47 拒绝损坏 JSON、已知未来版本和非普通文件',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'profiles.json'),'{invalid');
  let r=await inspectReleasePreflight({stateDir:f.source,env:auth()});
  assert.ok(r.blocked.includes('STATE_FILES'));
  await writeFile(join(f.source,'profiles.json'),'{"version":99,"profiles":[]}');
  r=await inspectReleasePreflight({stateDir:f.source,env:auth()});
  assert.ok(r.blocked.includes('STATE_FILES'));
  await rm(join(f.source,'profiles.json'));
  await symlink(join(f.root,'other'),join(f.source,'profiles.json'));
  r=await inspectReleasePreflight({stateDir:f.source,env:auth()});
  assert.ok(r.blocked.includes('STATE_FILES'));
 }finally{await f.close();}
});
test('R47 异常备份清单不能声称可恢复',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'state.json'),'{"version":1}');
  await createOfflineBackup({sourceDir:f.source,destinationDir:f.backup});
  await writeFile(join(f.backup,'state.json'),'tampered');
  const r=await inspectReleasePreflight({stateDir:f.source,env:auth(),backupDir:f.backup});
  assert.ok(r.blocked.includes('BACKUP_INTEGRITY'));
 }finally{await f.close();}
});
test('R47 家庭认证禁用或密码不足时拒绝发布前检查',async()=>{
 const f=await fixture();try{
  for(const env of [{AUTH_MODE:'demo'},{
   AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'short'}]){
   const r=await inspectReleasePreflight({stateDir:f.source,env});
   assert.ok(r.blocked.includes('FAMILY_AUTH'));
  }
 }finally{await f.close();}
});
test('R47 只输出检查聚合结果，不包含家长密码或任何家庭记录',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source,'memory.json'),JSON.stringify({
   version:1,entries:[{text:'儿童隐私测试记录禁止回显'}]}));
  const env={...auth(),ALEX_PARENT_PASSWORD:'super-private-password-secret'};
  const r=await inspectReleasePreflight({stateDir:f.source,env});
  const text=JSON.stringify(r);
  assert.ok(!text.includes('super-private-password-secret'));
  assert.ok(!text.includes('儿童隐私测试记录禁止回显'));
 }finally{await f.close();}
});

test('R47 自定义同目录文件名不在 R43 允许列表时阻断备份覆盖判断',async()=>{
 const f=await fixture();try{
  const custom=join(f.source,'state.data');
  await writeFile(custom,'{"schemaVersion":1}');
  const r=await inspectReleasePreflight({stateDir:f.source,env:{
   ...auth(),STATE_FILE:custom}});
  assert.ok(r.blocked.includes('BACKUP_SCOPE'));
  assert.equal(r.storage.outsideDefaultBackup,1);
 }finally{await f.close();}
});
test('R47 同一状态文件被多个存储配置重复指向时拒绝升级预演',async()=>{
 const f=await fixture();try{
  const path=join(f.source,'shared.json');
  await writeFile(path,'{"version":1}');
  const r=await inspectReleasePreflight({stateDir:f.source,env:{
   ...auth(),PROFILES_FILE:path,MEMORY_FILE:path}});
  assert.ok(r.blocked.includes('DUPLICATE_STORAGE_PATH'));
 }finally{await f.close();}
});
