// R12 privacy-preserving, bounded latency observations.
// Records durations only, never transcripts, audio, model text or session IDs.
const MAX_MS=120_000;
const DEFAULT_WINDOW=128;
const TYPES=[
 'firstChunkMs','firstPlaybackAckMs','completionMs',
 'sentenceFirstDeliveryMs','sentenceHandoffMs','sentenceFirstAckMs',
 'sentenceAckTransitionMs'
];
const validPrincipal=p=>typeof p==='string'&&p.length>0&&p.length<=100;
const isChild=p=>p==='child'||p.startsWith('learner:');
function quantile(values,q){
 if(!values.length)return null;
 const sorted=[...values].sort((a,b)=>a-b);
 return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)];
}
export class SpeechLatencyObserver{
 #observations=new Map();
 constructor({windowSize=DEFAULT_WINDOW}={}){
  if(!Number.isSafeInteger(windowSize)||windowSize<1||windowSize>512)
   throw Error('INVALID_SPEECH_LATENCY_WINDOW');
  this.windowSize=windowSize;
 }
 #row(principal){
  if(!validPrincipal(principal))throw Error('INVALID_AUDIO_PRINCIPAL');
  let row=this.#observations.get(principal);
  if(!row){
   row=Object.fromEntries(TYPES.map(k=>[k,[]]));
   this.#observations.set(principal,row);
  }
  return row;
 }
 record(principal,type,elapsedMs){
  if(!TYPES.includes(type)||!Number.isFinite(elapsedMs)
    ||elapsedMs<0||elapsedMs>MAX_MS)
   throw Error('INVALID_SPEECH_LATENCY_SAMPLE');
  const row=this.#row(principal)[type];
  row.push(Math.round(elapsedMs));
  if(row.length>this.windowSize)row.shift();
  return row.length;
 }
 snapshot(principal){
  const row=this.#row(principal);
  return Object.freeze(Object.fromEntries(TYPES.map(type=>{
   const values=row[type];
   return [type,Object.freeze({
    count:values.length,p50Ms:quantile(values,0.5),
    p95Ms:quantile(values,0.95),maxMs:values.length?Math.max(...values):null
   })];
  }).concat([['windowSize',this.windowSize],
   ['source','server-observed-http-and-client-ack'],
   ['acousticProof',false]])));
 }
 erasePrincipal(principal){
  if(!validPrincipal(principal))throw Error('INVALID_AUDIO_PRINCIPAL');
  return this.#observations.delete(principal);
 }
 eraseScope(scope){
  if(!['parent','child','all'].includes(scope))throw Error('INVALID_AUDIO_ERASE_SCOPE');
  let removed=0;
  for(const principal of this.#observations.keys()){
   if(scope==='all'||(scope==='child'&&isChild(principal))
     ||(scope==='parent'&&!isChild(principal))){
    this.#observations.delete(principal);removed++;
   }
  }
  return removed;
 }
}
