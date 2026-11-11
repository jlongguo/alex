// R51 只读 Skill Registry / Trust 恢复兼容检查。
// 必须使用正式加载器验证磁盘快照；不调用任何会修改 Registry/Trust 的方法。
import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SkillPackageRegistry} from './skill-package-registry.mjs';
import {SkillPackageTrust} from './skill-package-trust.mjs';

const descriptors=Object.freeze([
 {id:'REGISTRY',env:'ALEX_SKILL_PACKAGES_FILE',name:'skill-packages.json'},
 {id:'TRUST',env:'ALEX_SKILL_TRUST_FILE',name:'skill-trust.json'}
]);
const MAX_BYTES=20*1024*1024;
async function safeSnapshot(path){
 let stat;
 try{stat=await lstat(path);}
 catch(error){
  if(error?.code==='ENOENT')return {status:'absent'};
  throw error;
 }
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)
  return {status:'blocked'};
 return {status:'present'};
}
export async function inspectSkillStateCompatibility({stateDir='.local',env=process.env}={}){
 if(typeof stateDir!=='string'||!stateDir)throw Error('INVALID_SKILL_COMPAT_DIRECTORY');
 const root=resolve(stateDir);
 const entries=await Promise.all(descriptors.map(async item=>({
  ...item,path:resolve(env[item.env]||join(root,item.name)),
  ...(await safeSnapshot(resolve(env[item.env]||join(root,item.name))))
 })));
 const checks=[];
 const counts={packages:0,installed:0,references:0,publishers:0,attestations:0};
 // 不信任任何从状态文件携带的错误描述、清单内容及操作人信息。
 const registry=new SkillPackageRegistry({file:entries[0].path});
 const trust=new SkillPackageTrust({file:entries[1].path});
 const ready={};
 for(const [i,instance] of [registry,trust].entries()){
  const item=entries[i];
  if(item.status==='blocked'){
   checks.push({id:item.id,status:'blocked',reason:'UNSAFE_SNAPSHOT'});
   continue;
  }
  if(item.status==='absent'){
   checks.push({id:item.id,status:'absent',reason:'NEW_INSTALL_OR_UNBACKED_STATE'});
   ready[item.id]=true;
   continue;
  }
  try{
   // JsonStateStore.load 只读取文件；原模块执行全部内置版本和历史链校验。
   await instance.load();
   ready[item.id]=true;
   const record=instance.list('parent');
   if(i===0){
    counts.packages=record.packages.length;
    counts.installed=record.installed.length;
    counts.references=record.references.length;
    // v1 只允许加载器在内存中适配，不允许预检写回 v2。
    const disk=JSON.parse(await readFile(item.path,'utf8'));
    checks.push({id:item.id,status:disk.schemaVersion===1?'manual-review-required':'pass',
     reason:disk.schemaVersion===1?'LEGACY_V1_IN_MEMORY_ONLY':'LOADED_WITH_OFFICIAL_VALIDATOR'});
   }else{
    counts.publishers=record.publishers.length;
    counts.attestations=record.attestations.length;
    checks.push({id:item.id,status:'pass',reason:'LOADED_WITH_OFFICIAL_VALIDATOR'});
   }
  }catch(error){
   if(!(error instanceof Error))throw error;
   checks.push({id:item.id,status:'blocked',reason:'OFFICIAL_LOADER_REJECTED'});
  }
 }
 // 存在的包目录与已丢失的信任数据库不能当成全新安装处理。
 if(ready.REGISTRY&&ready.TRUST){
  const catalog=registry.list('parent').packages.length;
  const attestations=trust.list('parent').attestations.length;
  if(entries[1].status==='absent'&&catalog>0||
   entries[0].status==='absent'&&attestations>0){
   checks.push({id:'STATE_PAIR',status:'blocked',
    reason:'REGISTRY_TRUST_BACKUP_INCOMPLETE'});
  }else checks.push({id:'STATE_PAIR',status:'pass',reason:'STATE_PAIR_COVERED'});
 }
 if(ready.REGISTRY&&ready.TRUST){
  const current=registry.list('parent'),installed=current.installed;
  const packages=current.packages;
  let failures=0;
  for(const item of installed){
   const candidate=packages.find(p=>p.manifest.id===item.id&&
    p.manifest.version===item.version&&p.status==='approved');
   if(!candidate){failures++;continue;}
   try{trust.assertTrusted(candidate.manifest);}
   catch(error){if(!(error instanceof Error))throw error;failures++;}
  }
  checks.push({id:'INSTALLED_PROVENANCE',
   status:failures?'blocked':'pass',
   reason:failures?'UNTRUSTED_INSTALLED_PACKAGES':'INSTALLED_PROOFS_VALID',
   examined:installed.length,rejected:failures});
 }else{
  checks.push({id:'INSTALLED_PROVENANCE',status:'blocked',
   reason:'REGISTRY_OR_TRUST_UNREADABLE',examined:null,rejected:null});
 }
 return {
  schemaVersion:'alex.dev/skill-state-compat/v1',checks,counts,
  blocked:checks.filter(c=>c.status==='blocked').map(c=>c.id),
  manual:checks.filter(c=>c.status==='manual-review-required').map(c=>c.id),
  readOnly:true,registryModified:false,trustModified:false,
  migrationExecuted:false,releaseApproved:false,
  note:'原 Registry/Trust 加载器与已安装包签名核对通过也不代表 WAL 已恢复或可部署运行'
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length>3){
  console.error('用法: node scripts/skill-state-compat.mjs [状态目录]');
  process.exitCode=2;
 }else{
  try{
   const report=await inspectSkillStateCompatibility({stateDir:process.argv[2]??'.local'});
   console.log(JSON.stringify(report,null,2));
   if(report.blocked.length)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=2;}
 }
}
