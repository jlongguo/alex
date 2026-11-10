// R38 metadata-only multi-package upgrade planner; never mutates registry state.
const fail=x=>{throw Error(x);};
const key=(id,v)=>id+'@'+v;
const cmp=(a,b)=>{for(let i=0;i<3;i++){const d=Number(a.split('.')[i])-Number(b.split('.')[i]);if(d)return d>0?1:-1;}return 0;};
export function planSkillUpgrade({registry,targets,verify=()=>({})}={}){
 if(!registry||!Array.isArray(registry.packages)||!Array.isArray(registry.installed)||
   !Array.isArray(registry.references)||!Array.isArray(targets)||
   targets.length<1||targets.length>12||typeof verify!=='function')
  fail('INVALID_SKILL_UPGRADE_PLAN');
 const ids=new Set(),catalog=new Map(),installed=new Map(registry.installed.map(x=>[x.id,x.version]));
 for(const p of registry.packages)catalog.set(key(p.manifest.id,p.manifest.version),p);
 const changes=[],blockers=[];
 for(const target of targets){
  if(!target||typeof target.id!=='string'||typeof target.version!=='string'||
    !/^[a-z][a-z0-9.-]{2,79}$/.test(target.id)||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target.version)||
    ids.has(target.id))fail('INVALID_SKILL_UPGRADE_TARGET');
  ids.add(target.id);
  const candidate=catalog.get(key(target.id,target.version));
  if(!candidate){blockers.push({id:target.id,reason:'UNKNOWN_SKILL_PACKAGE'});continue;}
  if(candidate.status!=='approved')blockers.push({id:target.id,reason:'SKILL_NOT_APPROVED'});
  try{verify(candidate.manifest);}
  catch(e){blockers.push({id:target.id,reason:e?.message??'SKILL_ATTESTATION_REQUIRED'});}
  const current=installed.get(target.id)??null;
  const prior=current?catalog.get(key(target.id,current))?.manifest:null;
  if(prior&&cmp(target.version,current)<0)
   blockers.push({id:target.id,reason:'SKILL_ROLLBACK_REQUIRES_REVIEW'});
  if(prior&&(candidate.manifest.permissions.some(p=>!prior.permissions.includes(p))||
    candidate.manifest.allowedActors.some(a=>!prior.allowedActors.includes(a))))
   blockers.push({id:target.id,reason:'SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL'});
  if(prior&&registry.references.some(r=>r.skillId===target.id&&r.version===current))
   blockers.push({id:target.id,reason:'SKILL_REFERENCES_PINNED'});
  if(current!==target.version)changes.push({id:target.id,from:current,to:target.version,
    dependencies:structuredClone(candidate.manifest.dependencies)});
 }
 const simulated=new Map(installed),remaining=[...changes],steps=[];
 // Only produce a plan if each operation would pass the existing pinned dependency and dependent checks.
 while(remaining.length&&!blockers.length){
  let choice=-1;
  for(let index=0;index<remaining.length;index++){
   const item=remaining[index],candidate=catalog.get(key(item.id,item.to));
   const ready=candidate.manifest.dependencies.every(d=>simulated.get(d.id)===d.version);
   const depended=item.from!==null&&[...simulated].some(([id,version])=>{
    if(id===item.id)return false;
    const entry=catalog.get(key(id,version));
    return entry?.manifest.dependencies.some(d=>d.id===item.id&&d.version===item.from);
   });
   if(ready&&!depended){choice=index;break;}
  }
  if(choice<0){
   for(const item of remaining)blockers.push({id:item.id,
    reason:'SKILL_UPGRADE_ORDER_UNSATISFIABLE'});
   break;
  }
  const [item]=remaining.splice(choice,1);
  steps.push({id:item.id,version:item.to,expectedCurrentVersion:item.from,
   operation:'install',executable:false});
  simulated.set(item.id,item.to);
 }
 return structuredClone({ready:blockers.length===0,steps:blockers.length?[]:steps,
  blockers,targets:targets.map(t=>({id:t.id,version:t.version})),
  finalPins:blockers.length?null:[...simulated].map(([id,version])=>({id,version})),
  advisory:true,executable:false});
}


