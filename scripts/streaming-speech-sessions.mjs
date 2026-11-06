// R9 server-owned, short-lived streaming PCM playback sessions.
// Only metadata and a bounded set of outstanding PCM sample counts remain.
// The provider's raw PCM is pulled as the authenticated browser requests
// another chunk. Acks are client playback claims, NOT acoustic attestation.
import {randomUUID} from 'node:crypto';
import {SPEECH_PCM_RATE} from './streaming-speech-provider.mjs';
import {SpeechDeliveryBudget} from './speech-delivery-budget.mjs';
import {SpeechLatencyObserver} from './speech-latency-observer.mjs';
import {SentencePlaybackReceipts} from './sentence-playback-receipts.mjs';

export const SPEECH_MAX_ACTIVE=4;
export const SPEECH_MAX_UNACKED=3;
export const SPEECH_SESSION_IDLE_MS=12_000;
export const SPEECH_SESSION_ABSOLUTE_MS=65_000;
const MAX_STARTS_PER_MINUTE=6;
const validId=id=>typeof id==='string'
  &&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id);
const empty=()=>({started:0,completed:0,cancelled:0,expired:0,
  failed:0,deliveredSamples:0,acknowledgedSamples:0,
  lastFirstChunkMs:null,lastClaimedPlaybackMs:null});
