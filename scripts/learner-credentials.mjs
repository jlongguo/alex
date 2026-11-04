import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';

// Local-only verified learner credential material. Access codes are public
// login identifiers, never authorizations. PIN hashes remain on disk (0600),
// never in profile exports or conversation transcripts.
const PROFILE_ID=/^profile-[0-9a-f-]{36}$/;
const CODE=/^[0-9a-f]{12}$/;
const HEX32=/^[0-9a-f]{64}$/;
const SALT=/^[0-9a-f]{32}$/;
const PIN=/^\d{6,12}$/;
const MAX=12;
const DUMMY_SALT=Buffer.alloc(16);
const DUMMY_HASH=scryptSync('dummy-unsupported-pin',DUMMY_SALT,32);

export class LearnerCredentials {
  constructor(file){this.store=new JsonStateStore(file);this.records=[];this.serial=Promise.resolve();}
  #exclusive(fn){const task=this.serial.catch(()=>{}).then(fn);this.serial=task.catch(()=>{});return task;}
  async load(){
    const data=await this.store.load();
    if(!data)return;
    if(data.version!==1||!Array.isArray(data.records)||data.records.length>MAX)
      throw new Error('INVALID_LEARNER_CREDENTIAL_FILE');
    const seenProfiles=new Set(),seenCodes=new Set();
    const safe=[];
    for(const item of data.records){
      if(!item||!PROFILE_ID.test(item.profileId)||!CODE.test(item.code)
        ||!SALT.test(item.salt)||!HEX32.test(item.digest)
        ||typeof item.updatedAt!=='string'
        ||seenProfiles.has(item.profileId)||seenCodes.has(item.code))
        throw new Error('INVALID_LEARNER_CREDENTIAL_FILE');
      seenProfiles.add(item.profileId);seenCodes.add(item.code);
      safe.push({...item});
    }
    this.records=safe;
  }
  listForParent(actor){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return this.records.map(x=>({profileId:x.profileId,code:x.code,updatedAt:x.updatedAt}));
  }
  async setPin(actor,profileId,pin,exists){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PROFILE_ID.test(profileId??'')||!exists(profileId))
      throw new Error('UNKNOWN_LEARNER_PROFILE');
    if(typeof pin!=='string'||!PIN.test(pin))throw new Error('INVALID_LEARNER_PIN');
    return this.#exclusive(async()=>{
      const previous=this.records.find(x=>x.profileId===profileId);
      if(!previous&&this.records.length>=MAX)throw new Error('LEARNER_CREDENTIAL_LIMIT');
      const salt=randomBytes(16).toString('hex');
      const digest=scryptSync(pin,Buffer.from(salt,'hex'),32).toString('hex');
      let code=previous?.code;
      if(!code)do{code=randomBytes(6).toString('hex');}
        while(this.records.some(x=>x.code===code));
      const updatedAt=new Date().toISOString();
      const next=this.records.filter(x=>x.profileId!==profileId);
      next.push({profileId,code,salt,digest,updatedAt});
      await this.store.save({version:1,records:next});
      this.records=next;
      return {profileId,code,updatedAt};
    });
  }
  verify(code,pin){
    const value=typeof code==='string'&&CODE.test(code)?code:'';
    const entry=this.records.find(x=>x.code===value);
    // Always run scrypt+constant-time digest comparison even for unknown
    // codes, so a bad code does not bypass the expensive check.
    const candidate=typeof pin==='string'&&pin.length<=128?pin:'';
    const salt=entry?Buffer.from(entry.salt,'hex'):DUMMY_SALT;
    const expected=entry?Buffer.from(entry.digest,'hex'):DUMMY_HASH;
    const actual=scryptSync(candidate,salt,32);
    const match=timingSafeEqual(actual,expected);
    return entry&&PIN.test(candidate)&&match?entry.profileId:null;
  }
  async revoke(actor,profileId){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!PROFILE_ID.test(profileId??''))throw new Error('INVALID_LEARNER_PROFILE');
    return this.#exclusive(async()=>{
      const next=this.records.filter(x=>x.profileId!==profileId);
      if(next.length===this.records.length)return false;
      await this.store.save({version:1,records:next});
      this.records=next;return true;
    });
  }
}
