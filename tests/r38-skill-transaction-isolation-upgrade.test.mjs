import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillPackageRegistry} from '../scripts/skill-package-registry.mjs';
import {SkillPackageTransactions} from '../scripts/skill-package-transactions.mjs';
import {planSkillUpgrade} from '../scripts/skill-upgrade-planner.mjs';
const shape={type:'object',properties:{},required:[],additionalProperties:false};
const manifest=(id,version,dependencies=[],permissions=[],allowedActors=['parent'])=>({
 schemaVersion:'alex.skill/v1',id,version,name:'Metadata',description:'No executable code',
 permissions,allowedActors,dependencies,inputSchema:shape,outputSchema:shape
});
const proof={publisherId:'family.publisher',manifestSha256:'1'.repeat(64),artifactSha256:'2'.repeat(64)};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'alex-r38-'));
 const registry=new SkillPackageRegistry({file:join(dir,'registry.json')});
 const trust={assertTrusted:()=>({...proof})};
 const transactions=new SkillPackageTransactions({file:join(dir,'tx.json'),registry,trust});
 return {registry,transactions,trust,close:()=>rm(dir,{recursive:true,force:true})};
}
const req=(id,version='1.0.0',suffix='001')=>({operationId:'parent-operation-'+suffix,id,version,expectedCurrentVersion:null});
test('R38 pending WAL blocks direct registry mutations until recovered, including other package writes',async()=>{
 const f=await fixture();try{
  await f.registry.submit('parent',manifest('family.alpha','1.0.0'));
  const original=f.registry.review.bind(f.registry);
  f.registry.review=async()=>{throw Error('INJECTED_APPROVAL_PAUSE');};
  await assert.rejects(f.transactions.apply('parent',req('family.alpha')),/INJECTED_APPROVAL_PAUSE/);
  await assert.rejects(f.registry.submit('parent',manifest('family.beta','1.0.0')),/SKILL_TRANSACTION_ISOLATED/);
  await assert.rejects(original('parent',{id:'family.alpha',version:'1.0.0',decision:'approve'}),/SKILL_TRANSACTION_ISOLATED/);
  assert.equal(f.registry.list('parent').history.length,1);
  f.registry.review=original;
  const recovery=await f.transactions.recover('parent');
  assert.equal(recovery.pending,0);
  assert.equal(f.registry.list('parent').installed[0].id,'family.alpha');
  await f.registry.submit('parent',manifest('family.beta','1.0.0'));
 }finally{await f.close();}
});
test('R38 abandon only untouched prepared intent; subsequent operations are unblocked',async()=>{
 const f=await fixture();try{
  await f.registry.submit('parent',manifest('family.alpha','1.0.0'));
  f.registry.review=async()=>{throw Error('INJECTED_CRASH_BEFORE_REVIEW');};
  await assert.rejects(f.transactions.apply('parent',req('family.alpha')),/INJECTED_CRASH_BEFORE_REVIEW/);
  assert.equal(f.transactions.readiness('parent').pending.length,1);
  assert.throws(()=>f.transactions.abandon('child',{operationId:'parent-operation-001'}),/PARENT_REQUIRED/);
  assert.equal((await f.transactions.abandon('parent',{operationId:'parent-operation-001'})).status,'abandoned');
  assert.equal(f.transactions.list('parent').records[0].phase,'blocked');
  assert.equal((await f.transactions.recover('parent')).pending,0);
  await f.registry.submit('parent',manifest('family.beta','1.0.0'));
  assert.equal(f.transactions.readiness('parent').remaining,399);
 }finally{await f.close();}
});
test('R38 cannot abandon after approval side effects; leaves prepared WAL for reconciliation',async()=>{
 const f=await fixture();try{
  await f.registry.submit('parent',manifest('family.alpha','1.0.0'));
  f.registry.install=async()=>{throw Error('INJECTED_CRASH_AFTER_REVIEW');};
  await assert.rejects(f.transactions.apply('parent',req('family.alpha')),/INJECTED_CRASH_AFTER_REVIEW/);
  await assert.rejects(f.transactions.abandon('parent',{operationId:'parent-operation-001'}),
    /SKILL_TRANSACTION_PARTIAL_EFFECTS/);
  assert.equal(f.transactions.readiness('parent').pending.length,1);
  assert.equal(f.registry.list('parent').packages[0].status,'approved');
 }finally{await f.close();}
});
test('R38 ordered multi-package fresh installations respect dependencies',()=>{
 const packages=[
  {manifest:manifest('family.root','1.0.0',[{id:'family.mid',version:'1.0.0'}]),status:'approved'},
  {manifest:manifest('family.mid','1.0.0',[{id:'family.leaf',version:'1.0.0'}]),status:'approved'},
  {manifest:manifest('family.leaf','1.0.0'),status:'approved'}
 ];
 const result=planSkillUpgrade({registry:{packages,installed:[],references:[]},
  targets:[{id:'family.root',version:'1.0.0'},{id:'family.mid',version:'1.0.0'},
   {id:'family.leaf',version:'1.0.0'}]});
 assert.equal(result.ready,true);
 assert.deepEqual(result.steps.map(x=>x.id),['family.leaf','family.mid','family.root']);
 assert.equal(result.advisory,true);
 assert.equal(result.executable,false);
});
test('R38 unsatisfiable pinned upgrade order never emits partially executable steps',()=>{
 const packages=[
  {manifest:manifest('family.a','1.0.0',[{id:'family.b',version:'1.0.0'}]),status:'approved'},
  {manifest:manifest('family.b','1.0.0'),status:'approved'},
  {manifest:manifest('family.a','2.0.0',[{id:'family.b',version:'2.0.0'}]),status:'approved'},
  {manifest:manifest('family.b','2.0.0'),status:'approved'}
 ];
 const result=planSkillUpgrade({registry:{packages,installed:[
  {id:'family.a',version:'1.0.0'},{id:'family.b',version:'1.0.0'}],references:[]},
  targets:[{id:'family.a',version:'2.0.0'},{id:'family.b',version:'2.0.0'}]});
 assert.equal(result.ready,false);
 assert.deepEqual(result.steps,[]);
 assert.ok(result.blockers.some(x=>x.reason==='SKILL_UPGRADE_ORDER_UNSATISFIABLE'));
});
test('R38 safety constraints include attestation, permission change and explicit references',()=>{
 const packages=[
  {manifest:manifest('family.a','1.0.0'),status:'approved'},
  {manifest:manifest('family.a','2.0.0',[],['audio.input']),status:'approved'}
 ];
 const result=planSkillUpgrade({registry:{packages,installed:[{id:'family.a',version:'1.0.0'}],
  references:[{skillId:'family.a',version:'1.0.0'}]},
  targets:[{id:'family.a',version:'2.0.0'}],verify:()=>{throw Error('PUBLISHER_NOT_ACTIVE');}});
 assert.equal(result.ready,false);assert.deepEqual(result.steps,[]);
 assert.ok(result.blockers.some(x=>x.reason==='PUBLISHER_NOT_ACTIVE'));
 assert.ok(result.blockers.some(x=>x.reason==='SKILL_REFERENCES_PINNED'));
 assert.ok(result.blockers.some(x=>x.reason==='SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL'));
});
