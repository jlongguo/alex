// R13 bounded, volatile, non-content voice-turn telemetry.
// Duration metrics are server-side observations; never audio/hearing proof.
const KINDS=['modelCommitMs','speechOpenMs','readyMs','cancelMs','failureMs'];
const valid=p=>typeof p==='string'&&p.length>0&&p.length<=100;
const q=(arr,p)=>arr.length?[...arr].sort((a,b)=>a-b)[Math.ceil(arr.length*p)-1]:null;
export class VoiceTurnTelemetry {
 #entries=new Map();
 constructor({windowSize=128}={}){
  if(!Number.isSafeInteger(windowSize)||windowSize<1||windowSize>512)
   throw Error('INVALID_VOICE_TELEMETRY_WINDOW');
  this.windowSize=windowSize;
 }
 #row(principal){
  if(!valid(principal))throw Error('INVALID_AUDIO_PRINCIPAL');
  let row=this.#entries.get(principal);
  if(!row){row=Object.fromEntries(KINDS.map(k=>[k,[]]));
   this.#entries.set(principal,row);}
  return row;
 }
 record(principal,kind,ms){
  if(!KINDS.includes(kind)||!Number.isFinite(ms)||ms<0||ms>120000)
   throw Error('INVALID_VOICE_TELEMETRY_SAMPLE');
  const values=this.#row(principal)[kind];
  values.push(Math.round(ms));
  if(values.length>this.windowSize)values.shift();
 }
 snapshot(principal){
  const row=this.#row(principal);
  return Object.freeze({windowSize:this.windowSize,
   metric:'server-stage-duration-not-acoustic-proof',
   stages:Object.freeze(Object.fromEntries(KINDS.map(k=>{
    const arr=row[k];
    return [k,Object.freeze({count:arr.length,p50Ms:q(arr,0.5),
     p95Ms:q(arr,0.95)})];
   })))});
 }
 erasePrincipal(principal){
  if(!valid(principal))throw Error('INVALID_AUDIO_PRINCIPAL');
  return this.#entries.delete(principal);
 }
 eraseScope(scope){
  if(!['all','child','parent'].includes(scope))throw Error('INVALID_VOICE_ERASE_SCOPE');
  let n=0;
  for(const p of this.#entries.keys()){
   const child=p==='child'||p.startsWith('learner:');
   if(scope==='all'||(scope==='child'&&child)||(scope==='parent'&&!child)){
    this.#entries.delete(p);n++;
   }
  }
  return n;
 }
}
