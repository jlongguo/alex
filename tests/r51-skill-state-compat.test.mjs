import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {SkillPackageTrust,manifestDigest,signedPayload} from '../scripts/skill-package-trust.mjs';
import {inspectSkillStateCompatibility} from '../scripts/skill-state-compat.mjs';
import {inspectReleasePreflight} from '../scripts/release-preflight.mjs';

const shape={type:'object',properties:{message:{type:'string'}},
 required:[],additionalProperties:false};
const manifest={schemaVersion:'alex.skill/v1',id:'family.audit',version:'1.0.0',
 name:'发行审核演练',description:'仅包含安全的声明式元数据',
 permissions:[],allowedActors:['parent'],dependencies:[],inputSchema:shape,outputSchema:shape};
const auth={AUTH_MODE:'local',ALEX_PARENT_PASSWORD:'r51-compat-test-parent-password'};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r51-'));
 const registryFile=join(dir,'skill-packages.json');
 const trustFile=join(dir,'skill-trust.json');
 const registry=new SkillPackageRegistry({file:registryFile});
 const trust=new SkillPackageTrust({file:trustFile});
 return {dir,registryFile,trustFile,registry,trust,
  cleanup:()=>rm(dir,{recursive:true,force:true})};
}
async function install(f){
 await f.registry.submit('parent',manifest);
 await f.registry.review('parent',{id:manifest.id,version:manifest.version,decision:'approve'});
 await f.registry.install('parent',{id:manifest.id,version:manifest.version,
  expectedCurrentVersion:null});
}
async function attest(f){
 const keys=generateKeyPairSync('ed25519');
 const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'});
 const artifact=Buffer.from('R51 safe metadata test artifact');
 const mh=manifestDigest(manifest);
 const ah=createHash('sha256').update(artifact).digest('hex');
 const signature=sign(null,signedPayload(mh,ah),keys.privateKey).toString('base64');
 await f.trust.enroll('parent',{publisherId:'family.r51',publicKeyPem});
 await f.trust.attest('parent',{manifest,publisherId:'family.r51',
  artifactBase64:artifact.toString('base64'),signature});
}
test('R51 空白新装只读检查不产生存储文件也不批准上线',async()=>{
 const f=await fixture();try{
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.deepEqual(report.blocked,[]);
  assert.equal(report.checks[0].status,'absent');
  assert.equal(report.checks[1].status,'absent');
  assert.equal(report.readOnly,true);
  assert.equal(report.releaseApproved,false);
  assert.deepEqual(await readdir(f.dir),[]);
 }finally{await f.cleanup();}
});
test('R51 Ed25519 真实签名与已安装 Skill 版本一致时，正式加载器审计通过',async()=>{
 const f=await fixture();try{
  await install(f);await attest(f);
  const before=[await readFile(f.registryFile),await readFile(f.trustFile)];
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.deepEqual(report.blocked,[]);
  assert.equal(report.checks.find(x=>x.id==='INSTALLED_PROVENANCE').status,'pass');
  assert.equal(report.counts.installed,1);
  assert.equal(report.counts.attestations,1);
  assert.equal(report.releaseApproved,false);
  assert.deepEqual(await readFile(f.registryFile),before[0]);
  assert.deepEqual(await readFile(f.trustFile),before[1]);
  const readiness=await inspectReleasePreflight({stateDir:f.dir,env:auth});
  assert.equal(readiness.checks.find(c=>c.id==='SKILL_INSTALLED_PROVENANCE').status,'pass');
  assert.equal(readiness.releaseApproved,false);
 }finally{await f.cleanup();}
});
test('R51 安装版本缺失签名时必须拒绝，不能以 registry status=approved 冒充信任',async()=>{
 const f=await fixture();try{
  await install(f);
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.ok(report.blocked.includes('INSTALLED_PROVENANCE'));
  assert.equal(report.checks.find(x=>x.id==='INSTALLED_PROVENANCE').rejected,1);
  const readiness=await inspectReleasePreflight({stateDir:f.dir,env:auth});
  assert.ok(readiness.blocked.includes('SKILL_INSTALLED_PROVENANCE'));
 }finally{await f.cleanup();}
});
test('R51 Trust 文件签名被修改后，原加载器直接拒绝状态',async()=>{
 const f=await fixture();try{
  await install(f);await attest(f);
  const raw=JSON.parse(await readFile(f.trustFile,'utf8'));
  raw.attestations[0].signature='A'.repeat(88);
  await writeFile(f.trustFile,JSON.stringify(raw));
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.ok(report.blocked.includes('TRUST'));
  assert.ok(report.blocked.includes('INSTALLED_PROVENANCE'));
  assert.equal(JSON.stringify(report).includes('BEGIN PUBLIC KEY'),false);
 }finally{await f.cleanup();}
});
test('R51 Registry 历史链被破坏，加载器拒绝而不是仅看 JSON 能否解析',async()=>{
 const f=await fixture();try{
  await install(f);await attest(f);
  const raw=JSON.parse(await readFile(f.registryFile,'utf8'));
  raw.history[0].hash='f'.repeat(64);
  await writeFile(f.registryFile,JSON.stringify(raw));
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.ok(report.blocked.includes('REGISTRY'));
  assert.ok(report.blocked.includes('INSTALLED_PROVENANCE'));
 }finally{await f.cleanup();}
});
test('R51 Registry v1 能在内存读成 v2，但保持原快照原样并要求人工迁移评审',async()=>{
 const f=await fixture();try{
  const legacy={schemaVersion:1,packages:[],installed:[],references:[]};
  await writeFile(f.registryFile,JSON.stringify(legacy));
  const raw=await readFile(f.registryFile,'utf8');
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.deepEqual(report.blocked,[]);
  assert.deepEqual(report.manual,['REGISTRY']);
  assert.equal(report.checks[0].reason,'LEGACY_V1_IN_MEMORY_ONLY');
  assert.equal(await readFile(f.registryFile,'utf8'),raw);
  const readiness=await inspectReleasePreflight({stateDir:f.dir,env:auth});
  assert.ok(readiness.manual.includes('SKILL_REGISTRY'));
 }finally{await f.cleanup();}
});
test('R51 链接和状态都合法但自定义 Trust 文件路径被采用时仍安全读取',async()=>{
 const f=await fixture();try{
  await install(f);await attest(f);
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:{
   ...auth(),ALEX_SKILL_TRUST_FILE:f.trustFile}});
  assert.deepEqual(report.blocked,[]);
  assert.equal(report.checks[1].status,'pass');
 }finally{await f.cleanup();}
});
test('R51 CLI 只输出统计数据、不泄露元数据或家长认证配置',async()=>{
 const f=await fixture();try{
  await install(f);
  const script=resolve(import.meta.dirname,'../scripts/skill-state-compat.mjs');
  const run=spawnSync(process.execPath,[script,f.dir],{encoding:'utf8',timeout:12000,
   env:{...process.env,AUTH_MODE:'local',ALEX_PARENT_PASSWORD:auth.ALEX_PARENT_PASSWORD}});
  assert.equal(run.status,1,run.stderr);
  const report=JSON.parse(run.stdout);
  assert.ok(report.blocked.includes('INSTALLED_PROVENANCE'));
  assert.equal(JSON.stringify(report).includes(manifest.name),false);
  assert.equal(JSON.stringify(report).includes(auth.ALEX_PARENT_PASSWORD),false);
  assert.equal(report.registryModified,false);
  assert.equal(report.trustModified,false);
 }finally{await f.cleanup();}
});

