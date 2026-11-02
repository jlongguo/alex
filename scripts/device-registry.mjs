import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const NAME_LIMIT=60, MAX_DEVICES=32;

/** Local-only explicit pairing. Pairing code is one-time and never saved to disk. */
export class DeviceRegistry {
  constructor(file,{clock=()=>Date.now()}={}){
    this.store=new JsonStateStore(file);this.clock=clock;
    this.devices=[];this.pairings=new Map();this.pending=Promise.resolve();
  }
  async load(){
    const snapshot=await this.store.load();if(!snapshot)return;
    if(snapshot.version!==1 || !Array.isArray(snapshot.devices) || snapshot.devices.length>MAX_DEVICES)throw new Error('INVALID_DEVICE_FILE');
    for(const d of snapshot.devices){
      if(!d||typeof d.id!=='string'||typeof d.name!=='string'||typeof d.tokenHash!=='string'||!(/^[a-f0-9]{64}$/.test(d.tokenHash))||typeof d.createdAt!=='string'||typeof d.revoked!=='boolean')throw new Error('INVALID_DEVICE_FILE');
    }
    this.devices=snapshot.devices;
  }
  persist(){return this.store.save({version:1,devices:this.devices});}
  list(){return this.devices.map(({tokenHash,...publicFields})=>({...publicFields}));}
  start(actor){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    const now=this.clock();for(const [key,v] of this.pairings)if(v.expiresAt<=now)this.pairings.delete(key);
    this.pairings.clear(); // one outstanding pairing per family, older code invalidated
    const code=randomBytes(12).toString('hex');
    const expiresAt=now+5*60_000;
    this.pairings.set(digest(code),{expiresAt});
    return {code,expiresAt:new Date(expiresAt).toISOString()};
  }
  async complete(code,name){
    if(typeof code!=='string'||!(/^[0-9a-f]{24}$/.test(code)))throw new Error('INVALID_PAIRING_CODE');
    if(typeof name!=='string'||name.trim().length<1||name.trim().length>NAME_LIMIT)throw new Error('INVALID_DEVICE_NAME');
    const key=digest(code),pairing=this.pairings.get(key);
    if(!pairing || pairing.expiresAt<=this.clock())throw new Error('INVALID_OR_EXPIRED_PAIRING');
    this.pairings.delete(key); // consumed even if persistence fails; never replay
    if(this.devices.filter(x=>!x.revoked).length>=MAX_DEVICES)throw new Error('DEVICE_LIMIT_REACHED');
    const token=randomBytes(32).toString('hex');
    const device={id:`dev-${randomUUID()}`,name:name.trim(),tokenHash:digest(token),createdAt:new Date(this.clock()).toISOString(),lastSeenAt:null,revoked:false,capabilities:[]};
    this.devices.push(device);
    try{await this.persist();}catch(e){this.devices=this.devices.filter(x=>x.id!==device.id);throw e;}
    return {deviceId:device.id,token}; // display once; only hash is persisted
  }
  authenticate(id,token){
    if(typeof id!=='string'||typeof token!=='string'||!(/^[0-9a-f]{64}$/.test(token)))return null;
    const device=this.devices.find(x=>x.id===id&&!x.revoked);
    return device&&same(device.tokenHash,digest(token))?{id:device.id,name:device.name}:null;
  }
  async heartbeat(id,token){
    const device=this.authenticate(id,token);
    if(!device)throw new Error('DEVICE_UNAUTHORIZED');
    const row=this.devices.find(x=>x.id===id);const old=row.lastSeenAt;
    row.lastSeenAt=new Date(this.clock()).toISOString();
    try{await this.persist();}catch(e){row.lastSeenAt=old;throw e;}
    return {ok:true,deviceId:id,serverTime:new Date(this.clock()).toISOString()};
  }
  async revoke(actor,id){
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    const row=this.devices.find(x=>x.id===id&&!x.revoked);
    if(!row)return false;
    row.revoked=true;
    try{await this.persist();}catch(e){row.revoked=false;throw e;}
    return true;
  }
}
