// R36 declarative-only dependency graph. No package loading, network or device execution.
const pair=(id,version)=>id+'@'+version;
const fail=code=>{throw Error(code);};
export function analyzeSkillDependencies({packages=[],installed=[],references=[]}={}){
 if(!Array.isArray(packages)||!Array.isArray(installed)||!Array.isArray(references))
  fail('INVALID_SKILL_GRAPH');
 const catalog=new Map();
 for(const entry of packages){
  if(!entry?.manifest?.id||!entry.manifest.version||!Array.isArray(entry.manifest.dependencies))
   fail('INVALID_SKILL_GRAPH');
  const k=pair(entry.manifest.id,entry.manifest.version);
  if(catalog.has(k))fail('SKILL_GRAPH_DUPLICATE');
  catalog.set(k,entry);
 }
 const pins=new Map();
 for(const item of installed){
  if(!item?.id||!item.version||pins.has(item.id))fail('INVALID_SKILL_GRAPH');
  pins.set(item.id,item.version);
 }
 const color=new Map(),order=[],cycles=[],missing=[],unapproved=[];
 const inspect=(key,path)=>{
  if(color.get(key)===2)return;
  if(color.get(key)===1){
   const start=path.indexOf(key);
   cycles.push([...path.slice(start),key]);
   return;
  }
  const node=catalog.get(key);
  if(!node){missing.push({from:path.at(-1)??null,dependency:key,reason:'not-registered'});return;}
  color.set(key,1);
  if(node.status!=='approved')unapproved.push(key);
  for(const dep of node.manifest.dependencies){
   const target=pair(dep.id,dep.version);
   if(!catalog.has(target))missing.push({from:key,dependency:target,reason:'not-registered'});
   else if(pins.get(dep.id)!==dep.version)
    missing.push({from:key,dependency:target,reason:'not-installed-at-pinned-version'});
   inspect(target,[...path,key]);
  }
  color.set(key,2);
  order.push(key);
 };
 for(const p of installed)inspect(pair(p.id,p.version),[]);
 const orphans=references.filter(r=>pins.get(r.skillId)!==r.version);
 return structuredClone({order,cycles,missing,unapproved,orphans,
  valid:cycles.length===0&&missing.length===0&&unapproved.length===0&&orphans.length===0});
}
export function requireSkillDependencyIntegrity(state){
 const graph=analyzeSkillDependencies(state);
 if(graph.cycles.length)fail('SKILL_DEPENDENCY_CYCLE');
 if(graph.missing.length||graph.unapproved.length||graph.orphans.length)
  fail('SKILL_DEPENDENCY_INCONSISTENT');
 return graph;
}