// R39 simultaneous target-pin transition. No intermediate invalid state is exposed.
// Validates the FINAL installed graph, not a sequence of individual installations.
// The returned proposal is advisory; the registry MUST revalidate during its queued commit.
export function planAtomicSkillUpgrade({registry,targets,verify=()=>({})}={}){
 if(!registry||!Array.isArray(registry.packages)||!Array.isArray(registry.installed)||
  !Array.isArray(registry.references)||!Array.isArray(targets)||!targets.length||
  targets.length>12||typeof verify!=='function')fail('INVALID_SKILL_UPGRADE_PLAN');
 const catalog=new Map(registry.packages.map(p=>[key(p.manifest.id,p.manifest.version),p]));
 const previous=new Map(registry.installed.map(p=>[p.id,p.version]));
 const desired=new Map(previous),seen=new Set(),blockers=[],changes=[];
 for(const target of targets){
  if(!target||Object.keys(target).sort().join(',')!=='id,version'||
   typeof target.id!=='string'||!/^[a-z][a-z0-9.-]{2,79}$/.test(target.id)||
   typeof target.version!=='string'||!/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/.test(target.version)||
   seen.has(target.id))fail('INVALID_SKILL_UPGRADE_TARGET');
  seen.add(target.id);
  const p=catalog.get(key(target.id,target.version));
  if(!p){blockers.push({id:target.id,reason:'UNKNOWN_SKILL_PACKAGE'});continue;}
  if(p.status!=='approved')blockers.push({id:target.id,reason:'SKILL_NOT_APPROVED'});
  try{verify(p.manifest);}
  catch(error){blockers.push({id:target.id,reason:error?.message??'SKILL_ATTESTATION_REQUIRED'});}
  const old=previous.get(target.id)??null;
  if(old!==null){
   const prior=catalog.get(key(target.id,old))?.manifest;
   if(!prior){blockers.push({id:target.id,reason:'SKILL_INSTALL_CONFLICT'});}
   else{
    if(cmp(target.version,old)<0)blockers.push({id:target.id,reason:'SKILL_ROLLBACK_REQUIRES_REVIEW'});
    if(p.manifest.permissions.some(permission=>!prior.permissions.includes(permission))||
       p.manifest.allowedActors.some(actor=>!prior.allowedActors.includes(actor)))
     blockers.push({id:target.id,reason:'SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL'});
    if(old!==target.version&&registry.references.some(r=>r.skillId===target.id&&r.version===old))
     blockers.push({id:target.id,reason:'SKILL_REFERENCES_PINNED'});
   }
  }
  desired.set(target.id,target.version);
  if(old!==target.version)changes.push({id:target.id,from:old,to:target.version});
 }
 const graph=[],visited=new Set(),active=new Set();
 const visit=(id,path)=>{
  if(active.has(id)){blockers.push({id,reason:'SKILL_DEPENDENCY_CYCLE',path:[...path,id]});return;}
  if(visited.has(id))return;
  active.add(id);
  const p=catalog.get(key(id,desired.get(id)));
  if(!p||p.status!=='approved')blockers.push({id,reason:'SKILL_DEPENDENCY_MISSING'});
  else for(const dependency of p.manifest.dependencies){
   if(desired.get(dependency.id)!==dependency.version)
    blockers.push({id,reason:'SKILL_DEPENDENCY_MISSING',dependency:key(dependency.id,dependency.version)});
   else visit(dependency.id,[...path,id]);
  }
  active.delete(id);visited.add(id);graph.push(id);
 };
 for(const id of desired.keys())visit(id,[]);
 return structuredClone({ready:!blockers.length,advisory:true,atomic:true,executable:false,
  blockers,changes:blockers.length?[]:changes,
  finalPins:blockers.length?null:[...desired].map(([id,version])=>({id,version})),
  dependencyFirst:graph,
  note:'One registry snapshot, never a multi-file or device-command transaction'});
}
