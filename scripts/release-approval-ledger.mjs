// R72 人工发布审批账本：只记录家长对当前只读候选的明确决定，不执行部署或设备操作。
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {JsonStateStore} from './state-store.mjs';
import {verifyReleaseCandidate} from './release-candidate-manifest.mjs';

export const RELEASE_APPROVAL_SCHEMA='alex.dev/release-approval-ledger/v1';
const REQUEST=/^[A-Za-z0-9_-]{8,100}$/;
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>{throw Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>
  JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
};
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const exactArray=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((value,index)=>value===b[index]);

async function readCandidate(path){
 if(!path)return null;
 const stat=await lstat(path).catch(error=>{
  if(error?.code==='ENOENT')return null;
  throw error;
 });
 if(!stat)return null;
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>512*1024)
  fail('RELEASE_CANDIDATE_SOURCE_INVALID');
 const candidate=JSON.parse(await readFile(path,'utf8'));
 verifyReleaseCandidate(candidate);
 return candidate;
}

export class ReleaseApprovalLedger{
 constructor(file,{candidateFile=null,clock=()=>Date.now(),maxEvents=500}={}){
  if(candidateFile!==null&&(typeof candidateFile!=='string'||!candidateFile))
   fail('RELEASE_CANDIDATE_SOURCE_INVALID');
  if(!Number.isInteger(maxEvents)||maxEvents<10||maxEvents>5000)
   fail('RELEASE_APPROVAL_CAPACITY_INVALID');
  this.store=new JsonStateStore(file);
  this.candidateFile=candidateFile?resolve(candidateFile):null;
  this.clock=clock;this.maxEvents=maxEvents;
  this.seq=0;this.events=[];this.serial=Promise.resolve();
 }
 #exclusive(fn){
  const next=this.serial.catch(()=>{}).then(fn);
  this.serial=next.catch(()=>{});
  return next;
 }
 #validateEvent(event,prevHash,expectedSeq,requestIds){
  if(!object(event)||event.seq!==expectedSeq||
   !['approved','rejected'].includes(event.action)||
   event.reviewerRole!=='parent'||!REQUEST.test(event.requestId??'')||
   requestIds.has(event.requestId)||
   typeof event.candidateId!=='string'||!/^rc-[0-9a-f]{24}$/.test(event.candidateId)||
   !HASH.test(event.candidateDigestSha256??'')||
   !/^[0-9a-f]{40}$/.test(event.commitSha??'')||
   typeof event.at!=='string'||Number.isNaN(Date.parse(event.at))||
   event.prevHash!==prevHash||!HASH.test(event.hash??'')||
   !Array.isArray(event.acknowledgements))
   fail('RELEASE_APPROVAL_EVENT_INVALID');
  const {hash,...body}=event;
  if(digest(body)!==hash)fail('RELEASE_APPROVAL_HASH_CHAIN_INVALID');
  requestIds.add(event.requestId);
  return hash;
 }
 async load(){
  const state=await this.store.load();
  if(!state){this.seq=0;this.events=[];return;}
  if(!object(state)||state.schema!==RELEASE_APPROVAL_SCHEMA||
   !Number.isSafeInteger(state.seq)||state.seq<0||
   !Array.isArray(state.events)||state.events.length>this.maxEvents||
   state.seq!==state.events.length)
   fail('RELEASE_APPROVAL_STATE_INVALID');
  let prevHash='0'.repeat(64),seq=0;
  const requestIds=new Set();
  for(const event of state.events)
   prevHash=this.#validateEvent(event,prevHash,++seq,requestIds);
  this.seq=state.seq;this.events=structuredClone(state.events);
 }
 async flush(){await this.store.flush();}
 async #save(){
  await this.store.save({
   schema:RELEASE_APPROVAL_SCHEMA,
   seq:this.seq,
   events:this.events
  });
 }
 async currentCandidate(){return readCandidate(this.candidateFile);}
 #latestFor(candidate){
  return [...this.events].reverse().find(event=>
   event.candidateId===candidate.candidateId&&
   event.candidateDigestSha256===candidate.candidateDigestSha256)??null;
 }
 async status(){
  const candidate=await this.currentCandidate();
  if(!candidate)return {
   schema:'alex.dev/release-approval-status/v1',
   configured:false,status:'candidate-required',candidate:null,
   releaseApproved:false,deployExecuted:false,physicalSafetyCertified:false,
   decision:null
  };
  const latest=this.#latestFor(candidate);
  const approved=latest?.action==='approved'&&
   exactArray(latest.acknowledgements,candidate.requiredHumanChecks);
  return {
   schema:'alex.dev/release-approval-status/v1',
   configured:true,
   status:approved?'approved':latest?.action==='rejected'?'rejected':'pending-review',
   candidate:{
    candidateId:candidate.candidateId,
    candidateDigestSha256:candidate.candidateDigestSha256,
    commitSha:candidate.commitSha,
    createdAt:candidate.createdAt,
    target:candidate.target,
    requiredHumanChecks:structuredClone(candidate.requiredHumanChecks)
   },
   releaseApproved:approved,
   deployExecuted:false,
   physicalSafetyCertified:false,
   decision:latest?{
    action:latest.action,at:latest.at,reviewerRole:latest.reviewerRole,
    requestId:latest.requestId
   }:null
  };
 }
 async decide(actor,{
  action,candidateId,candidateDigestSha256,acknowledgements=[],requestId
 }={}){
  if(actor!=='parent')fail('PARENT_REQUIRED');
  if(!['approved','rejected'].includes(action))
   fail('INVALID_RELEASE_APPROVAL_ACTION');
  if(!REQUEST.test(requestId??''))fail('INVALID_RELEASE_APPROVAL_REQUEST_ID');
  return this.#exclusive(async()=>{
   const duplicate=this.events.find(event=>event.requestId===requestId);
   if(duplicate){
    if(duplicate.action!==action||duplicate.candidateId!==candidateId||
     duplicate.candidateDigestSha256!==candidateDigestSha256)
     fail('RELEASE_APPROVAL_IDEMPOTENCY_CONFLICT');
    return {duplicate:true,event:structuredClone(duplicate),status:await this.status()};
   }
   const candidate=await this.currentCandidate();
   if(!candidate)fail('RELEASE_CANDIDATE_REQUIRED');
   if(candidate.candidateId!==candidateId||
    candidate.candidateDigestSha256!==candidateDigestSha256)
    fail('RELEASE_CANDIDATE_CHANGED');
   const provided=[...new Set(Array.isArray(acknowledgements)?acknowledgements:[])].sort();
   const required=[...candidate.requiredHumanChecks].sort();
   if(action==='approved'&&!exactArray(provided,required))
    fail('RELEASE_APPROVAL_HUMAN_CHECKS_INCOMPLETE');
   if(action==='rejected'&&provided.length)
    fail('INVALID_RELEASE_REJECTION_ACKNOWLEDGEMENTS');
   if(this.events.length>=this.maxEvents)
    fail('RELEASE_APPROVAL_LEDGER_FULL');
   const prevHash=this.events.at(-1)?.hash??'0'.repeat(64);
   const body={
    seq:this.seq+1,
    candidateId:candidate.candidateId,
    candidateDigestSha256:candidate.candidateDigestSha256,
    commitSha:candidate.commitSha,
    action,reviewerRole:'parent',
    acknowledgements:action==='approved'?required:[],
    at:new Date(this.clock()).toISOString(),
    requestId,prevHash
   };
   const event={...body,hash:digest(body)};
   this.events.push(event);this.seq=event.seq;
   await this.#save();
   return {duplicate:false,event:structuredClone(event),status:await this.status()};
  });
 }
}
