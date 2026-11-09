// R36 read-only reconciliation between independently persisted trust, package, and consumer stores.
// Never changes parent decisions, never replays device jobs, and never executes package artifacts.
import {analyzeSkillDependencies} from './skill-dependency-graph.mjs';
export function reconcileSkillStores({registry,trust,usage}={}){
 if(!registry||!trust||!usage||!Array.isArray(registry.packages)||
  !Array.isArray(registry.installed)||!Array.isArray(trust.publishers)||
  !Array.isArray(trust.attestations)||!Array.isArray(usage.runtime))
  throw Error('INVALID_SKILL_RECONCILIATION');
 const graph=analyzeSkillDependencies(registry);
 const findings=[];
 const publisher=new Map(trust.publishers.map(p=>[p.id,p]));
 const attestation=new Map(trust.attestations.map(a=>[a.id+'@'+a.version,a]));
 for(const item of registry.packages.filter(p=>p.status==='approved')){
  const m=item.manifest,a=attestation.get(m.id+'@'+m.version);
  if(!a)findings.push({kind:'missing-attestation',id:m.id,version:m.version});
  else if(!publisher.has(a.publisherId)||publisher.get(a.publisherId).revoked)
   findings.push({kind:'publisher-revoked',id:m.id,version:m.version});
 }
 for(const installed of registry.installed){
  const matching=registry.packages.find(p=>p.manifest.id===installed.id&&p.manifest.version===installed.version);
  if(!matching||matching.status!=='approved')
   findings.push({kind:'invalid-installed-version',id:installed.id,version:installed.version});
 }
 for(const r of usage.runtime.filter(r=>r.provenance==='unknown'))
  findings.push({kind:'unresolved-runtime-skill',id:r.skillId,version:r.version??null});
 if(graph.cycles.length)findings.push({kind:'dependency-cycle',count:graph.cycles.length});
 if(graph.missing.length)findings.push({kind:'dependency-gap',count:graph.missing.length});
 if(graph.orphans.length)findings.push({kind:'orphan-reference',count:graph.orphans.length});
 return structuredClone({schemaVersion:1,status:findings.length?'needs-review':'consistent',
  checked:{packages:registry.packages.length,installed:registry.installed.length,
   publishers:trust.publishers.length,attestations:trust.attestations.length,
   runtimeReferences:usage.runtime.length},
  findings,dependencyGraph:graph,
  recovery:'read-only: never auto-revoke, auto-install, auto-approve or replay commands',
  executable:false});
}