export class StreamingSpeechSessions {
 #sessions=new Map();
 #owners=new Map();
 #attempts=new Map();
 #metrics=new Map();
 constructor({provider,now=()=>Date.now(),makeId=randomUUID,
   maxActive=SPEECH_MAX_ACTIVE,budget=new SpeechDeliveryBudget(),
   latency=new SpeechLatencyObserver(),authorizeDelivery=()=>{}}={}){
  if(!provider||typeof provider.open!=='function')
   throw Error('INVALID_SPEECH_PROVIDER');
  if(typeof authorizeDelivery!=='function')
   throw Error('INVALID_SPEECH_DELIVERY_AUTHORIZER');
  this.provider=provider;this.now=now;this.makeId=makeId;
  this.maxActive=maxActive;this.budget=budget;this.latency=latency;
  this.authorizeDelivery=authorizeDelivery;
 }
 #record(principal,event,extra={}){
  const row=this.#metrics.get(principal)??empty();
  if(event)row[event]=(row[event]??0)+1;
  Object.assign(row,extra);this.#metrics.set(principal,row);
 }
 #release(session,reason){
  if(this.#sessions.get(session.id)!==session)return;
  this.#sessions.delete(session.id);
  if(this.#owners.get(session.principal)===session.id)
   this.#owners.delete(session.principal);
  session.controller.abort();
  try{void session.source?.close?.();}catch{}
  session.outstanding.clear();
  session.receipts?.cancel();
  if(reason)this.#record(session.principal,reason);
 }
 sweep(){
  const now=this.now();
  for(const session of this.#sessions.values())
   if(now-session.openedAt>SPEECH_SESSION_ABSOLUTE_MS
     ||now-session.lastAt>SPEECH_SESSION_IDLE_MS)
    this.#release(session,'expired');
  for(const [principal,times] of this.#attempts){
   const recent=times.filter(t=>now-t<60000);
   if(recent.length)this.#attempts.set(principal,recent);
   else this.#attempts.delete(principal);
  }
  return this.#sessions.size;
 }
 async start(principal,{text,segments}={}){
  if(typeof principal!=='string'||!principal||principal.length>100)
   throw Error('INVALID_AUDIO_PRINCIPAL');
  this.sweep();
  this.budget.check(principal);
  if(this.#owners.has(principal))throw Error('AUDIO_ALREADY_ACTIVE');
  if(this.#sessions.size>=this.maxActive)throw Error('AUDIO_SERVER_BUSY');
  const startedAt=this.now();
  const history=(this.#attempts.get(principal)??[])
   .filter(t=>startedAt-t<60000);
  if(history.length>=MAX_STARTS_PER_MINUTE)
   throw Error('AUDIO_RATE_LIMIT');
  history.push(startedAt);this.#attempts.set(principal,history);
  const id=this.makeId();
  if(!validId(id)||this.#sessions.has(id))
   throw Error('INVALID_SPEECH_SESSION_ID');
  const session={
   id,principal,openedAt:startedAt,lastAt:startedAt,phase:'starting',
   controller:new AbortController(),source:null,seq:0,acked:0,
   busy:false,deliveredSamples:0,playedSamples:0,
   firstChunkAt:null,firstAckAt:null,drained:false,outstanding:new Map(),
   receipts:new SentencePlaybackReceipts({sentenceCount:segments?.length??1}),
   lastDeliveredSentenceIndex:-1,lastDeliveryAt:null,
   lastAckSentenceIndex:-1,lastAckAt:null
  };
  this.#sessions.set(id,session);this.#owners.set(principal,id);
  this.#record(principal,'started');
  try{
   const source=await this.provider.open({text,segments,signal:session.controller.signal});
   if(this.#sessions.get(id)!==session||session.controller.signal.aborted){
    await source.close();throw Error('AUDIO_REQUEST_CANCELLED');
   }
   session.source=source;session.phase='ready';session.lastAt=this.now();
   return {id,format:'pcm16-mono-24khz',sampleRate:SPEECH_PCM_RATE,
    maxUnacknowledged:SPEECH_MAX_UNACKED,transport:'pull-pcm-http',
    requiresExplicitPlayback:true,upstream:'http-streaming-pcm-tts'};
  }catch(error){
   if(this.#sessions.get(id)===session)this.#release(session,'failed');
   throw error;
  }
 }
 #get(principal,id){
  if(!validId(id))throw Error('INVALID_SPEECH_SESSION_ID');
  this.sweep();
  const session=this.#sessions.get(id);
  if(!session)throw Error('UNKNOWN_SPEECH_SESSION');
  if(session.principal!==principal)throw Error('SPEECH_SESSION_FORBIDDEN');
  if(session.controller.signal.aborted)throw Error('AUDIO_REQUEST_CANCELLED');
  return session;
 }
 async next(principal,id,seq){
  const session=this.#get(principal,id);
  if(session.phase!=='ready'||session.busy||session.drained)
   throw Error('SPEECH_SESSION_NOT_READY');
  if(!Number.isSafeInteger(seq)||seq!==session.seq)
   throw Error('INVALID_SPEECH_SEQUENCE');
  if(session.outstanding.size>=SPEECH_MAX_UNACKED)
   throw Error('SPEECH_PLAYBACK_BACKPRESSURE');
  this.budget.check(principal);
  try{this.authorizeDelivery(principal);}
  catch(error){
   this.#release(session,'cancelled');
   throw error;
  }
  session.busy=true;session.lastAt=this.now();
  try{
   const block=await session.source.read();
   if(this.#sessions.get(id)!==session||session.controller.signal.aborted){
    // A non-cooperative vendor may resolve a stale read after the owner
    // revoked the session. Drop and zero its memory before returning.
    if(Buffer.isBuffer(block?.pcm))block.pcm.fill(0);
    throw Error('AUDIO_REQUEST_CANCELLED');
   }
   if(block.done){
    session.drained=true;
    session.phase='drained';
    session.lastAt=this.now();
    if(session.outstanding.size===0){
     this.#record(principal,'completed',{
      lastClaimedPlaybackMs:Math.round(session.playedSamples/SPEECH_PCM_RATE*1000)
     });
     this.latency.record(principal,'completionMs',
       Math.max(0,this.now()-session.openedAt));
     this.#release(session,null);
    }
    return {done:true};
   }
   if(!Buffer.isBuffer(block.pcm)||block.pcm.length<2
     ||block.pcm.length>4800||block.pcm.length%2
     ||block.samples!==block.pcm.length/2){
    throw Error('SPEECH_PROVIDER_INVALID_PCM');
   }
   // Authorization may change while an upstream read is pending. Recheck
   // inside the owner-bound session before charging or returning PCM.
   try{this.authorizeDelivery(principal);}
   catch(error){
    if(Buffer.isBuffer(block?.pcm))block.pcm.fill(0);
    throw error;
   }
   // Count only bytes accepted into the authenticated downlink. Checking
   // after provider.read() also protects against a partial final block.
   const segmentIndex=block.sentenceIndex??0;
   if(!Number.isSafeInteger(segmentIndex)||segmentIndex<0
     ||segmentIndex>=session.receipts.snapshot().sentenceCount)
    throw Error('SPEECH_INVALID_SENTENCE_INDEX');
   // Invalid sentence metadata must not charge a learner's delivered-audio
   // allowance. Validate the transition before accounting any samples.
   const previous=session.receipts.snapshot().deliveredSentenceIndex;
   if(segmentIndex<previous||segmentIndex>previous+1)
    throw Error('SPEECH_INVALID_SENTENCE_INDEX');
   try{this.budget.consume(principal,block.samples);}
   catch(error){
    // A failed durable reservation or exhausted quota cannot release the
    // supplier PCM frame to a downstream browser.
    block.pcm.fill(0);
    throw error;
   }
   const observedAt=this.now();
   session.receipts.delivered(segmentIndex,block.samples,observedAt);
   if(segmentIndex!==session.lastDeliveredSentenceIndex){
    this.latency.record(principal,'sentenceFirstDeliveryMs',
      Math.max(0,observedAt-session.openedAt));
    if(session.lastDeliveryAt!==null)
     this.latency.record(principal,'sentenceHandoffMs',
       Math.max(0,observedAt-session.lastDeliveryAt));
   }
   session.lastDeliveredSentenceIndex=segmentIndex;
   session.lastDeliveryAt=observedAt;
   session.seq++;
   session.outstanding.set(seq,{samples:block.samples,segmentIndex});
   session.deliveredSamples+=block.samples;session.lastAt=this.now();
   if(session.firstChunkAt===null){
    session.firstChunkAt=this.now();
    const elapsed=Math.max(0,this.now()-session.openedAt);
    this.#record(principal,null,{lastFirstChunkMs:elapsed});
    this.latency.record(principal,'firstChunkMs',elapsed);
   }
   const row=this.#metrics.get(principal);
   row.deliveredSamples+=block.samples;
   return {done:false,seq,samples:block.samples,pcm:block.pcm,
     sentenceIndex:segmentIndex,
     sentenceCount:session.receipts.snapshot().sentenceCount};
  }catch(error){
   if(this.#sessions.get(id)===session)this.#release(session,'failed');
   throw error;
  }finally{session.busy=false;}
 }
 ack(principal,id,seq){
  const session=this.#get(principal,id);
  if(!Number.isSafeInteger(seq)||seq!==session.acked
    ||!session.outstanding.has(seq))
   throw Error('INVALID_SPEECH_ACK_SEQUENCE');
  const {samples,segmentIndex}=session.outstanding.get(seq);
  const acknowledgedAt=this.now();
  session.receipts.acknowledge(segmentIndex,samples,acknowledgedAt);
  if(segmentIndex!==session.lastAckSentenceIndex){
   this.latency.record(principal,'sentenceFirstAckMs',
     Math.max(0,acknowledgedAt-session.openedAt));
   if(session.lastAckAt!==null)
    this.latency.record(principal,'sentenceAckTransitionMs',
      Math.max(0,acknowledgedAt-session.lastAckAt));
  }
  session.lastAckSentenceIndex=segmentIndex;
  session.lastAckAt=acknowledgedAt;
  session.outstanding.delete(seq);session.acked++;
  session.playedSamples+=samples;
  session.lastAt=this.now();
  if(session.firstAckAt===null){
   session.firstAckAt=session.lastAt;
   this.latency.record(principal,'firstPlaybackAckMs',
     Math.max(0,session.firstAckAt-session.openedAt));
  }
  this.#metrics.get(principal).acknowledgedSamples+=samples;
  const finished=session.drained&&!session.outstanding.size;
  if(finished){
   this.#record(principal,'completed',{
    lastClaimedPlaybackMs:Math.round(session.playedSamples/SPEECH_PCM_RATE*1000)
   });
   this.latency.record(principal,'completionMs',
    Math.max(0,this.now()-session.openedAt));
   this.#release(session,null);
  }
  return {acknowledgedSeq:seq,sentenceIndex:segmentIndex,
   nextAckSeq:session.acked,
   playedSamplesClaimed:session.playedSamples,
   playedMsClaimed:Math.round(session.playedSamples/SPEECH_PCM_RATE*1000),
   completed:finished};
 }
 status(principal,id){
  const session=this.#get(principal,id);
  return {id:session.id,phase:session.phase,
   nextSeq:session.seq,nextAckSeq:session.acked,
   outstanding:session.outstanding.size,
   deliveredSamples:session.deliveredSamples,
   playedSamplesClaimed:session.playedSamples,
   firstChunkMs:session.firstChunkAt===null?null:
    Math.max(0,session.firstChunkAt-session.openedAt),
   playbackAttested:false,
   sentenceReceipts:session.receipts.snapshot()};
 }
 cancel(principal,id){
  if(id===undefined||id===null)id=this.#owners.get(principal);
  if(!validId(id))return {cancelled:false};
  const session=this.#sessions.get(id);
  if(!session||session.principal!==principal)return {cancelled:false};
  const playedMsClaimed=Math.round(session.playedSamples/SPEECH_PCM_RATE*1000);
  this.#record(principal,null,{lastClaimedPlaybackMs:playedMsClaimed});
  this.#release(session,'cancelled');
  return {cancelled:true,playedMsClaimed};
 }
 cancelChildren(){
  for(const session of [...this.#sessions.values()])
   if(session.principal==='child'||session.principal.startsWith('learner:'))
    this.cancel(session.principal,session.id);
 }
 erasePrincipal(principal){
  this.cancel(principal);
  const removed=this.#metrics.delete(principal);
  this.#attempts.delete(principal);
  this.budget.erasePrincipal(principal);
  this.latency.erasePrincipal(principal);
  return Number(removed);
 }
 eraseScope(scope){
  if(!['parent','child','all'].includes(scope))
   throw Error('INVALID_AUDIO_ERASE_SCOPE');
  const principals=new Set([...this.#owners.keys(),
   ...this.#attempts.keys(),...this.#metrics.keys()]);
  let count=0;
  for(const principal of principals){
   const child=principal==='child'||principal.startsWith('learner:');
   if(scope==='all'||(scope==='child'&&child)
     ||(scope==='parent'&&!child))
    count+=this.erasePrincipal(principal);
  }
  this.budget.eraseScope(scope);
  this.latency.eraseScope(scope);
  return count;
 }
 metrics(principal){return structuredClone(this.#metrics.get(principal)??empty());}
 deliveryBudget(principal){return this.budget.snapshot(principal);}
 latencyMetrics(principal){return this.latency.snapshot(principal);}
 activeCount(){this.sweep();return this.#sessions.size;}
}
