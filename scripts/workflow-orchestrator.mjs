import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';

// v0.6: deterministic, opt-in simulated workflows. NEVER send physical motor commands.
// Two allowlisted compositions; an LLM or user string never supplies arbitrary tool names.
export const WORKFLOW_RECIPES=Object.freeze({
  'study.english':Object.freeze({destination:'study_desk',skillId:'learning.english',required:['sim.navigation.goto','audio.output']}),
  'story.corner':Object.freeze({destination:'story_corner',skillId:'story.interactive',required:['sim.navigation.goto','audio.output']})
});
const endStates=new Set(['succeeded','failed','stopped','cancelled']);
const activeStates=new Set(['dispatching','navigating','speaking']);
const safeId=s=>typeof s==='string'&&/^dev-[0-9a-f-]{36}$/.test(s);
const requestId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(s);
const copy=record=>structuredClone(record);
export function parseWorkflowCommand(input){
  if(typeof input!=='string'||input.length>500)return null;
  const s=input.trim().toLowerCase();
  if(/(书桌|学习区|study.?desk|desk)/.test(s)&&/(英语|英文|english)/.test(s))return 'study.english';
  if(/(故事角|story.?corner|bookshelf)/.test(s)&&/(故事|story)/.test(s))return 'story.corner';
  return null;
}
export class WorkflowOrchestrator {
  constructor(file,{gateway,registry,skills,clock=()=>Date.now(),maxWorkflows=100,timeoutMs=120_000}={}){
    if(!gateway||!registry||!skills)throw new Error('WORKFLOW_DEPENDENCIES_REQUIRED');
    this.store=new JsonStateStore(file);this.gateway=gateway;this.registry=registry;this.skills=skills;
    this.clock=clock;this.maxWorkflows=maxWorkflows;this.timeoutMs=timeoutMs;
    this.workflows=[];this.serial=Promise.resolve();
  }
  #exclusive(fn){const p=this.serial.catch(()=>{}).then(fn);this.serial=p.catch(()=>{});return p;}
  async load(){
    const state=await this.store.load();if(!state)return;
    if(state.schemaVersion!==1||!Array.isArray(state.workflows)||state.workflows.length>this.maxWorkflows)throw new Error('INVALID_WORKFLOW_STATE');
    const ids=new Set(),requests=new Set();
    this.workflows=state.workflows.map(w=>{
      if(!w||typeof w!=='object'||!/^wf-[0-9a-f-]{36}$/.test(w.id)||ids.has(w.id)||!requestId(w.requestId)||requests.has(w.requestId)||!WORKFLOW_RECIPES[w.recipe]||!safeId(w.deviceId)||!['dispatching','navigating','speaking','succeeded','failed','stopped','cancelled'].includes(w.status)||!Number.isFinite(w.createdMs)||typeof w.createdAt!=='string'||typeof w.updatedAt!=='string'||!Array.isArray(w.steps)||w.steps.length>8)throw new Error('INVALID_WORKFLOW_STATE');
      ids.add(w.id);requests.add(w.requestId);
      return {...w,status:endStates.has(w.status)?w.status:'stopped',reason:endStates.has(w.status)?w.reason:'Interrupted by server restart; workflow not replayed',updatedAt:endStates.has(w.status)?w.updatedAt:new Date(this.clock()).toISOString()};
    });
    if(this.workflows.some((w,i)=>w.status!==state.workflows[i].status))await this.save();
  }
  save(){return this.store.save({schemaVersion:1,workflows:this.workflows});}
  list(){return this.workflows.map(copy);}
  get(id){const w=this.workflows.find(x=>x.id===id);return w?copy(w):null;}
  selectDevice(recipe,selected){
    const required=WORKFLOW_RECIPES[recipe]?.required;
    if(!required)throw new Error('INVALID_WORKFLOW_RECIPE');
    if(selected!==undefined&&!safeId(selected))throw new Error('INVALID_DEVICE_ID');
    const available=this.registry.list().filter(d=>!d.revoked&&(!selected||d.id===selected)&&this.gateway.online(d.id)&&required.every(c=>(d.capabilities??[]).includes(c))&&!this.workflows.some(w=>w.deviceId===d.id&&activeStates.has(w.status)));
    available.sort((a,b)=>a.id.localeCompare(b.id));
    return available[0]?.id??null;
  }
  async start(actor,{recipe,deviceId,requestId:externalRequestId}={}){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!Object.hasOwn(WORKFLOW_RECIPES,recipe))throw new Error('INVALID_WORKFLOW_RECIPE');
    if(!requestId(externalRequestId))throw new Error('INVALID_REQUEST_ID');
    return this.#exclusive(async()=>{
      const previous=this.workflows.find(w=>w.requestId===externalRequestId);
      if(previous)return previous.recipe===recipe&&previous.requestedDeviceId===(deviceId??null)?{ok:true,workflow:copy(previous),duplicate:true}:{ok:false,message:'IDEMPOTENCY_CONFLICT'};
      const chosen=this.selectDevice(recipe,deviceId);
      if(!chosen)return {ok:false,message:'NO_APPROVED_AVAILABLE_DEVICE'};
      // Verify the skill before sending a movement task; availability/permission are checked again on arrival.
      const manifest=this.skills.list().find(s=>s.id===WORKFLOW_RECIPES[recipe].skillId);
      if(!manifest||!manifest.enabled||!manifest.allowedActors.includes(actor))return {ok:false,message:'SKILL_UNAVAILABLE'};
      const now=this.clock(),iso=new Date(now).toISOString();
      const w={id:`wf-${randomUUID()}`,requestId:externalRequestId,recipe,deviceId:chosen,requestedDeviceId:deviceId??null,actor,status:'dispatching',createdMs:now,createdAt:iso,updatedAt:iso,reason:null,steps:[],navigationJobId:null,audioJobId:null};
      this.workflows.unshift(w);if(this.workflows.length>this.maxWorkflows)this.workflows.length=this.maxWorkflows;
      // Persist intent before dispatch, so process crash cannot silently repeat instructions.
      try{await this.save();}catch(e){this.workflows=this.workflows.filter(x=>x!==w);throw e;}
      try{
        const result=await this.gateway.dispatch(actor,{deviceId:chosen,capability:'sim.navigation.goto',params:{destination:WORKFLOW_RECIPES[recipe].destination},requestId:`${w.id}-nav`});
        if(!result.ok){w.status='failed';w.reason=result.message;}
        else {w.navigationJobId=result.job.id;w.status='navigating';w.steps.push({name:'navigation',status:'running',jobId:result.job.id});}
      }catch(e){w.status='failed';w.reason=e instanceof Error?e.message:'DISPATCH_FAILED';}
      w.updatedAt=new Date(this.clock()).toISOString();await this.save();
      return {ok:w.status==='navigating',message:w.status==='navigating'?'Virtual navigation started; trusted skill will run after simulated arrival':w.reason,workflow:copy(w)};
    });
  }
  async startCommand(actor,{text,deviceId,requestId:rid}={}){
    const recipe=parseWorkflowCommand(text);
    if(!recipe)return {ok:false,message:'UNSUPPORTED_WORKFLOW_COMMAND'};
    return this.start(actor,{recipe,deviceId,requestId:rid});
  }
  async cancel(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return this.#exclusive(async()=>{
      const w=this.workflows.find(x=>x.id===id);if(!w)throw new Error('UNKNOWN_WORKFLOW');
      if(endStates.has(w.status))return {ok:false,message:'WORKFLOW_ALREADY_TERMINAL'};
      // Cancel device work BEFORE marking the workflow terminal. The device cannot restart a cancelled job.
      for(const jobId of [w.navigationJobId,w.audioJobId]){
        if(!jobId)continue;
        const job=this.gateway.list().find(j=>j.id===jobId);
        if(job&&['queued','running'].includes(job.status))await this.gateway.cancel(actor,jobId);
      }
      w.status='cancelled';w.reason='Cancelled by parent';w.updatedAt=new Date(this.clock()).toISOString();
      for(const step of w.steps)if(step.status==='running')step.status='cancelled';
      await this.save();return {ok:true,workflow:copy(w)};
    });
  }
  async tick(){
    return this.#exclusive(async()=>{
      const jobs=new Map(this.gateway.list().map(j=>[j.id,j]));let changed=0;
      for(const w of this.workflows.filter(x=>activeStates.has(x.status))){
        const end=(status,reason)=>{w.status=status;w.reason=reason;for(const step of w.steps)if(step.status==='running')step.status=status;};
        if(this.clock()-w.createdMs>this.timeoutMs){
          for(const id of [w.navigationJobId,w.audioJobId]){
            const j=id&&jobs.get(id);if(j&&['queued','running'].includes(j.status))await this.gateway.cancel('parent',id);
          }
          end('stopped','Workflow timeout');changed++;
        } else if(w.status==='dispatching'){
          end('stopped','Incomplete dispatch state');changed++;
        } else if(w.status==='navigating'){
          const j=jobs.get(w.navigationJobId);
          if(!j||j.deviceId!==w.deviceId){end('stopped','Navigation job missing');changed++;}
          else if(j.status==='succeeded'){
            w.steps.find(s=>s.name==='navigation').status='succeeded';
            const recipe=WORKFLOW_RECIPES[w.recipe],device=this.registry.get(w.deviceId);
            if(!this.gateway.online(w.deviceId)||!recipe.required.every(c=>device?.capabilities.includes(c))){end('stopped','Device offline or capability revoked before skill');changed++;}
            else {
              const result=this.skills.invoke(recipe.skillId,w.actor);
              w.steps.push({name:'skill',status:result.ok?'succeeded':'failed',skillId:recipe.skillId});
              if(!result.ok){end('failed',result.message);changed++;}
              else {
                // Device renders a bounded audio.output demonstration; no microphone/real teaching session yet.
                const text=result.message.slice(0,200);
                try {
                  const output=await this.gateway.dispatch(w.actor,{deviceId:w.deviceId,capability:'audio.output',params:{text},requestId:`${w.id}-audio`});
                  if(!output.ok){end('failed',output.message);}
                  else{w.audioJobId=output.job.id;w.status='speaking';w.steps.push({name:'audio',status:'running',jobId:output.job.id});}
                }catch(e){end('failed',e instanceof Error?e.message:'AUDIO_DISPATCH_FAILED');}
                changed++;
              }
            }
          }else if(endStates.has(j.status)){end('stopped',`Navigation ${j.status}: ${j.reason??'no details'}`);changed++;}
        } else if(w.status==='speaking'){
          const device=this.registry.get(w.deviceId);
          if(!device||device.revoked||!device.capabilities.includes('audio.output')||!this.gateway.online(w.deviceId)){
            end('stopped','Device offline or audio capability revoked');w.updatedAt=new Date(this.clock()).toISOString();changed++;continue;
          }
          const j=jobs.get(w.audioJobId);
          if(!j||j.deviceId!==w.deviceId){end('stopped','Audio job missing');changed++;}
          else if(j.status==='succeeded'){w.steps.find(s=>s.name==='audio').status='succeeded';w.status='succeeded';w.reason='Virtual navigation and skill audio completed';changed++;}
          else if(endStates.has(j.status)){end('stopped',`Audio ${j.status}: ${j.reason??'no details'}`);changed++;}
        }
        if(changed)w.updatedAt=new Date(this.clock()).toISOString();
      }
      if(changed)await this.save();return changed;
    });
  }
}