test('R51 未安装的历史包若丢失 Trust 文件，也不能冒充全新安装',async()=>{
 const f=await fixture();try{
  await f.registry.submit('parent',manifest);
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.ok(report.blocked.includes('STATE_PAIR'));
  assert.equal(report.counts.installed,0);
  assert.equal(report.counts.packages,1);
  assert.equal(report.releaseApproved,false);
 }finally{await f.cleanup();}
});
test('R51 发行者被撤销后，已安装包不再满足发布证明',async()=>{
 const f=await fixture();try{
  await install(f);await attest(f);
  await f.trust.revoke('parent',{publisherId:'family.r51'});
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.equal(report.checks.find(c=>c.id==='TRUST').status,'pass');
  assert.ok(report.blocked.includes('INSTALLED_PROVENANCE'));
  assert.equal(report.checks.find(c=>c.id==='INSTALLED_PROVENANCE').rejected,1);
 }finally{await f.cleanup();}
});
test('R51 禁止使用符号链接作为 Registry 数据源',async()=>{
 const f=await fixture();try{
  const {symlink}=await import('node:fs/promises');
  await symlink(join(f.dir,'outside.json'),f.registryFile);
  const report=await inspectSkillStateCompatibility({stateDir:f.dir,env:auth});
  assert.ok(report.blocked.includes('REGISTRY'));
  assert.ok(report.blocked.includes('INSTALLED_PROVENANCE'));
 }finally{await f.cleanup();}
});
