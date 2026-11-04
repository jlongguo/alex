import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {courseById} from './skill-curriculum.mjs';

const PROFILE=/^profile-[0-9a-f-]{36}$/;
const PLAN=/^plan-[0-9a-f-]{36}$/;
const MAX=48;
const clone=x=>structuredClone(x);
const check=(item)=>{
  if(!item||!PLAN.test(item.id)||!PROFILE.test(item.profileId)
    ||!courseById(item.courseId)||!['active','paused'].includes(item.status)
    ||!Number.isInteger(item.targetCompletions)||item.targetCompletions<1||item.targetCompletions>20
    ||typeof item.createdAt!=='string'||typeof item.updatedAt!=='string')
    throw new Error('INVALID_LEARNING_PLAN');
};

// One parent-owned, explicitly assigned course per (learner,courseId).
// Records are metadata only; never store the child's answers or transcripts.
export class LearningPlans {
  #rows=[];
  #queue=Promise.resolve();
  constructor(file){this.store=new JsonStateStore(file);}
  #exclusive(fn){
    const task=this.#queue.catch(()=>{}).then(fn);
    this.#queue=task.catch(()=>{});
    return task;
  }
  async load(){
    const data=await this.store.load();
    if(!data)return;
    if(data.version!==1||!Array.isArray(data.plans)||data.plans.length>MAX)
      throw new Error('INVALID_LEARNING_PLANS_FILE');
    const ids=new Set(),uniques=new Set();
    for(const item of data.plans){
      check(item);
      const key=item.profileId+':'+item.courseId;
      if(ids.has(item.id)||uniques.has(key))throw new Error('INVALID_LEARNING_PLANS_FILE');
      ids.add(item.id);uniques.add(key);
    }
    this.#rows=clone(data.plans);
  }
  #commit(rows){
    return this.store.save({version:1,plans:rows}).then(()=>{this.#rows=rows;});
  }
  list(principal,profileId){
    if(principal!=='parent'&&!/^learner:profile-[0-9a-f-]{36}$/.test(principal??''))
      throw new Error('LEARNING_PLANS_AUTH_REQUIRED');
    if(profileId!==undefined&&(!PROFILE.test(profileId)||(principal!=='parent'&&principal!=='learner:'+profileId)))
      throw new Error('LEARNING_PLANS_FORBIDDEN');
    const rows=this.#rows.filter(p=>principal==='parent'
      ?(profileId===undefined||p.profileId===profileId)
      :p.profileId===principal.slice('learner:'.length));
    return clone(rows);
  }
  async assign(actor,{profileId,courseId,targetCompletions=1},exists){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PROFILE.test(profileId??'')||!exists(profileId))throw new Error('UNKNOWN_LEARNER_PROFILE');
    if(!courseById(courseId))throw new Error('UNKNOWN_COURSE');
    if(!Number.isInteger(targetCompletions)||targetCompletions<1||targetCompletions>20)
      throw new Error('INVALID_LEARNING_TARGET');
    return this.#exclusive(async()=>{
      const old=this.#rows.find(p=>p.profileId===profileId&&p.courseId===courseId);
      if(!old&&this.#rows.length>=MAX)throw new Error('LEARNING_PLANS_LIMIT');
      const now=new Date().toISOString();
      const item=old?{...old,status:'active',targetCompletions,updatedAt:now}
        :{id:'plan-'+randomUUID(),profileId,courseId,status:'active',
           targetCompletions,createdAt:now,updatedAt:now};
      const next=this.#rows.filter(p=>p.id!==item.id);
      next.push(item);
      await this.#commit(next);
      return clone(item);
    });
  }
  async changeStatus(actor,id,status){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PLAN.test(id??'')||!['active','paused'].includes(status))
      throw new Error('INVALID_LEARNING_PLAN_CHANGE');
    return this.#exclusive(async()=>{
      const item=this.#rows.find(p=>p.id===id);
      if(!item)throw new Error('UNKNOWN_LEARNING_PLAN');
      const updated={...item,status,updatedAt:new Date().toISOString()};
      const next=this.#rows.map(p=>p.id===id?updated:p);
      await this.#commit(next);
      return clone(updated);
    });
  }
  async remove(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PLAN.test(id??''))throw new Error('INVALID_LEARNING_PLAN');
    return this.#exclusive(async()=>{
      const next=this.#rows.filter(x=>x.id!==id);
      if(next.length===this.#rows.length)return false;
      await this.#commit(next);
      return true;
    });
  }
  async removeProfile(actor,profileId){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PROFILE.test(profileId??''))throw new Error('INVALID_LEARNER_PROFILE');
    return this.#exclusive(async()=>{
      const next=this.#rows.filter(p=>p.profileId!==profileId);
      if(next.length!==this.#rows.length)await this.#commit(next);
      return this.#rows.length-next.length;
    });
  }
  exportForParent(actor){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return clone(this.#rows);
  }
}
