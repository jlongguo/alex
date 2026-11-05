// R14 commit-gated speech staging. No provisional token can reach TTS
// or playback. A caller explicitly drains only after commit().
export class CommittedSpeechQueue {
 #items=[];#state='staging';#cursor=0;
 constructor({maxSegments=8,maxChars=1200}={}){
  if(!Number.isSafeInteger(maxSegments)||maxSegments<1||maxSegments>8
   ||!Number.isSafeInteger(maxChars)||maxChars<100||maxChars>1200)
   throw Error('INVALID_COMMITTED_SPEECH_QUEUE_LIMIT');
  this.maxSegments=maxSegments;this.maxChars=maxChars;
 }
 stage(segments){
  if(this.#state!=='staging')throw Error('SPEECH_QUEUE_NOT_STAGING');
  if(!Array.isArray(segments))throw Error('INVALID_SPEECH_QUEUE_SEGMENTS');
  const chars=this.#items.reduce((n,x)=>n+x.length,0);
  if(this.#items.length+segments.length>this.maxSegments
    ||chars+segments.reduce((n,x)=>n+(typeof x==='string'?x.length:0),0)>this.maxChars
    ||segments.some(x=>typeof x!=='string'||!x.trim()||x.length>500))
   throw Error('SPEECH_QUEUE_LIMIT_EXCEEDED');
  this.#items.push(...segments.map(x=>x.trim()));
  return this.snapshot();
 }
 commit(){
  if(this.#state!=='staging')throw Error('SPEECH_QUEUE_NOT_STAGING');
  this.#state='committed';return this.snapshot();
 }
 async drain(speak,{signal}={}){
  if(this.#state!=='committed'&&this.#state!=='draining')
   throw Error('SPEECH_QUEUE_NOT_COMMITTED');
  if(typeof speak!=='function')throw Error('INVALID_SPEECH_QUEUE_SPEAKER');
  this.#state='draining';
  while(this.#cursor<this.#items.length){
   if(signal?.aborted){this.cancel();throw Error('SPEECH_QUEUE_CANCELLED');}
   const index=this.#cursor, text=this.#items[index];
   await speak(text,{index,signal});
   if(signal?.aborted){this.cancel();throw Error('SPEECH_QUEUE_CANCELLED');}
   this.#cursor++;
  }
  this.#state='complete';return this.snapshot();
 }
 cancel(){
  this.#state='cancelled';this.#items=[];this.#cursor=0;
  return this.snapshot();
 }
 snapshot(){
  return Object.freeze({phase:this.#state,total:this.#items.length,
   nextIndex:this.#cursor,remaining:this.#items.length-this.#cursor,
   committed:this.#state!=='staging'&&this.#state!=='cancelled'});
 }
}
