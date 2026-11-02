import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';

const bands=new Set(['3-5','6-8','9-12','13-17','adult']);
const MAX_PROFILES=12;
function validate(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_PROFILE');
  if(typeof value.nickname!=='string'||!value.nickname.trim()||value.nickname.trim().length>32)throw new Error('INVALID_PROFILE_NAME');
  if(!bands.has(value.ageBand))throw new Error('INVALID_AGE_BAND');
  if(!Array.isArray(value.interests)||value.interests.length>10||value.interests.some(x=>typeof x!=='string'||!x.trim()||x.length>32))throw new Error('INVALID_INTERESTS');
  return {nickname:value.nickname.trim(),ageBand:value.ageBand,interests:value.interests.map(x=>x.trim())};
}
/** Minimal age-band-only learner profiles. No exact birth dates or biometrics. */
export class FamilyProfiles {
  constructor(file){this.store=new JsonStateStore(file);this.profiles=[];}
  async load(){
    const state=await this.store.load();if(!state)return;
    if(state.version!==1||!Array.isArray(state.profiles)||state.profiles.length>MAX_PROFILES)throw new Error('INVALID_PROFILE_FILE');
    for(const p of state.profiles){validate(p);if(typeof p.id!=='string'||typeof p.createdAt!=='string')throw new Error('INVALID_PROFILE_FILE');}
    this.profiles=state.profiles;
  }
  list(){return this.profiles.map(p=>({...p,interests:[...p.interests]}));}
  async add(actor,data){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    const safe=validate(data);
    if(this.profiles.length>=MAX_PROFILES)throw new Error('PROFILE_LIMIT_REACHED');
    const profile={id:`profile-${randomUUID()}`,...safe,createdAt:new Date().toISOString()};
    this.profiles.push(profile);
    try{await this.store.save({version:1,profiles:this.profiles});}catch(e){this.profiles=this.profiles.filter(p=>p.id!==profile.id);throw e;}
    return {...profile};
  }
  async remove(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    const i=this.profiles.findIndex(x=>x.id===id);if(i<0)return false;
    const old=this.profiles.splice(i,1)[0];
    try{await this.store.save({version:1,profiles:this.profiles});}catch(e){this.profiles.splice(i,0,old);throw e;}
    return true;
  }
}
