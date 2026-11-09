// R34 local trust store for declarative Skill package provenance.
// Verifies bytes and Ed25519 signatures; never loads/evaluates the package bytes.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
const fail=code=>{throw Error(code);};
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9.-]{2,79}$/.test(v);
const ver=v=>typeof v==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const digest=b=>createHash('sha256').update(b).digest('hex');
const pair=(id,version)=>id+'@'+version;
export function canonicalJson(v){
 if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonicalJson).join(',')+']';
 if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype)
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(v[k])).join(',')+'}';
 fail('INVALID_ATTESTATION_DOCUMENT');
}
export const manifestDigest=manifest=>digest(Buffer.from(canonicalJson(manifest)));
export const signedPayload=(manifestSha256,artifactSha256)=>
 Buffer.from('alex.skill.attestation.v1\\n'+manifestSha256+'\\n'+artifactSha256,'utf8');
const strictBase64=value=>{
 if(typeof value!=='string'||!value||value.length>90000||
  !/^[a-zA-Z0-9+/]+={0,2}$/.test(value)||value.length%4!==0)
  fail('INVALID_ARTIFACT_BASE64');
 const bytes=Buffer.from(value,'base64');
 if(bytes.toString('base64')!==value)fail('INVALID_ARTIFACT_BASE64');
 return bytes;
};
function publicKey(pem){
 if(typeof pem!=='string'||pem.length>4096)fail('INVALID_PUBLISHER_KEY');
 try{
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519')fail('INVALID_PUBLISHER_KEY');
  return key;
 }catch{fail('INVALID_PUBLISHER_KEY');}
}
function fingerprint(key){return digest(key.export({type:'spki',format:'der'}));}
function checkState(state){
 if(!state||state.schemaVersion!==1||!Array.isArray(state.publishers)||
  !Array.isArray(state.attestations)||!Array.isArray(state.events)||
  Object.keys(state).sort().join(',')!=='attestations,events,publishers,schemaVersion'||
  state.publishers.length>100||state.attestations.length>500||state.events.length>2000)
  fail('INVALID_SKILL_TRUST_STATE');
 const pubs=new Set(),att=new Set();
 for(const p of state.publishers){
  if(!p||Object.keys(p).sort().join(',')!=='fingerprint,id,publicKeyPem,revoked'||
   !id(p.id)||typeof p.revoked!=='boolean'||pubs.has(p.id)||
   fingerprint(publicKey(p.publicKeyPem))!==p.fingerprint)
    fail('INVALID_SKILL_TRUST_STATE');
  pubs.add(p.id);
 }
 for(const a of state.attestations){
  if(!a||Object.keys(a).sort().join(',')!=='artifactSha256,id,manifestSha256,publisherId,signature,version'||
   !id(a.id)||!ver(a.version)||!hex(a.manifestSha256)||!hex(a.artifactSha256)||
   !pubs.has(a.publisherId)||att.has(pair(a.id,a.version)))
   fail('INVALID_SKILL_TRUST_STATE');
  const publisher=state.publishers.find(p=>p.id===a.publisherId);
  const sig=strictBase64(a.signature);
  if(sig.length!==64||!verify(null,signedPayload(a.manifestSha256,a.artifactSha256),
    publicKey(publisher.publicKeyPem),sig))fail('INVALID_SKILL_TRUST_STATE');
  att.add(pair(a.id,a.version));
 }
 let previous='0'.repeat(64);
 for(let index=0;index<state.events.length;index++){
  const e=state.events[index];
  if(!e||Object.keys(e).sort().join(',')!=='action,at,hash,prevHash,seq,target'||
   e.seq!==index+1||!['publisher.enroll','publisher.revoke','package.attest'].includes(e.action)||
   typeof e.at!=='string'||!Number.isFinite(Date.parse(e.at))||
   typeof e.target!=='string'||e.target.length>200||e.prevHash!==previous||
   e.hash!==digest(Buffer.from(canonicalJson({action:e.action,at:e.at,
     prevHash:e.prevHash,seq:e.seq,target:e.target}))))
   fail('INVALID_SKILL_TRUST_STATE');
  previous=e.hash;
 }
}
export class SkillPackageTrust{
 #state={schemaVersion:1,publishers:[],attestations:[],events:[]};
 #queue=Promise.resolve();
 constructor({file}={}){
  if(typeof file!=='string'||!file)fail('INVALID_SKILL_TRUST_CONFIG');
  this.store=new JsonStateStore(file);
 }
 async load(){
  const saved=await this.store.load();
  if(!saved)return;
  checkState(saved);
  this.#state=structuredClone(saved);
 }
 list(actor){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  return structuredClone(this.#state);
 }
 #mutate(actor,fn){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  const op=this.#queue.catch(()=>{}).then(async()=>{
   const next=structuredClone(this.#state);
   const {action,target,value}=fn(next);
   const entry={seq:next.events.length+1,action,target,at:new Date().toISOString(),
    prevHash:next.events.at(-1)?.hash??'0'.repeat(64)};
   next.events.push({...entry,hash:digest(Buffer.from(canonicalJson(entry)))});
   checkState(next);
   await this.store.save(next);
   this.#state=next;
   return structuredClone(value);
  });
  this.#queue=op.catch(()=>{});
  return op;
 }
 enroll(actor,{publisherId,publicKeyPem}={}){
  const key=publicKey(publicKeyPem),fp=fingerprint(key);
  if(!id(publisherId))fail('INVALID_PUBLISHER_ID');
  return this.#mutate(actor,s=>{
   if(s.publishers.some(p=>p.id===publisherId||p.fingerprint===fp))
    fail('PUBLISHER_ALREADY_EXISTS');
   s.publishers.push({id:publisherId,publicKeyPem,revoked:false,fingerprint:fp});
   return {action:'publisher.enroll',target:publisherId,value:{publisherId,fingerprint:fp}};
  });
 }
 revoke(actor,{publisherId}={}){
  return this.#mutate(actor,s=>{
   const pub=s.publishers.find(p=>p.id===publisherId);
   if(!pub||pub.revoked)fail('PUBLISHER_NOT_ACTIVE');
   pub.revoked=true;
   return {action:'publisher.revoke',target:publisherId,value:{publisherId,revoked:true}};
  });
 }
 attest(actor,{manifest,artifactBase64,publisherId,signature}={}){
  if(!manifest||!id(manifest.id)||!ver(manifest.version))fail('INVALID_SKILL_ATTESTATION');
  const bytes=strictBase64(artifactBase64);
  if(bytes.length===0||bytes.length>65536)fail('INVALID_ARTIFACT_SIZE');
  const mh=manifestDigest(manifest),ah=digest(bytes),sig=strictBase64(signature);
  if(sig.length!==64)fail('INVALID_SKILL_SIGNATURE');
  return this.#mutate(actor,s=>{
   const pub=s.publishers.find(p=>p.id===publisherId);
   if(!pub||pub.revoked)fail('PUBLISHER_NOT_ACTIVE');
   if(s.attestations.some(a=>pair(a.id,a.version)===pair(manifest.id,manifest.version)))
    fail('SKILL_ATTESTATION_EXISTS');
   if(!verify(null,signedPayload(mh,ah),publicKey(pub.publicKeyPem),sig))
    fail('INVALID_SKILL_SIGNATURE');
   s.attestations.push({id:manifest.id,version:manifest.version,publisherId,
    manifestSha256:mh,artifactSha256:ah,signature});
   return {action:'package.attest',target:pair(manifest.id,manifest.version),
    value:{id:manifest.id,version:manifest.version,publisherId,manifestSha256:mh,
     artifactSha256:ah,executable:false}};
  });
 }
 assertTrusted(manifest){
  const a=this.#state.attestations.find(a=>a.id===manifest?.id&&a.version===manifest?.version);
  if(!a||a.manifestSha256!==manifestDigest(manifest))
   fail('SKILL_ATTESTATION_REQUIRED');
  const pub=this.#state.publishers.find(p=>p.id===a.publisherId);
  if(!pub||pub.revoked)fail('PUBLISHER_NOT_ACTIVE');
  if(!verify(null,signedPayload(a.manifestSha256,a.artifactSha256),
    publicKey(pub.publicKeyPem),strictBase64(a.signature)))
   fail('INVALID_SKILL_SIGNATURE');
  return {publisherId:a.publisherId,manifestSha256:a.manifestSha256,
   artifactSha256:a.artifactSha256};
 }
}
