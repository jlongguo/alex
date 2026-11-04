import {JsonStateStore} from './state-store.mjs';

const PROFILE=/^profile-[0-9a-f-]{36}$/;
const MAX_PROFILES=12;
const TOPICS=new Set(['animals','nature','science','stories','music','art','sports','robots']);
const LANGS=new Set(['zh','en','bilingual']);
const PACES=new Set(['slow','normal']);
const clone=x=>structuredClone(x);
export const DEFAULT_LEARNER_PRIVACY=Object.freeze({
  voiceInputAllowed:false,voiceOutputAllowed:false,cloudTextAllowed:false,
  preferredLanguage:'bilingual',learningPace:'slow',topics:[]
});
function validPreferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(k=>!Object.keys(DEFAULT_LEARNER_PRIVACY).includes(k)))
    throw new Error('INVALID_LEARNER_PRIVACY');
  for(const flag of ['voiceInputAllowed','voiceOutputAllowed','cloudTextAllowed'])
    if(typeof value[flag]!=='boolean')throw new Error('INVALID_LEARNER_PRIVACY');
  if(!LANGS.has(value.preferredLanguage)||!PACES.has(value.learningPace)
    ||!Array.isArray(value.topics)||value.topics.length>5
    ||value.topics.some(x=>!TOPICS.has(x))
    ||new Set(value.topics).size!==value.topics.length)
    throw new Error('INVALID_LEARNER_PRIVACY');
  return clone(value);
}
// Only parent-controlled, strongly typed non-sensitive preferences.
// Browser ASR is third-party-capable; this flag is a prerequisite, not proof
// of any actual consent/quality/processing location at the browser vendor.
export class LearnerPrivacy {
  #rows=[];
  #queue=Promise.resolve();
  constructor(file){this.store=new JsonStateStore(file);}
  #exclusive(fn){const op=this.#queue.catch(()=>{}).then(fn);this.#queue=op.catch(()=>{});return op;}
  async load(){
    const saved=await this.store.load();
    if(!saved)return;
    if(saved.version!==1||!Array.isArray(saved.rows)||saved.rows.length>MAX_PROFILES)
      throw new Error('INVALID_LEARNER_PRIVACY_FILE');
    const seen=new Set();
    for(const row of saved.rows){
      if(!row||!PROFILE.test(row.profileId)||seen.has(row.profileId)
        ||typeof row.updatedAt!=='string'||Number.isNaN(Date.parse(row.updatedAt)))
        throw new Error('INVALID_LEARNER_PRIVACY_FILE');
      seen.add(row.profileId);
      validPreferences(row.preferences);
    }
    this.#rows=clone(saved.rows);
  }
  forProfile(profileId){
    if(!PROFILE.test(profileId??''))throw new Error('INVALID_LEARNER_PROFILE');
    return clone(this.#rows.find(x=>x.profileId===profileId)?.preferences??DEFAULT_LEARNER_PRIVACY);
  }
  forPrincipal(principal){
    if(principal==='parent')return {
      ...clone(DEFAULT_LEARNER_PRIVACY),
      voiceInputAllowed:true,voiceOutputAllowed:true,cloudTextAllowed:true,
      parentControlled:false
    };
    if(principal==='child')return {...clone(DEFAULT_LEARNER_PRIVACY),parentControlled:true,legacyShared:true};
    if(typeof principal!=='string'||!principal.startsWith('learner:')||!PROFILE.test(principal.slice(8)))
      throw new Error('INVALID_LEARNER_PRINCIPAL');
    return {...this.forProfile(principal.slice(8)),parentControlled:true,legacyShared:false};
  }
  list(actor){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return clone(this.#rows);
  }
  modelContext(principal){
    if(principal==='parent')return null;
    const p=this.forPrincipal(principal);
    if(!p.cloudTextAllowed)throw new Error('CHILD_CLOUD_TEXT_DISABLED');
    return {preferredLanguage:p.preferredLanguage,learningPace:p.learningPace,topics:[...p.topics]};
  }
  async set(actor,profileId,patch,exists){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PROFILE.test(profileId??'')||!exists(profileId))throw new Error('UNKNOWN_LEARNER_PROFILE');
    if(!patch||typeof patch!=='object'||Array.isArray(patch)
      ||Object.keys(patch).length===0
      ||Object.keys(patch).some(k=>!Object.keys(DEFAULT_LEARNER_PRIVACY).includes(k)))
      throw new Error('INVALID_LEARNER_PRIVACY');
    return this.#exclusive(async()=>{
      const base=this.forProfile(profileId);
      const preferences=validPreferences({...base,...patch});
      const updatedAt=new Date().toISOString();
      const record={profileId,preferences,updatedAt};
      const next=this.#rows.filter(x=>x.profileId!==profileId);
      if(next.length>=MAX_PROFILES)throw new Error('LEARNER_PRIVACY_LIMIT');
      next.push(record);
      await this.store.save({version:1,rows:next});
      this.#rows=next;
      return clone(record);
    });
  }
  async revoke(actor,profileId){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PROFILE.test(profileId??''))throw new Error('INVALID_LEARNER_PROFILE');
    return this.#exclusive(async()=>{
      const next=this.#rows.filter(x=>x.profileId!==profileId);
      const removed=this.#rows.length-next.length;
      if(removed){
        await this.store.save({version:1,rows:next});
        this.#rows=next;
      }
      return removed;
    });
  }
  async clearForPrivacy(actor,scope){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!['parent','child','all','family'].includes(scope))throw new Error('INVALID_ERASURE_SCOPE');
    if(!['child','all'].includes(scope))return 0;
    return this.#exclusive(async()=>{
      const n=this.#rows.length;
      if(n){await this.store.save({version:1,rows:[]});this.#rows=[];}
      return n;
    });
  }
}
