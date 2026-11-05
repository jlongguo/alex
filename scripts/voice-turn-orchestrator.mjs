// R11 explicit reviewed-text -> companion reply -> streamed speech session.
// ASR input is NOT auto-submitted. No speech before committed text reply.
import {randomUUID} from 'node:crypto';
import {VoiceTurnTelemetry} from './voice-turn-telemetry.mjs';
import {ProvisionalTurnText} from './provisional-turn-text.mjs';
const MAX_ACTIVE=4, MAX_MS=45000;
const isPrincipal=x=>typeof x==='string'&&x.length>0&&x.length<=100;
const isId=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/.test(x);
// Resolve cancellation promptly even for a provider that ignores AbortSignal.
async function abortable(promise,signal){
 if(signal.aborted)throw Error('VOICE_TURN_CANCELLED');
 let onAbort;
 const abort=new Promise((_,reject)=>{
  onAbort=()=>reject(Error('VOICE_TURN_CANCELLED'));
  signal.addEventListener('abort',onAbort,{once:true});
 });
 try{return await Promise.race([promise,abort]);}
 finally{signal.removeEventListener('abort',onAbort);}
}
export class VoiceTurnOrchestrator {
 #active=new Map();#byId=new Map();
 constructor({conversations,speech,authorize=()=>{},now=()=>Date.now(),
   makeId=randomUUID,maxActive=MAX_ACTIVE,
   telemetry=new VoiceTurnTelemetry()}={}){
  if(typeof conversations?.streamTurn!=='function'||typeof conversations?.get!=='function'
    ||typeof speech?.start!=='function'||typeof speech?.cancel!=='function'
    ||typeof authorize!=='function'||!Number.isSafeInteger(maxActive)
    ||maxActive<1||maxActive>32)throw Error('INVALID_VOICE_TURN_CONFIG');
  Object.assign(this,{conversations,speech,authorize,now,makeId,maxActive,telemetry});
 }
 #owned(principal,id){
  if(!isId(id))throw Error('INVALID_VOICE_TURN_ID');
  const turn=this.#byId.get(id);
  if(!turn||turn.principal!==principal)throw Error('UNKNOWN_VOICE_TURN');
  return turn;
 }
 #check(t){
  if(t.controller.signal.aborted||this.#byId.get(t.id)!==t)
   throw Error('VOICE_TURN_CANCELLED');
  this.authorize(t.principal);
 }
 #snapshot(t){
  return Object.freeze({id:t.id,phase:t.phase,
   speechSessionId:t.phase==='ready'?t.speechId:null,
   elapsedMs:Math.max(0,this.now()-t.startedAt),
   textCommitted:t.committed,
   playbackProof:'client-claimed-only',
   audioAutoStarted:false});
 }
 #release(t,{cancelSpeech=true}={}){
  if(this.#byId.get(t.id)!==t)return;
  this.#byId.delete(t.id);
  if(this.#active.get(t.principal)===t.id)this.#active.delete(t.principal);
  t.controller.abort();
  if(cancelSpeech&&t.speechId)this.speech.cancel(t.principal,t.speechId);
 }
 async run(principal,{conversationId,text,onCreated=()=>{}}={}){
  if(typeof onCreated!=='function')throw Error('INVALID_VOICE_TURN_CALLBACK');
  if(!isPrincipal(principal)||!isId(conversationId)
    ||typeof text!=='string'||!text.trim()||text.length>500
    ||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
   throw Error('INVALID_VOICE_TURN_INPUT');
  this.sweep();
  if(this.#active.has(principal))throw Error('VOICE_TURN_ALREADY_ACTIVE');
  if(this.#active.size>=this.maxActive)throw Error('VOICE_TURN_SERVER_BUSY');
  this.authorize(principal);
  this.conversations.get(principal,conversationId);
  const id=this.makeId();
  if(!isId(id)||this.#byId.has(id))throw Error('INVALID_VOICE_TURN_ID');
  const t={id,principal,conversationId,phase:'thinking',startedAt:this.now(),
   controller:new AbortController(),speechId:null,committed:false,
   modelCommittedAt:null};
  this.#active.set(principal,id);this.#byId.set(id,t);
  const staged=new ProvisionalTurnText();
  const timeout=setTimeout(()=>t.controller.abort(),MAX_MS);
  timeout.unref?.();
  try{
   onCreated(id);
   this.#check(t);
   const modelPending=Promise.resolve().then(()=>
    this.conversations.streamTurn(principal,conversationId,text,{
     signal:t.controller.signal,
     onDelta:delta=>staged.push(delta) // Provisional data never goes to TTS.
    }));
   const result=await abortable(modelPending,t.controller.signal);
   // The companion manager has already committed its reply when it resolves.
   // A revocation immediately afterward must not relabel it as uncommitted.
   t.committed=true;
   t.modelCommittedAt=this.now();
   this.#check(t);
   this.telemetry.record(principal,'modelCommitMs',
    Math.max(0,t.modelCommittedAt-t.startedAt));
   this.#check(t);
   const spoken=result.assistant?.text;
   if(typeof spoken!=='string'||!spoken.trim())throw Error('VOICE_TURN_EMPTY_REPLY');
   // Only committed assistant text enters the sentence segmenter. Never
   // speak a provisional delta or cut the spoken excerpt mid-sentence.
   const stagedResult=staged.commit(spoken);
   const committedSegments=stagedResult.segments;
   // Cap upstream spending and buffered providers to four committed
   // sentences. The old single-sentence path remains valid.
   const selectedSegments=committedSegments.slice(0,4);
   const spokenExcerpt=selectedSegments[0]??spoken.slice(0,500);
   t.phase='opening-speech';
   const speechPending=Promise.resolve().then(()=>
    this.speech.start(principal,{text:spokenExcerpt,segments:selectedSegments}));
   // A cancelled request cannot strand a late-opened upstream TTS session.
   // Handle its eventual resolution even when the deadline already won.
   speechPending.then(start=>{
    if((t.controller.signal.aborted||this.#byId.get(id)!==t)
      &&isId(start?.id))this.speech.cancel(principal,start.id);
   },()=>{});
   const start=await abortable(speechPending,t.controller.signal);
   if(t.controller.signal.aborted||this.#byId.get(id)!==t)
    throw Error('VOICE_TURN_CANCELLED');
   t.speechId=start.id;
   this.#check(t);
   t.phase='ready';
   this.telemetry.record(principal,'speechOpenMs',
    Math.max(0,this.now()-t.modelCommittedAt));
   this.telemetry.record(principal,'readyMs',
    Math.max(0,this.now()-t.startedAt));
   return {turn:this.#snapshot(t),speechSession:start,
    assistant:result.assistant,session:result.session,
    speechTextTruncated:committedSegments.length>selectedSegments.length,
    speechSegmentCount:committedSegments.length,
    speechSegmentsSelected:selectedSegments.length,
    provisionalMatchedCommit:stagedResult.matched};
  }catch(error){
   staged.discard();
   const cancelled=t.controller.signal.aborted
     ||error?.message==='VOICE_TURN_CANCELLED'
     ||error?.message==='COMPANION_TURN_CANCELLED';
   t.phase=cancelled?'cancelled':'failed';
   if(this.#byId.get(id)===t&&!cancelled)
    this.telemetry.record(principal,'failureMs',
     Math.max(0,this.now()-t.startedAt));
   this.#release(t);
   if(cancelled)throw Error('VOICE_TURN_CANCELLED');
   throw error;
  }finally{clearTimeout(timeout);}
 }
 status(principal,id){this.sweep();return this.#snapshot(this.#owned(principal,id));}
 sweep(){
  for(const t of [...this.#byId.values()])
   if(this.now()-t.startedAt>75000)this.cancel(t.principal,t.id);
  return this.#active.size;
 }
 cancel(principal,id=this.#active.get(principal)){
  const t=this.#byId.get(id);
  if(!t||t.principal!==principal)return {cancelled:false};
  const status=this.#snapshot(t);
  this.telemetry.record(principal,'cancelMs',
   Math.max(0,this.now()-t.startedAt));
  this.#release(t);
  return {cancelled:true,textCommitted:status.textCommitted,
   speechSessionId:status.speechSessionId};
 }
 cancelChildren(){
  for(const t of [...this.#byId.values()])
   if(t.principal==='child'||t.principal.startsWith('learner:'))
    this.cancel(t.principal,t.id);
 }
 erasePrincipal(principal){
  const result=this.cancel(principal).cancelled;
  this.telemetry.erasePrincipal(principal);
  return result;
 }
 eraseScope(scope){
  if(!['all','parent','child'].includes(scope))throw Error('INVALID_VOICE_ERASE_SCOPE');
  let count=0;
  for(const t of [...this.#byId.values()]){
   const child=t.principal==='child'||t.principal.startsWith('learner:');
   if(scope==='all'||(scope==='child'&&child)||(scope==='parent'&&!child))
    count+=Number(this.cancel(t.principal,t.id).cancelled);
  }
  this.telemetry.eraseScope(scope);
  return count;
 }
 metrics(principal){return this.telemetry.snapshot(principal);}
 activeCount(){return this.sweep();}
}
