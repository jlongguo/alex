// R10 memory-only, per-principal daily delivered PCM allowance.
// Not supplier billed usage; the budget resets at UTC midnight.
export const PCM_SAMPLES_PER_SECOND=24000;
const DAY_MS=86400000;
export class SpeechDeliveryBudget {
  #days=new Map();
  constructor({dailySeconds=120,now=()=>Date.now()}={}){
    if(!Number.isSafeInteger(dailySeconds)||dailySeconds<1||dailySeconds>86400
      ||typeof now!=='function')throw Error('INVALID_SPEECH_BUDGET_CONFIG');
    this.dailySeconds=dailySeconds;this.limit=dailySeconds*PCM_SAMPLES_PER_SECOND;
    this.now=now;
  }
  #get(principal){
    if(typeof principal!=='string'||!principal||principal.length>100)
      throw Error('INVALID_AUDIO_PRINCIPAL');
    const ms=this.now();
    if(!Number.isFinite(ms))throw Error('INVALID_SPEECH_BUDGET_CLOCK');
    const day=Math.floor(ms/DAY_MS),current=this.#days.get(principal);
    if(current?.day===day)return current;
    const row={day,deliveredSamples:0};
    this.#days.set(principal,row);return row;
  }
  check(principal,samples=1){
    if(!Number.isSafeInteger(samples)||samples<1||samples>2400)
      throw Error('INVALID_SPEECH_BUDGET_SAMPLES');
    if(this.#get(principal).deliveredSamples+samples>this.limit)
      throw Error('SPEECH_DAILY_DELIVERY_LIMIT');
    return true;
  }
  consume(principal,samples){
    this.check(principal,samples);
    this.#get(principal).deliveredSamples+=samples;
    return this.snapshot(principal);
  }
  snapshot(principal){
    const row=this.#get(principal);
    return Object.freeze({
      dayUtc:new Date(row.day*DAY_MS).toISOString().slice(0,10),
      limitSeconds:this.dailySeconds,deliveredSamples:row.deliveredSamples,
      deliveredMs:Math.floor(row.deliveredSamples*1000/PCM_SAMPLES_PER_SECOND),
      remainingSamples:this.limit-row.deliveredSamples,
      remainingMs:Math.floor((this.limit-row.deliveredSamples)*1000/PCM_SAMPLES_PER_SECOND),
      measurement:'alex-delivered-not-vendor-billed'
    });
  }
  erasePrincipal(principal){this.#get(principal);return this.#days.delete(principal);}
  eraseScope(scope){
    if(!['parent','child','all'].includes(scope))throw Error('INVALID_AUDIO_ERASE_SCOPE');
    let removed=0;
    for(const principal of this.#days.keys()){
      const child=principal==='child'||principal.startsWith('learner:');
      if(scope==='all'||(scope==='child'&&child)||(scope==='parent'&&!child)){
        this.#days.delete(principal);removed++;
      }
    }
    return removed;
  }
  sweep(){
    const day=Math.floor(this.now()/DAY_MS);
    for(const [principal,row] of this.#days)
      if(row.day!==day)this.#days.delete(principal);
    return this.#days.size;
  }
}
