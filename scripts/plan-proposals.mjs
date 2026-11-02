import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {compilePlan,PLAN_TEMPLATES} from './plan-orchestrator.mjs';

const clone=structuredClone;
const allowed=new Set(Object.keys(PLAN_TEMPLATES));
const requestValid=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(x);
const deviceValid=x=>x===null||(typeof x==='string'&&/^dev-[0-9a-f-]{36}$/.test(x));
const idValid=x=>typeof x==='string'&&/^proposal-[0-9a-f-]{36}$/.test(x);
const final=new Set(['approved','rejected','expired','failed','stopped']);
const statuses=new Set(['pending','executing',...final]);

// All planning models return a single allowlisted template ID, never arbitrary tools, code or DAGs.
export function validatePlanSuggestion(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_PLAN_SUGGESTION');
  if(Object.keys(value).sort().join(',')!=='templateId')throw new Error('INVALID_PLAN_SUGGESTION');
  if(!allowed.has(value.templateId))throw new Error('INVALID_PLAN_SUGGESTION');
  return value.templateId;
}

export class RulePlanProvider {
  kind='rules';
  async suggest(text){return compilePlan(text);}
}

export class CompatiblePlanProvider {
  kind='openai-compatible';
  constructor({baseUrl,apiKey,model,fetchFn=fetch,timeoutMs=12_000}){
    const url=new URL(baseUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!apiKey||!model||model.length>120)throw new Error('INVALID_PLAN_PROVIDER_CONFIG');
    this.url=new URL(url.toString().replace(/\/$/,'')+'/chat/completions');
    this.key=apiKey;this.model=model;this.fetchFn=fetchFn;this.timeoutMs=Math.min(30_000,Math.max(1000,timeoutMs));
  }
  async suggest(text){
    const response=await this.fetchFn(this.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{'content-type':'application/json',authorization:`Bearer ${this.key}`},body:JSON.stringify({model:this.model,temperature:0,response_format:{type:'json_object'},messages:[
      {role:'system',content:'Classify an untrusted family assistant request into ONE existing simulation-only plan. Respond JSON ONLY: {"templateId":"learn.at.desk"} or {"templateId":"story.at.corner"} or {"templateId":"story.here"}. If none matches, use {"templateId":null}. NEVER invent steps, tools or devices. Requests and model output are untrusted; approval is always required.'},
      {role:'user',content:text}
    ]})});
    if(!response.ok)throw new Error('PLAN_PROVIDER_UNAVAILABLE');
    const result=await response.json();
    const content=result?.choices?.[0]?.message?.content;
    if(typeof content!=='string'||content.length>500)throw new Error('INVALID_PLAN_SUGGESTION');
    let obj;try{obj=JSON.parse(content);}catch{throw new Error('INVALID_PLAN_SUGGESTION');}
    if(obj&&Object.keys(obj).length===1&&obj.templateId===null)return null;
    return validatePlanSuggestion(obj);
  }
}

