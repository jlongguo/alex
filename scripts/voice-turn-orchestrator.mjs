// R11 explicit reviewed-text -> companion reply -> streamed speech session.
// ASR input is NOT auto-submitted. No speech before committed text reply.
import {randomUUID} from 'node:crypto';
const MAX_ACTIVE=4, MAX_MS=45000;
const isPrincipal=x=>typeof x==='string'&&x.length>0&&x.length<=100;
const isId=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/.test(x);
const stages=['thinking','opening-speech','ready','cancelled','failed'];
export class VoiceTurnOrchestrator {
 #active=new Map();#byId=new Map();
 constructor({conversations,speech,authorize=()=>{},now=()=>Date.now(),
   makeId=randomUUID,maxActive=MAX_ACTIVE}={}){
  if(typeof conversations?.streamTurn!=='function'||typeof conversations?.get!=='function'
    ||typeof speech?.start!=='function'||typeof speech?.cancel!=='function'
    ||typeof authorize!=='function'||!Number.isSafeInteger(maxActive)
    ||maxActive<1||maxActive>32)throw Error('INVALID_VOICE_TURN_CONFIG');
  Object.assign(this,{conversations,speech,authorize,now,makeId,maxActive});
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
  if(cancelSpeech)this.speech.cancel(t.principal,t.speechId);
 }
 async run(principal,{conversationId,text}={}){
  if(!isPrincipal(principal)||!isId(conversationId)
    ||typeof text!=='string'||!text.trim()||text.length>500
    ||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
   throw Error('INVALID_VOICE_TURN_INPUT');
  if(this.#active.has(principal))throw Error('VOICE_TURN_ALREADY_ACTIVE');
  if(this.#active.size>=this.maxActive)throw Error('VOICE_TURN_SERVER_BUSY');
  this.authorize(principal);
  this.conversations.get(principal,conversationId);
  const id=this.makeId();
  if(!isId(id)||this.#byId.has(id))throw Error('INVALID_VOICE_TURN_ID');
  const t={id,principal,conversationId,phase:'thinking',startedAt:this.now(),
   controller:new AbortController(),speechId:null,committed:false};
  this.#active.set(principal,id);this.#byId.set(id,t);
  const timeout=setTimeout(()=>t.controller.abort(),MAX_MS);
  timeout.unref?.();
  try{
   this.#check(t);
   const result=await this.conversations.streamTurn(principal,conversationId,text,{
    signal:t.controller.signal,onDelta:()=>{} // Provisional model tokens never reach TTS.
   });
   t.committed=true;
   this.#check(t);
   const spoken=result.assistant?.text;
   if(typeof spoken!=='string'||!spoken.trim())throw Error('VOICE_TURN_EMPTY_REPLY');
   // Long textual replies remain in chat; output audio uses explicit bounded excerpt.
   t.phase='opening-speech';
   const start=await this.speech.start(principal,{text:spoken.slice(0,500)});
   t.speechId=start.id;
   this.#check(t);
   t.phase='ready';
   return {turn:this.#snapshot(t),speechSession:start,
    assistant:result.assistant,session:result.session,
    speechTextTruncated:spoken.length>500};
  }catch(error){
   t.phase=t.controller.signal.aborted?'cancelled':'failed';
   this.#release(t);
   if(t.controller.signal.aborted&&error?.message!=='VOICE_TURN_CANCELLED'
     &&error?.message!=='COMPANION_TURN_CANCELLED')
    throw Error('VOICE_TURN_CANCELLED');
   throw error;
  }finally{clearTimeout(timeout);}
 }
 status(principal,id){return this.#snapshot(this.#owned(principal,id));}
 cancel(principal,id=this.#active.get(principal)){
  const t=this.#byId.get(id);
  if(!t||t.principal!==principal)return {cancelled:false};
  const status=this.#snapshot(t);
  this.#release(t);
  return {cancelled:true,textCommitted:status.textCommitted,
   speechSessionId:status.speechSessionId};
 }
 cancelChildren(){
  for(const t of [...this.#byId.values()])
   if(t.principal==='child'||t.principal.startsWith('learner:'))
    this.cancel(t.principal,t.id);
 }
 erasePrincipal(principal){return this.cancel(principal).cancelled;}
 eraseScope(scope){
  if(!['all','parent','child'].includes(scope))throw Error('INVALID_VOICE_ERASE_SCOPE');
  let count=0;
  for(const t of [...this.#byId.values()]){
   const child=t.principal==='child'||t.principal.startsWith('learner:');
   if(scope==='all'||(scope==='child'&&child)||(scope==='parent'&&!child))
    count+=Number(this.cancel(t.principal,t.id).cancelled);
  }
  return count;
 }
 activeCount(){return this.#active.size;}
}
