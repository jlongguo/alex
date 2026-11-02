import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';

// v0.7: allowlisted plan compilation and dependency-gated execution. Virtual devices only.
const templates={
  'learn.at.desk':[
    {id:'move',kind:'device',capability:'sim.navigation.goto',params:{destination:'study_desk'},dependsOn:[]},
    {id:'teach',kind:'skill',skillId:'learning.english',dependsOn:['move']},
    {id:'say',kind:'device',capability:'audio.output',dependsOn:['teach']}
  ],
  'story.at.corner':[
    {id:'move',kind:'device',capability:'sim.navigation.goto',params:{destination:'story_corner'},dependsOn:[]},
    {id:'tell',kind:'skill',skillId:'story.interactive',dependsOn:['move']},
    {id:'say',kind:'device',capability:'audio.output',dependsOn:['tell']}
  ],
  'story.here':[
    {id:'tell',kind:'skill',skillId:'story.interactive',dependsOn:[]},
    {id:'say',kind:'device',capability:'audio.output',dependsOn:['tell']}
  ]
};
export const PLAN_TEMPLATES=Object.freeze(Object.fromEntries(Object.entries(templates).map(([k,v])=>[k,Object.freeze(structuredClone(v))])));
const terminal=new Set(['succeeded','failed','cancelled','stopped']);
const requestValid=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(s);
const deviceValid=s=>typeof s==='string'&&/^dev-[0-9a-f-]{36}$/.test(s);
const clone=structuredClone;

/** A model may suggest only a template ID, never an arbitrary tool, DAG or device command. */
export function compilePlan(intent){
  if(typeof intent!=='string'||intent.length>500)return null;
  const s=intent.trim().toLowerCase();
  if(/(书桌|学习区|desk)/.test(s)&&/(英语|英文|english)/.test(s))return 'learn.at.desk';
  if(/(故事角|story.?corner)/.test(s)&&/(故事|story)/.test(s))return 'story.at.corner';
  if(/(讲个故事|讲故事|tell (me )?a story)/.test(s)&&!/(前往|移动|go to)/.test(s))return 'story.here';
  return null;
}

/** Reject malformed or cyclic plan graphs before execution; the executor never interprets arbitrary skill code. */
export function validatePlanGraph(nodes){
  if(!Array.isArray(nodes)||nodes.length<1||nodes.length>6)throw new Error('INVALID_PLAN_GRAPH');
  const ids=new Set();
  for(const n of nodes){
    if(!n||typeof n.id!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(n.id)||ids.has(n.id)||!Array.isArray(n.dependsOn)||n.dependsOn.length>5||new Set(n.dependsOn).size!==n.dependsOn.length)throw new Error('INVALID_PLAN_GRAPH');
    ids.add(n.id);
    if(n.kind==='skill'){
      if(!['learning.english','story.interactive'].includes(n.skillId)||Object.hasOwn(n,'params')||Object.hasOwn(n,'capability'))throw new Error('INVALID_PLAN_ACTION');
    }else if(n.kind==='device'){
      if(n.capability==='sim.navigation.goto'){
        if(!['study_desk','story_corner','sofa','dock'].includes(n.params?.destination)||Object.keys(n.params).length!==1)throw new Error('INVALID_PLAN_ACTION');
      }else if(n.capability==='audio.output'){
        if(n.params!==undefined)throw new Error('INVALID_PLAN_ACTION');
      }else throw new Error('INVALID_PLAN_ACTION');
    }else throw new Error('INVALID_PLAN_ACTION');
  }
  const byId=new Map(nodes.map(n=>[n.id,n]));const seen=new Set(),visiting=new Set();
  const walk=id=>{
    if(visiting.has(id))throw new Error('PLAN_CYCLE');
    if(seen.has(id))return;
    const n=byId.get(id);if(!n)throw new Error('PLAN_MISSING_DEPENDENCY');
    visiting.add(id);for(const dep of n.dependsOn){if(dep===id)throw new Error('PLAN_CYCLE');walk(dep);}visiting.delete(id);seen.add(id);
  };
  for(const n of nodes)walk(n.id);
  return clone(nodes);
}

