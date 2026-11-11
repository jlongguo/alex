// R47 发布前只读环境检查：拒绝猜测外部状态覆盖范围，不读取或回显用户记录。
// 不提供安装、自动迁移、升级执行、覆盖恢复或清理锁的命令。
import {lstat,readdir,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyOfflineBackup} from './offline-state-backup.mjs';

const FILES=Object.freeze({
 STATE_FILE:'state.json',
 AUDIT_FILE:'audit.jsonl',
 MEMORY_FILE:'memory.json',
 DEVICES_FILE:'devices.json',
 PROFILES_FILE:'profiles.json',
 LEARNER_CREDENTIALS_FILE:'learner-credentials.json',
 ALEX_LEARNER_PRIVACY_FILE:'learner-privacy.json',
 ALEX_LEARNING_PLANS_FILE:'learning-plans.json',
 GATEWAY_FILE:'gateway.json',
 ALEX_SKILL_GOVERNANCE_FILE:'skill-governance.json',
 ALEX_SKILL_TRUST_FILE:'skill-trust.json',
 ALEX_SKILL_PACKAGES_FILE:'skill-packages.json',
 ALEX_SKILL_TRANSACTIONS_FILE:'skill-transactions.json',
 ALEX_SKILL_BATCH_WAL_FILE:'skill-batch-wal.json',
 WORKFLOW_FILE:'workflows.json',
 PLAN_FILE:'plans.json',
 PROPOSAL_FILE:'proposals.json',
 ALEX_CONVERSATION_FILE:'conversations.json'
});
const OPTIONAL=Object.freeze([
 'ALEX_SPEECH_PROVIDER_USAGE_FILE','ALEX_SPEECH_PROVIDER_BILLING_FILE',
 'ALEX_SPEECH_DELIVERY_LEDGER_FILE'
]);
const MAX_JSON_BYTES=20*1024*1024;
const validDir=async(path)=>{
 try{const st=await lstat(path);return st.isDirectory()&&!st.isSymbolicLink();}
 catch(error){if(error?.code==='ENOENT')return false;throw error;}
};
const issue=(id,status,detail)=>({id,status,detail});
const knownVersion=Object.freeze({
 'profiles.json':1,'learner-credentials.json':1,'learner-privacy.json':1,
 'learning-plans.json':1,'conversations.json':1
});
export async function inspectReleasePreflight({
 stateDir='.local',env=process.env,backupDir=null
}={}){
 if(typeof stateDir!=='string'||!stateDir||
  (backupDir!==null&&(typeof backupDir!=='string'||!backupDir)))
  throw Error('RELEASE_PREFLIGHT_INVALID_PATH');
 const root=resolve(stateDir),checks=[],missing=[],present=[];
 const directory=await validDir(root);
 checks.push(issue('STATE_DIRECTORY',directory?'pass':'manual-required',
  directory?'本地状态目录存在':'首次安装可尚无状态目录；启动前须检查写入权限'));
 const storage=Object.entries(FILES).map(([variable,name])=>({
  variable,name,path:resolve(env[variable]||join(root,name))
 }));
 // R43 只收集源目录顶层命名受限的 JSON/JSONL 文件；自定义文件名同目录也可能漏备份。
 const backupName=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.(?:json|jsonl)$/;
 const outside=storage.filter(f=>dirname(f.path)!==root||!backupName.test(f.path.slice(root.length+1)));
 const optional=OPTIONAL.filter(k=>env[k]).map(variable=>({variable,path:resolve(env[variable])}));
 if(outside.length||optional.length){
  checks.push(issue('BACKUP_SCOPE','blocked',
   '有 '+(outside.length+optional.length)+' 项状态或费用账本位于默认备份范围以外；必须独立规划覆盖'));
 }else checks.push(issue('BACKUP_SCOPE','pass','已知 JSON/JSONL 存储均处于默认备份目录'));
 const lock=resolve(env.ALEX_SERVER_LOCK_FILE||join(dirname(storage[0].path),'.alex-writer.lock'));
 if(lock!==join(root,'.alex-writer.lock')){
  checks.push(issue('WRITER_LOCK_SCOPE','blocked',
   '写入锁不在默认状态目录，R43 离线备份不能仅靠默认锁检查判定停机'));
 }
 let lockPresent=false;
 try{await lstat(lock);lockPresent=true;}catch(error){if(error?.code!=='ENOENT')throw error;}
 checks.push(issue('SERVER_STOPPED',lockPresent?'blocked':'pass',
  lockPresent?'写入锁存在；禁止执行离线升级或备份':'未检测到该路径写入锁；不能代替进程停机核验'));
 let invalid=0,unsupported=0,unsafe=0;
 const filesSeen=new Set();
 for(const item of storage){
  if(filesSeen.has(item.path)){checks.push(issue('DUPLICATE_STORAGE_PATH','blocked','多个存储绑定了同一个文件'));break;}
  filesSeen.add(item.path);
  let stat;
  try{stat=await lstat(item.path);}
  catch(error){if(error?.code==='ENOENT'){missing.push(item.name);continue;}throw error;}
  present.push(item.name);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_JSON_BYTES){unsafe++;continue;}
  if(!item.name.endsWith('.json'))continue;
  let value;
  try{value=JSON.parse(await readFile(item.path,'utf8'));}
  catch{invalid++;continue;}
  if(!value||typeof value!=='object'||Array.isArray(value)){invalid++;continue;}
  if(knownVersion[item.name]!==undefined&&value.version!==knownVersion[item.name])
   unsupported++;
  if(item.name==='skill-batch-wal.json'&&value.version!==undefined&&
   !Number.isSafeInteger(value.version))unsupported++;
 }
 checks.push(issue('STATE_FILES',unsafe?'blocked':invalid?'blocked':unsupported?'blocked':'pass',
  '检测到 '+present.length+' 个已存在存储文件；不安全 '+unsafe+
  '、无效 JSON '+invalid+'、已知版本不兼容 '+unsupported));
 if(backupDir){
  try{
   const result=await verifyOfflineBackup({directory:backupDir});
   checks.push(issue('BACKUP_INTEGRITY',result.status==='verified'?'pass':'blocked',
    '离线备份 SHA-256 文件完整性校验结果：'+result.status));
  }catch{
   checks.push(issue('BACKUP_INTEGRITY','blocked','离线备份无法通过清单和文件摘要验证'));
  }
 }else checks.push(issue('BACKUP_INTEGRITY','manual-required','未提供离线备份；升级前必须另行验证'));
 if(env.AUTH_MODE!=='local')
  checks.push(issue('FAMILY_AUTH','blocked','家庭试用必须启用 AUTH_MODE=local'));
 else if(typeof env.ALEX_PARENT_PASSWORD!=='string'||env.ALEX_PARENT_PASSWORD.length<12)
  checks.push(issue('FAMILY_AUTH','blocked','家长认证配置缺失或不满足最小长度'));
 else checks.push(issue('FAMILY_AUTH','pass','已检测到本地家长认证配置（不回显）'));
 if(!Number.isInteger(Number(process.versions.node.split('.')[0]))||
  Number(process.versions.node.split('.')[0])<20)
  checks.push(issue('NODE_RUNTIME','blocked','Node.js 运行版本不满足 >=20'));
 else checks.push(issue('NODE_RUNTIME','pass','Node.js 运行环境符合最低版本'));
 // 会话仅在家长显式启用持久化后才写入备份；默认内存会话不可能跨重启恢复。
 checks.push(issue('CONVERSATION_PERSISTENCE',env.ALEX_CONVERSATION_PERSIST==='1'?'pass':'manual-required',
  env.ALEX_CONVERSATION_PERSIST==='1'
   ?'已启用本地对话持久化，仍需在隔离恢复副本中实测加载'
   :'对话持久化未开启，重启后原内存会话不可恢复；需家长决定是否留存文字记录'));
 checks.push(issue('REAL_USER_ACCEPTANCE','manual-required',
  '此工具没有测试浏览器、云端音频、真实 ROS2/Nav2、安全与升级后业务加载'));
 const blocked=checks.filter(c=>c.status==='blocked').map(c=>c.id);
 const manual=checks.filter(c=>c.status==='manual-required').map(c=>c.id);
 return {schemaVersion:'alex.dev/release-preflight/v1',
  status:blocked.length?'blocked':'manual-review-required',
  blocked,manual,checks,readOnly:true,upgradeExecuted:false,
  rollbackExecuted:false,releaseApproved:false,
  storage:{known:storage.length,existing:present.length,absent:missing.length,
   outsideDefaultBackup:outside.length+optional.length},
  note:'静态检查及摘要验证不能替代升级/回滚实测和正式发布审批'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length>2){
  console.error('用法: node scripts/release-preflight.mjs [状态目录] [备份目录]');
  process.exitCode=2;
 }else{
  try{
   const result=await inspectReleasePreflight({stateDir:args[0]??'.local',
    backupDir:args[1]??null});
   console.log(JSON.stringify(result,null,2));
   if(result.blocked.length)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=2;}
 }
}
