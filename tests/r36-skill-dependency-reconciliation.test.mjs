import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSkillDependencies,requireSkillDependencyIntegrity} from '../scripts/skill-dependency-graph.mjs';
import {reconcileSkillStores} from '../scripts/skill-store-reconciliation.mjs';
const pkg=(id,version,deps=[],status='approved')=>({manifest:{id,version,dependencies:deps},status});
const dep=(id,version)=>({id,version});
test('R36 resolves pinned multi-level dependencies in dependency-first order',()=>{
 const packages=[pkg('root.app','1.0.0',[dep('branch.app','1.0.0')]),
  pkg('branch.app','1.0.0',[dep('leaf.app','1.0.0')]),pkg('leaf.app','1.0.0')];
 const installed=[dep('root.app','1.0.0'),dep('branch.app','1.0.0'),dep('leaf.app','1.0.0')];
 const result=analyzeSkillDependencies({packages,installed});
 assert.equal(result.valid,true);
 assert.ok(result.order.indexOf('leaf.app@1.0.0')<result.order.indexOf('branch.app@1.0.0'));
 assert.ok(result.order.indexOf('branch.app@1.0.0')<result.order.indexOf('root.app@1.0.0'));
 assert.deepEqual(requireSkillDependencyIntegrity({packages,installed,references:[]}),result);
});
test('R36 catches pinned version drift and dependency cycles',()=>{
 const packages=[pkg('first.app','1.0.0',[dep('second.app','1.0.0')]),
  pkg('second.app','1.0.0',[dep('first.app','1.0.0')])];
 const installed=[dep('first.app','1.0.0'),dep('second.app','1.0.0')];
 const graph=analyzeSkillDependencies({packages,installed});
 assert.equal(graph.valid,false);
 assert.equal(graph.cycles.length,1);
 assert.throws(()=>requireSkillDependencyIntegrity({packages,installed,references:[]}),/SKILL_DEPENDENCY_CYCLE/);
 const drift=analyzeSkillDependencies({packages,installed:[dep('first.app','1.0.0'),dep('second.app','2.0.0')]});
 assert.ok(drift.missing.some(m=>m.reason==='not-installed-at-pinned-version'));
});
test('R36 missing dependency and orphan manual reference are fatal',()=>{
 const state={packages:[pkg('root.app','1.0.0',[dep('missing.app','1.0.0')])],
  installed:[dep('root.app','1.0.0')],references:[{skillId:'lost.app',version:'1.0.0'}]};
 const graph=analyzeSkillDependencies(state);
 assert.ok(graph.missing.length);
 assert.equal(graph.orphans.length,1);
 assert.throws(()=>requireSkillDependencyIntegrity(state),/SKILL_DEPENDENCY_INCONSISTENT/);
});
test('R36 read-only reconciliation distinguishes missing evidence, revoked publisher and unknown runtime refs',()=>{
 const registry={packages:[pkg('missing.pkg','1.0.0'),pkg('revoked.pkg','1.0.0')],installed:[],references:[]};
 const trust={publishers:[{id:'vendor.revoked',revoked:true}],
  attestations:[{id:'revoked.pkg',version:'1.0.0',publisherId:'vendor.revoked'}]};
 const usage={runtime:[{skillId:'mystery.skill',version:null,provenance:'unknown'}]};
 const snapshot=structuredClone({registry,trust,usage});
 const health=reconcileSkillStores({registry,trust,usage});
 assert.equal(health.status,'needs-review');
 assert.ok(health.findings.some(f=>f.kind==='missing-attestation'));
 assert.ok(health.findings.some(f=>f.kind==='publisher-revoked'));
 assert.ok(health.findings.some(f=>f.kind==='unresolved-runtime-skill'));
 assert.equal(health.executable,false);
 assert.deepEqual({registry,trust,usage},snapshot);
});
test('R36 complete reconciliation remains read-only and marks consistent',()=>{
 const registry={packages:[pkg('trusted.pkg','1.0.0')],installed:[dep('trusted.pkg','1.0.0')],references:[]};
 const trust={publishers:[{id:'vendor.valid',revoked:false}],attestations:[{id:'trusted.pkg',version:'1.0.0',publisherId:'vendor.valid'}]};
 const health=reconcileSkillStores({registry,trust,usage:{runtime:[]}});
 assert.equal(health.status,'consistent');
 assert.equal(health.dependencyGraph.valid,true);
 assert.match(health.recovery,/read-only/);
});