export class PlanOrchestrator {
  constructor(file,{gateway,registry,skills,clock=()=>Date.now(),maxPlans=80,maxEvents=500,timeoutMs=120_000,onEvent=()=>{},busyDevice=()=>false}={}){
    if(!gateway||!registry||!skills)throw new Error('PLAN_DEPENDENCIES_REQUIRED');
    this.store=new JsonStateStore(file);this.gateway=gateway;this.registry=registry;this.skills=skills;
    this.clock=clock;this.maxPlans=maxPlans;this.maxEvents=maxEvents;this.timeoutMs=timeoutMs;
    this.onEvent=onEvent;this.busyDevice=busyDevice;
    this.plans=[];this.events=[];this.seq=0;this.serial=Promise.resolve();this.outputs=new Map();
  }
  #exclusive(fn){const operation=this.serial.catch(()=>{}).then(fn);this.serial=operation.catch(()=>{});return operation;}
  #emit(plan,type,stepId=null){
    const entry={seq:++this.seq,type,planId:plan.id,stepId,status:plan.status,at:new Date(this.clock()).toISOString()};
    this.events.push(entry);if(this.events.length>this.maxEvents)this.events.shift();return entry;
  }
  async #saveAndBroadcast(entries){
    await this.store.save({schemaVersion:1,seq:this.seq,plans:this.plans,events:this.events});
    for(const e of entries)try{this.onEvent(clone(e));}catch{/* observers cannot interrupt task safety */}
  }
  async load(){
    const state=await this.store.load();if(!state)return;
    if(state.schemaVersion!==1||!Number.isSafeInteger(state.seq)||state.seq<0||!Array.isArray(state.plans)||state.plans.length>this.maxPlans||!Array.isArray(state.events)||state.events.length>this.maxEvents)throw new Error('INVALID_PLAN_STATE');
    const ids=new Set(),requests=new Set();
    for(const p of state.plans){
      if(!p||typeof p.id!=='string'||!/^plan-[0-9a-f-]{36}$/.test(p.id)||ids.has(p.id)||!requestValid(p.requestId)||requests.has(p.requestId)||!Object.hasOwn(PLAN_TEMPLATES,p.templateId)||!deviceValid(p.deviceId)||!['running',...terminal].includes(p.status)||!Number.isFinite(p.createdMs)||!Array.isArray(p.steps)||p.steps.length!==PLAN_TEMPLATES[p.templateId].length)throw new Error('INVALID_PLAN_STATE');
      const defined=PLAN_TEMPLATES[p.templateId];
      if(p.steps.some((s,i)=>s.id!==defined[i].id||!['pending','running','succeeded','failed','cancelled','stopped'].includes(s.status)))throw new Error('INVALID_PLAN_STATE');
      ids.add(p.id);requests.add(p.requestId);
    }
    let prev=0;
    for(const e of state.events){if(!e||!Number.isSafeInteger(e.seq)||e.seq<=prev||e.seq>state.seq||typeof e.type!=='string')throw new Error('INVALID_PLAN_EVENTS');prev=e.seq;}
    this.plans=clone(state.plans);this.events=clone(state.events);this.seq=state.seq;
    const updates=[];
    for(const p of this.plans.filter(p=>p.status==='running')){
      p.status='stopped';p.reason='Interrupted by restart; no device commands replayed';p.updatedAt=new Date(this.clock()).toISOString();
      for(const s of p.steps)if(s.status==='running'||s.status==='pending')s.status='stopped';
      updates.push(this.#emit(p,'plan.stopped'));
    }
    if(updates.length)await this.#saveAndBroadcast(updates);
  }
  list(){return clone(this.plans);}
  get(id){const p=this.plans.find(x=>x.id===id);return p?clone(p):null;}
  getEvents(after=0){if(!Number.isSafeInteger(after)||after<0)throw new Error('INVALID_EVENT_CURSOR');return clone(this.events.filter(e=>e.seq>after));}
  templates(){return Object.keys(PLAN_TEMPLATES);}
  #device(templateId,preferred){
    const required=[...new Set(PLAN_TEMPLATES[templateId].filter(n=>n.kind==='device').map(n=>n.capability))];
    if(preferred!==undefined&&!deviceValid(preferred))throw new Error('INVALID_DEVICE_ID');
    const busy=new Set(this.gateway.list().filter(j=>['queued','running'].includes(j.status)).map(j=>j.deviceId));
    return this.registry.list().filter(d=>!d.revoked&&(!preferred||d.id===preferred)&&this.gateway.online(d.id)&&required.every(c=>d.capabilities.includes(c))&&!busy.has(d.id)&&!this.busyDevice(d.id)&&!this.plans.some(p=>p.deviceId===d.id&&p.status==='running')).sort((a,b)=>a.id.localeCompare(b.id))[0]?.id??null;
  }
  async start(actor,{templateId,deviceId,requestId}={}){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!Object.hasOwn(PLAN_TEMPLATES,templateId))throw new Error('INVALID_PLAN_TEMPLATE');
    if(!requestValid(requestId))throw new Error('INVALID_REQUEST_ID');
    return this.#exclusive(async()=>{
      const prior=this.plans.find(p=>p.requestId===requestId);
      if(prior)return prior.templateId===templateId&&prior.requestedDeviceId===(deviceId??null)?{ok:true,plan:clone(prior),duplicate:true}:{ok:false,message:'IDEMPOTENCY_CONFLICT'};
      if(this.plans.length>=this.maxPlans&&!this.plans.some(p=>terminal.has(p.status)))return {ok:false,message:'PLAN_CAPACITY_REACHED'};
      const chosen=this.#device(templateId,deviceId);
      if(!chosen)return {ok:false,message:'NO_APPROVED_AVAILABLE_DEVICE'};
      const nodes=validatePlanGraph(PLAN_TEMPLATES[templateId]);
      for(const n of nodes.filter(n=>n.kind==='skill')){
        const m=this.skills.list().find(s=>s.id===n.skillId);
        if(!m||!m.enabled||!m.allowedActors.includes(actor))return {ok:false,message:'SKILL_UNAVAILABLE'};
      }
      const now=this.clock(),timestamp=new Date(now).toISOString();
      const p={id:`plan-${randomUUID()}`,templateId,deviceId:chosen,requestedDeviceId:deviceId??null,requestId,actor,status:'running',reason:null,createdMs:now,createdAt:timestamp,updatedAt:timestamp,steps:nodes.map(n=>({id:n.id,kind:n.kind,status:'pending',dependsOn:n.dependsOn,jobId:null}))};
      this.plans.unshift(p);if(this.plans.length>this.maxPlans)this.plans.splice(this.plans.findLastIndex(x=>terminal.has(x.status)),1);
      const e=this.#emit(p,'plan.created');
      await this.#saveAndBroadcast([e]);
      await this.#advance(p);
      return {ok:p.status==='running'||p.status==='succeeded',plan:clone(p),message:p.reason??'Plan started'};
    });
  }
  async command(actor,{text,deviceId,requestId}={}){
    const templateId=compilePlan(text);
    if(!templateId)return {ok:false,message:'UNSUPPORTED_PLAN_INTENT'};
    return this.start(actor,{templateId,deviceId,requestId});
  }
  async #finish(p,status,reason){
    this.outputs.delete(p.id);p.status=status;p.reason=reason;p.updatedAt=new Date(this.clock()).toISOString();
    for(const step of p.steps)if(step.status==='pending'||step.status==='running')step.status=status;
    await this.#saveAndBroadcast([this.#emit(p,`plan.${status}`)]);
  }
  async #advance(p){
    // Only one outstanding external action per plan; dependencies are checked after each device response.
    while(p.status==='running'){
      const nodes=PLAN_TEMPLATES[p.templateId];
      const step=p.steps.find(s=>s.status==='pending'&&s.dependsOn.every(d=>p.steps.find(x=>x.id===d)?.status==='succeeded'));
      if(!step){
        if(p.steps.every(s=>s.status==='succeeded'))await this.#finish(p,'succeeded',null);
        return;
      }
      const spec=nodes.find(n=>n.id===step.id);
      if(spec.kind==='device'){
        const d=this.registry.get(p.deviceId);
        if(!d||d.revoked||!d.capabilities.includes(spec.capability)||!this.gateway.online(p.deviceId)){
          await this.#finish(p,'stopped','Device offline or capability revoked');return;
        }
        step.status='running';p.updatedAt=new Date(this.clock()).toISOString();
        // Persist before the side effect; interrupted requests never replay automatically.
        await this.#saveAndBroadcast([this.#emit(p,'step.started',step.id)]);
        try{
          const params=spec.capability==='audio.output'?{text:(this.outputs.get(p.id)??'Ready.').slice(0,200)}:spec.params;
          const r=await this.gateway.dispatch('parent',{deviceId:p.deviceId,capability:spec.capability,params,requestId:`${p.id}-${step.id}`});
          if(!r.ok){await this.#finish(p,'failed',r.message);return;}
          step.jobId=r.job.id;
          await this.#saveAndBroadcast([this.#emit(p,'step.dispatched',step.id)]);
        }catch(e){await this.#finish(p,'failed',e instanceof Error?e.message:'DISPATCH_FAILED');}
        return;
      }
      // No skill may run after a device drops offline or loses previously required capabilities.
      const device=this.registry.get(p.deviceId);
      const required=nodes.filter(n=>n.kind==='device').map(n=>n.capability);
      if(!device||device.revoked||!this.gateway.online(p.deviceId)||!required.every(cap=>device.capabilities.includes(cap))){
        await this.#finish(p,'stopped','Device offline or capability revoked before skill');return;
      }
      const m=this.skills.list().find(s=>s.id===spec.skillId);
      if(!m||!m.enabled||!m.allowedActors.includes(p.actor)){
        await this.#finish(p,'stopped','Skill permission revoked');return;
      }
      step.status='running';await this.#saveAndBroadcast([this.#emit(p,'step.started',step.id)]);
      const result=this.skills.invoke(spec.skillId,p.actor);
      if(!result.ok){await this.#finish(p,'failed',result.message);return;}
      this.outputs.set(p.id,result.message.slice(0,200));step.status='succeeded';
      await this.#saveAndBroadcast([this.#emit(p,'step.succeeded',step.id)]);
    }
  }
  async tick(){
    return this.#exclusive(async()=>{
      const jobs=new Map(this.gateway.list().map(j=>[j.id,j]));
      for(const p of this.plans.filter(x=>x.status==='running')){
        if(this.clock()-p.createdMs>this.timeoutMs){
          await this.#cancelJobs(p,jobs);await this.#finish(p,'stopped','Plan timeout');continue;
        }
        const active=p.steps.find(x=>x.status==='running');
        if(active?.kind==='device'){
          if(!active.jobId){await this.#finish(p,'stopped','Incomplete dispatch; no replay');continue;}
          const j=jobs.get(active.jobId);
          if(!j||j.deviceId!==p.deviceId){await this.#finish(p,'stopped','Device job missing');continue;}
          if(j.status==='succeeded'){
            active.status='succeeded';await this.#saveAndBroadcast([this.#emit(p,'step.succeeded',active.id)]);
          }else if(terminal.has(j.status)){
            await this.#finish(p,'stopped',`Device job ${j.status}`);continue;
          }else continue;
        }else if(active){await this.#finish(p,'stopped','Interrupted skill step');continue;}
        await this.#advance(p);
      }
    });
  }
  async #cancelJobs(p,jobs){
    for(const s of p.steps){
      const j=s.jobId&&jobs.get(s.jobId);
      if(j&&['queued','running'].includes(j.status))await this.gateway.cancel('parent',s.jobId);
    }
  }
  async cancel(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return this.#exclusive(async()=>{
      const p=this.plans.find(x=>x.id===id);
      if(!p)throw new Error('UNKNOWN_PLAN');
      if(terminal.has(p.status))return {ok:false,message:'PLAN_ALREADY_TERMINAL'};
      await this.#cancelJobs(p,new Map(this.gateway.list().map(j=>[j.id,j])));
      await this.#finish(p,'cancelled','Cancelled by parent');
      return {ok:true,plan:clone(p)};
    });
  }
}
