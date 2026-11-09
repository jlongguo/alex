// R29 read-only provenance projection. No state mutations or replay.
// It reconciles the *existing* durable Plan, Workflow and Gateway snapshots.
const validId=id=>typeof id==='string'&&/^(plan|wf)-[0-9a-f-]{36}$/.test(id);
const validLimit=n=>Number.isSafeInteger(n)&&n>=1&&n<=100;
const copy=x=>structuredClone(x);
const FINISHED=new Set(['succeeded','failed','cancelled','stopped']);
const REQUEST=/^[a-zA-Z0-9_-]{8,100}$/;
function classifyDeviceStep(job,events){
 const snapshot=job?{jobId:job.id,deviceId:job.deviceId,capability:job.capability,
  status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,
  reason:job.reason??null,requestId:job.requestId}:null;
 return {job:snapshot,events:events.map(e=>({
  seq:e.seq,type:e.type,status:e.status,at:e.at,jobId:e.jobId,
  deviceId:e.deviceId,requestId:e.requestId??null
 }))};
}
export class ExecutionTraceProjector{
 constructor({plans,workflows,gateway}={}){
  if(typeof plans?.list!=='function'||typeof plans?.getEvents!=='function'
   ||typeof workflows?.list!=='function'||typeof gateway?.list!=='function'
   ||typeof gateway?.getEvents!=='function')
   throw Error('EXECUTION_TRACE_DEPENDENCIES_REQUIRED');
  this.plans=plans;this.workflows=workflows;this.gateway=gateway;
 }
 #roots(){
  return [
   ...this.plans.list().map(p=>({kind:'plan',id:p.id,requestId:p.requestId,
    status:p.status,deviceId:p.deviceId,createdAt:p.createdAt,
    updatedAt:p.updatedAt,reason:p.reason??null,record:p})),
   ...this.workflows.list().map(w=>({kind:'workflow',id:w.id,requestId:w.requestId,
    status:w.status,deviceId:w.deviceId,createdAt:w.createdAt,
    updatedAt:w.updatedAt,reason:w.reason??null,record:w}))
  ];
 }
 #sorted({limit=25,kind,deviceId}={}){
  if(!validLimit(limit)||kind!==undefined&&!['plan','workflow'].includes(kind)
   ||deviceId!==undefined&&!(typeof deviceId==='string'&&/^dev-[0-9a-f-]{36}$/.test(deviceId)))
   throw Error('INVALID_EXECUTION_TRACE_FILTER');
  return this.#roots().filter(r=>(!kind||r.kind===kind)
   &&(!deviceId||r.deviceId===deviceId))
   .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)
     ||a.id.localeCompare(b.id));
 }
 list(options={}){
  return this.#sorted(options).slice(0,options.limit??25)
   .map(({record,...meta})=>copy(meta));
 }
 // Keyset pagination is stable under newly inserted executions. Cursor
 // carries only the last (createdAt, ID) key plus bound filter scope.
 page({limit=25,kind,deviceId,cursor}={}){
  const roots=this.#sorted({limit,kind,deviceId});
  let key=null;
  if(cursor!==undefined){
   if(typeof cursor!=='string'||cursor.length>350||! /^[A-Za-z0-9_-]{12,350}$/.test(cursor))
    throw Error('INVALID_EXECUTION_TRACE_CURSOR');
   let decoded;
   try{decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}
   catch{throw Error('INVALID_EXECUTION_TRACE_CURSOR');}
   if(!decoded||decoded.v!==1||!validId(decoded.id)
    ||typeof decoded.at!=='string'||!Number.isFinite(Date.parse(decoded.at))
    ||decoded.kind!==(kind??null)||decoded.deviceId!==(deviceId??null)
    ||Object.keys(decoded).sort().join(',')!=='at,deviceId,id,kind,v'
    ||Buffer.from(JSON.stringify(decoded)).toString('base64url')!==cursor)
    throw Error('INVALID_EXECUTION_TRACE_CURSOR');
   key={at:Date.parse(decoded.at),id:decoded.id};
  }
  const remaining=key?roots.filter(r=>{
   const at=Date.parse(r.createdAt);
   return at<key.at||(at===key.at&&r.id.localeCompare(key.id)>0);
  }):roots;
  const page=remaining.slice(0,limit);
  const hasMore=remaining.length>limit;
  const last=page.at(-1);
  return {executions:page.map(({record,...meta})=>copy(meta)),
   hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({
    v:1,at:last.createdAt,id:last.id,kind:kind??null,
    deviceId:deviceId??null
   })).toString('base64url'):null};
 }
 get(id){
  if(!validId(id))throw Error('INVALID_EXECUTION_TRACE_ID');
  const root=this.#roots().find(r=>r.id===id);
  if(!root)return null;
  const gatewayJobs=this.gateway.list();
  const byId=new Map(gatewayJobs.map(j=>[j.id,j]));
  const eventWindow=this.gateway.getEvents(0,{limit:500});
  // Gather from the bounded gateway journal only, never from child content.
  const events=eventWindow.events;
  const record=root.record;
  const definition=root.kind==='plan'?record.steps.map(s=>({
   stepId:s.id,kind:s.kind,status:s.status,dependsOn:[...s.dependsOn],
   skillId:s.kind==='skill'?(
    record.templateId==='learn.at.desk'?'learning.english':'story.interactive'
   ):null,jobId:s.jobId??null
  })):record.steps.map(s=>({
   stepId:s.name,kind:s.name==='skill'?'skill':'device',status:s.status,
   dependsOn:[],skillId:s.skillId??null,jobId:s.jobId??null
  }));
  const steps=definition.map(step=>{
   const dispatchRequestId=step.kind==='device'
    ?(root.kind==='plan'?root.id+'-'+step.stepId
      :step.stepId==='navigation'?root.id+'-nav':root.id+'-audio'):null;
   // Plans persist the exact job ID. Workflows additionally store navigation/audio IDs.
   const storedJobId=step.jobId??(root.kind==='workflow'
    ?step.stepId==='navigation'?record.navigationJobId
      :step.stepId==='audio'?record.audioJobId:null:null);
   const matched=gatewayJobs.filter(j=>j.deviceId===root.deviceId
    &&j.requestId===dispatchRequestId);
   const job=storedJobId?byId.get(storedJobId):
    matched.find(j=>j.id===storedJobId)??matched[0];
   const conflict=Boolean(job&&(job.requestId!==dispatchRequestId
    ||job.deviceId!==root.deviceId||storedJobId&&job.id!==storedJobId));
   const related=!conflict?events.filter(e=>e.jobId===job?.id
    &&e.deviceId===root.deviceId&&e.requestId===dispatchRequestId):[];
   return {...step,dispatchRequestId,correlation:step.kind==='skill'
     ?'local-skill-step':conflict?'conflict':job?'matched':'missing',
    ...classifyDeviceStep(conflict?null:job,related),
    eventHistoryTruncated:!conflict&&job&&eventWindow.oldestSeq!==null
     &&eventWindow.oldestSeq>1};
  });
  const planEvents=root.kind==='plan'?this.plans.getEvents().filter(e=>e.planId===id)
   .map(e=>({seq:e.seq,type:e.type,stepId:e.stepId,
    status:e.status,at:e.at})):[];
  return copy({id:root.id,kind:root.kind,status:root.status,
   requestId:root.requestId,deviceId:root.deviceId,createdAt:root.createdAt,
   updatedAt:root.updatedAt,reason:root.reason,steps,planEvents,
   simulationOnly:true,retention:{
    gatewayOldestSeq:eventWindow.oldestSeq,gatewayLatestSeq:eventWindow.latestSeq,
    gatewayHistoryMayBeTruncated:eventWindow.oldestSeq!==null
      &&eventWindow.oldestSeq>1,
    planEventsMayBeTruncated:root.kind==='plan'&&planEvents.length===0
      &&this.plans.getEvents().length>0
   },note:'Projection of existing allowlisted plan/workflow, skill and virtual device state; no autonomous tool execution or physical action'}
  );
 }
}