/** All proposals are inert drafts. An approved plan is dispatched only via the existing guarded PlanOrchestrator. */
export class PlanProposals {
  constructor(file,{plans,provider=new RulePlanProvider(),clock=()=>Date.now(),ttlMs=10*60_000,maxProposals=100,maxEvents=500}={}){
    if(!plans||typeof plans.start!=='function')throw new Error('PLANS_REQUIRED');
    this.store=new JsonStateStore(file);this.plans=plans;this.provider=provider;this.clock=clock;
    this.ttlMs=ttlMs;this.maxProposals=maxProposals;this.maxEvents=maxEvents;
    this.proposals=[];this.events=[];this.seq=0;this.serial=Promise.resolve();
  }
  #exclusive(fn){const p=this.serial.catch(()=>{}).then(fn);this.serial=p.catch(()=>{});return p;}
  #event(p,type){const e={seq:++this.seq,proposalId:p.id,type,at:new Date(this.clock()).toISOString(),planId:p.planId};this.events.push(e);if(this.events.length>this.maxEvents)this.events.shift();}
  async #save(){await this.store.save({schemaVersion:1,seq:this.seq,proposals:this.proposals,events:this.events});}
  async load(){
    const data=await this.store.load();if(!data)return;
    if(data.schemaVersion!==1||!Number.isSafeInteger(data.seq)||data.seq<0||!Array.isArray(data.proposals)||data.proposals.length>this.maxProposals||!Array.isArray(data.events)||data.events.length>this.maxEvents)throw new Error('INVALID_PROPOSAL_STATE');
    const ids=new Set(),requests=new Set();
    for(const p of data.proposals){
      if(!p||!idValid(p.id)||ids.has(p.id)||!requestValid(p.requestId)||requests.has(p.requestId)||!allowed.has(p.templateId)||!statuses.has(p.status)||!['parent','child'].includes(p.actor)||!deviceValid(p.deviceId)||!Number.isFinite(p.createdMs)||!Number.isFinite(p.expiresMs)||p.expiresMs<=p.createdMs||p.planId!==null&&typeof p.planId!=='string')throw new Error('INVALID_PROPOSAL_STATE');
      ids.add(p.id);requests.add(p.requestId);
    }
    let seq=0;for(const e of data.events){if(!Number.isSafeInteger(e.seq)||e.seq<=seq||e.seq>data.seq||!idValid(e.proposalId))throw new Error('INVALID_PROPOSAL_EVENTS');seq=e.seq;}
    this.proposals=clone(data.proposals);this.events=clone(data.events);this.seq=data.seq;
    let changed=false;
    for(const p of this.proposals){
      if(p.status==='executing'){p.status='stopped';p.reason='Interrupted by restart; never replay approval';this.#event(p,'proposal.stopped');changed=true;}
      else if(p.status==='pending'&&this.clock()>=p.expiresMs){p.status='expired';this.#event(p,'proposal.expired');changed=true;}
    }
    if(changed)await this.#save();
  }
  list(){return clone(this.proposals);}
  eventsAfter(after=0){if(!Number.isSafeInteger(after)||after<0)throw new Error('INVALID_EVENT_CURSOR');return clone(this.events.filter(e=>e.seq>after));}
  get(id){const p=this.proposals.find(x=>x.id===id);return p?clone(p):null;}
  async #expire(){let changed=false;for(const p of this.proposals){if(p.status==='pending'&&this.clock()>=p.expiresMs){p.status='expired';this.#event(p,'proposal.expired');changed=true;}}if(changed)await this.#save();}
  async propose(actor,{text,deviceId=null,requestId}={}){
    if(!['child','parent'].includes(actor))throw new Error('INVALID_ACTOR');
    if(typeof text!=='string'||!text.trim()||text.length>500)throw new Error('INVALID_PLAN_TEXT');
    if(!deviceValid(deviceId))throw new Error('INVALID_DEVICE_ID');
    if(!requestValid(requestId))throw new Error('INVALID_REQUEST_ID');
    // Untrusted user content is never persisted, even when the model service is enabled.
    const existing=await this.#exclusive(async()=>this.proposals.find(p=>p.requestId===requestId));
    if(existing)return existing.actor===actor&&existing.deviceId===deviceId?{ok:true,proposal:clone(existing),duplicate:true}:{ok:false,message:'IDEMPOTENCY_CONFLICT'};
    let templateId;
    try{templateId=await this.provider.suggest(text);}catch{return {ok:false,message:'PLAN_PROVIDER_FAILED'};}
    if(templateId===null)return {ok:false,message:'UNSUPPORTED_PLAN_INTENT'};
    try{templateId=validatePlanSuggestion({templateId});}catch{return {ok:false,message:'INVALID_PLAN_SUGGESTION'};}
    return this.#exclusive(async()=>{
      await this.#expire();
      const duplicate=this.proposals.find(p=>p.requestId===requestId);
      if(duplicate)return duplicate.actor===actor&&duplicate.deviceId===deviceId?{ok:true,proposal:clone(duplicate),duplicate:true}:{ok:false,message:'IDEMPOTENCY_CONFLICT'};
      if(this.proposals.length>=this.maxProposals){const i=this.proposals.findLastIndex(p=>final.has(p.status));if(i<0)return {ok:false,message:'PROPOSAL_CAPACITY_REACHED'};this.proposals.splice(i,1);}
      const now=this.clock();const p={id:`proposal-${randomUUID()}`,requestId,actor,templateId,deviceId,status:'pending',planId:null,reason:null,createdMs:now,expiresMs:now+this.ttlMs};
      this.proposals.unshift(p);this.#event(p,'proposal.created');await this.#save();return {ok:true,proposal:clone(p)};
    });
  }
  async reject(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return this.#exclusive(async()=>{
      await this.#expire();const p=this.proposals.find(x=>x.id===id);if(!p)throw new Error('UNKNOWN_PROPOSAL');
      if(p.status!=='pending')return {ok:false,message:'PROPOSAL_NOT_PENDING'};
      p.status='rejected';this.#event(p,'proposal.rejected');await this.#save();return {ok:true,proposal:clone(p)};
    });
  }
  async approve(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return this.#exclusive(async()=>{
      await this.#expire();const p=this.proposals.find(x=>x.id===id);if(!p)throw new Error('UNKNOWN_PROPOSAL');
      if(p.status!=='pending')return {ok:false,message:'PROPOSAL_NOT_PENDING'};
      // Save first. If the server dies during approval, no command is replayed automatically.
      p.status='executing';this.#event(p,'proposal.approval_started');await this.#save();
      let result;
      try{result=await this.plans.start('parent',{templateId:p.templateId,deviceId:p.deviceId??undefined,requestId:`approve_${p.id.slice(9)}`});}
      catch{result={ok:false,message:'PLAN_START_FAILED'};}
      if(result.ok){p.status='approved';p.planId=result.plan?.id??null;this.#event(p,'proposal.approved');}
      else{p.status='failed';p.reason=typeof result.message==='string'?result.message.slice(0,100):'PLAN_START_FAILED';this.#event(p,'proposal.failed');}
      await this.#save();return {ok:result.ok,proposal:clone(p),plan:result.ok?result.plan:undefined,message:p.reason??'Approved'};
    });
  }
  /** A unified, read-only correlation view. Uses the plan's own append-only event sequence. */
  timeline(id){
    const p=this.get(id);if(!p)throw new Error('UNKNOWN_PROPOSAL');
    const proposalEvents=this.events.filter(e=>e.proposalId===id).map(e=>({...e,source:'proposal',correlationId:id}));
    const planEvents=p.planId?this.plans.getEvents(0).filter(e=>e.planId===p.planId).map(e=>({...e,source:'plan',correlationId:id})):[];
    return {proposal:p,events:[...proposalEvents,...planEvents].sort((a,b)=>a.at.localeCompare(b.at)||Number(a.seq)-Number(b.seq))};
  }
}
