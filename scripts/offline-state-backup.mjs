// R43 离线状态备份：敏感数据仅保留在本地，默认不提供 HTTP 下载或数据覆盖。
// 运行条件：Alex 进程已退出、写者锁不存在；只处理状态目录顶层常规文件。
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readdir,lstat,readFile,open} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_FILES=100,MAX_BYTES=20*1024*1024;
const filePattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.(?:json|jsonl)$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const sorted=arr=>[...arr].sort((a,b)=>a.localeCompare(b,'en'));
async function noLock(root){
 try{await lstat(join(root,'.alex-writer.lock'));fail('ALEX_BACKUP_REQUIRES_STOPPED_SERVER');}
 catch(error){if(error?.code!=='ENOENT')throw error;}
}
async function ensureDirectory(path){
 const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink())fail('ALEX_BACKUP_UNSAFE_DIRECTORY');
}
async function inventory(root){
 await ensureDirectory(root);
 await noLock(root);
 const entries=await readdir(root,{withFileTypes:true});
 const ignored=entries.filter(entry=>entry.name.endsWith('.tmp')||entry.name==='.alex-writer.lock');
 if(ignored.some(entry=>entry.name.endsWith('.tmp')))fail('ALEX_BACKUP_PENDING_TEMP_FILE');
 const names=sorted(entries.filter(entry=>filePattern.test(entry.name)).map(entry=>entry.name));
 if(names.length>MAX_FILES)fail('ALEX_BACKUP_TOO_MANY_FILES');
 for(const entry of entries){
  if(filePattern.test(entry.name)&&!entry.isFile())fail('ALEX_BACKUP_UNSAFE_STATE_FILE');
 }
 const result=[],data=new Map();
 for(const name of names){
  const path=join(root,name);
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)
   fail('ALEX_BACKUP_UNSAFE_STATE_FILE');
  const bytes=await readFile(path);
  if(bytes.length>MAX_BYTES)fail('ALEX_BACKUP_FILE_TOO_LARGE');
  if(name.endsWith('.json')){
   let parsed;
   try{parsed=JSON.parse(bytes.toString('utf8'));}
   catch{fail('ALEX_BACKUP_INVALID_JSON');}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    fail('ALEX_BACKUP_INVALID_JSON');
  }
  result.push({name,size:bytes.length,sha256:sha(bytes)});
  data.set(name,bytes);
 }
 await noLock(root);
 return {files:result,data};
}
async function writeNew(path,bytes){
 const handle=await open(path,'wx',0o600);
 try{await handle.writeFile(bytes);await handle.sync();}
 finally{await handle.close();}
}
function validateManifest(value){
 if(!value||Object.keys(value).sort().join(',')!=='files,schemaVersion,snapshotId'||
  value.schemaVersion!=='alex.dev/offline-backup/v1'||
  typeof value.snapshotId!=='string'||!/^[0-9a-f-]{36}$/.test(value.snapshotId)||
  !Array.isArray(value.files)||value.files.length>MAX_FILES)
  fail('ALEX_BACKUP_INVALID_MANIFEST');
 const names=new Set();
 for(const f of value.files){
  if(!f||Object.keys(f).sort().join(',')!=='name,sha256,size'||
   !filePattern.test(f.name)||names.has(f.name)||!Number.isSafeInteger(f.size)||
   f.size<0||f.size>MAX_BYTES||typeof f.sha256!=='string'||
   !/^[0-9a-f]{64}$/.test(f.sha256))fail('ALEX_BACKUP_INVALID_MANIFEST');
  names.add(f.name);
 }
 if(!same(value.files.map(f=>f.name),sorted(value.files.map(f=>f.name))))
  fail('ALEX_BACKUP_INVALID_MANIFEST');
 return value;
}
export async function createOfflineBackup({sourceDir,destinationDir}={}){
 if(typeof sourceDir!=='string'||typeof destinationDir!=='string'||
  !sourceDir||!destinationDir)fail('ALEX_BACKUP_INVALID_PATH');
 const source=resolve(sourceDir),destination=resolve(destinationDir);
 if(destination===source||destination.startsWith(source+sep)||
  source.startsWith(destination+sep))fail('ALEX_BACKUP_OVERLAPPING_PATH');
 const parent=dirname(destination);
 await ensureDirectory(parent);
 const {files,data}=await inventory(source);
 if(!files.length)fail('ALEX_BACKUP_NO_STATE_FILES');
 // 原子声明全新备份目录；绝不覆盖已有备份或源目录中的数据。
 await mkdir(destination,{mode:0o700});
 const manifest={schemaVersion:'alex.dev/offline-backup/v1',snapshotId:randomUUID(),files};
 try{
  for(const item of files)await writeNew(join(destination,item.name),data.get(item.name));
  await writeNew(join(destination,'backup-manifest.json'),Buffer.from(JSON.stringify(manifest)+'\n'));
  // 采集后再次核对源文件哈希，尽量检测绕过锁的并发改动。
  const after=await inventory(source);
  if(!same(files.map(f=>f.name+':'+f.sha256),
   after.files.map(f=>f.name+':'+f.sha256)))fail('ALEX_BACKUP_SOURCE_CHANGED');
 }catch(error){
  // 故障时保留目录供人工分析；禁止静默删除或覆盖。
  throw error;
 }
 return {snapshotId:manifest.snapshotId,files:files.length,bytes:files.reduce((a,f)=>a+f.size,0),
  destination,coverage:'top-level-json-jsonl-only',fullApplicationBackup:false,
  verified:await verifyOfflineBackup({directory:destination})};
}
export async function verifyOfflineBackup({directory}={}){
 if(typeof directory!=='string'||!directory)fail('ALEX_BACKUP_INVALID_PATH');
 const root=resolve(directory);
 await ensureDirectory(root);
 const manifestPath=join(root,'backup-manifest.json');
 const manifestInfo=await lstat(manifestPath);
 if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||
  manifestInfo.size>128*1024)fail('ALEX_BACKUP_INVALID_MANIFEST');
 let manifest;
 try{manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')));}
 catch(error){if(error.message.startsWith('ALEX_BACKUP_'))throw error;
  fail('ALEX_BACKUP_INVALID_MANIFEST');}
 const found=await readdir(root,{withFileTypes:true});
 if(!same(sorted(found.map(x=>x.name)),sorted(['backup-manifest.json',
  ...manifest.files.map(f=>f.name)])))fail('ALEX_BACKUP_UNEXPECTED_FILE');
 for(const item of manifest.files){
  const path=join(root,item.name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==item.size)
   fail('ALEX_BACKUP_FILE_MISMATCH');
  const data=await readFile(path);
  if(data.length!==item.size||sha(data)!==item.sha256)
   fail('ALEX_BACKUP_FILE_MISMATCH');
  if(item.name.endsWith('.json')){
   try{JSON.parse(data.toString('utf8'));}
   catch{fail('ALEX_BACKUP_INVALID_JSON');}
  }
 }
 return {status:'verified',snapshotId:manifest.snapshotId,files:manifest.files.length,
  bytes:manifest.files.reduce((a,f)=>a+f.size,0),readOnly:true,restored:false,
  coverage:'top-level-json-jsonl-only',fullApplicationBackup:false};
}
export async function planOfflineRestore({directory,targetDir}={}){
 if(typeof targetDir!=='string'||!targetDir)fail('ALEX_BACKUP_INVALID_PATH');
 const target=resolve(targetDir),source=resolve(directory);
 if(target===source||target.startsWith(source+sep)||source.startsWith(target+sep))
  fail('ALEX_BACKUP_OVERLAPPING_PATH');
 const verified=await verifyOfflineBackup({directory:source});
 // 目标必须是存在的空目录，不能以 dry-run 为由覆盖当前活跃家庭状态。
 await ensureDirectory(target);
 const files=await readdir(target);
 if(files.length)fail('ALEX_RESTORE_TARGET_NOT_EMPTY');
 return {...verified,target,eligibleForManualRestore:true,
  readOnly:true,restored:false,execution:'not-implemented'};
}
// 只允许向现有的空 staging 目录还原副本，不修改真实状态目录。
export async function stageOfflineRestore({directory,targetDir}={}){
 const plan=await planOfflineRestore({directory,targetDir});
 const root=resolve(directory),target=resolve(targetDir);
 const manifest=validateManifest(JSON.parse(await readFile(join(root,'backup-manifest.json'),'utf8')));
 let bytes=0;
 for(const item of manifest.files){
  // 在每一次写入前重新验证备份文件，避免预演与写入之间发生未察觉的修改。
  const data=await readFile(join(root,item.name));
  if(data.length!==item.size||sha(data)!==item.sha256)
   fail('ALEX_BACKUP_FILE_MISMATCH');
  await writeNew(join(target,item.name),data);
  bytes+=data.length;
 }
 const evidence=await inventory(target);
 if(!same(evidence.files.map(f=>f.name+':'+f.sha256),
  manifest.files.map(f=>f.name+':'+f.sha256)))
  fail('ALEX_RESTORE_STAGING_MISMATCH');
 return {status:'staged',snapshotId:plan.snapshotId,files:plan.files,bytes,
  target,productionRestored:false,stagingOnly:true,
  warning:'仅在全新空目录中还原，不能据此证明业务加载或全链路运行验收'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [action,first,second]=process.argv.slice(2);
 try{
  const result=action==='create'?await createOfflineBackup({sourceDir:first,destinationDir:second}):
   action==='verify'?await verifyOfflineBackup({directory:first}):
   action==='restore-plan'?await planOfflineRestore({directory:first,targetDir:second}):
   action==='restore-stage'?await stageOfflineRestore({directory:first,targetDir:second}):
   fail('ALEX_BACKUP_USAGE');
  console.log(JSON.stringify(result,null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
