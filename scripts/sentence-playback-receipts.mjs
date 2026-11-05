// R16 volatile, per-session metadata receipts. Never stores sentence text or PCM.
// Client ACK is a playback *claim*, not proof that sound was heard.
const MAX_SENTENCES=4, MAX_SAMPLES=1_920_000/2;
const validCount=n=>Number.isSafeInteger(n)&&n>=1&&n<=MAX_SENTENCES;
const validSamples=n=>Number.isSafeInteger(n)&&n>0&&n<=2400;
const validClock=n=>Number.isFinite(n)&&n>=0;
export class SentencePlaybackReceipts {
 #rows;#lastDelivered=-1;#lastAcked=-1;#cancelled=false;
 constructor({sentenceCount=1}={}){
  if(!validCount(sentenceCount))throw Error('INVALID_SENTENCE_RECEIPT_COUNT');
  this.#rows=Array.from({length:sentenceCount},(_,index)=>({
   index,framesDelivered:0,framesClaimed:0,
   deliveredSamples:0,claimedSamples:0,
   firstDeliveredAt:null,firstClaimedAt:null,lastClaimedAt:null
  }));
 }
 delivered(index,samples,now){
  if(this.#cancelled)throw Error('SENTENCE_RECEIPTS_CANCELLED');
  if(!Number.isSafeInteger(index)||index<0||index>=this.#rows.length
    ||index<this.#lastDelivered||index>this.#lastDelivered+1
    ||!validSamples(samples)||!validClock(now))
   throw Error('INVALID_SENTENCE_RECEIPT_DELIVERY');
  const row=this.#rows[index];
  if(row.deliveredSamples+samples>MAX_SAMPLES)
   throw Error('SENTENCE_RECEIPT_TOO_LARGE');
  row.framesDelivered++;row.deliveredSamples+=samples;
  row.firstDeliveredAt??=now;
  this.#lastDelivered=index;
 }
 acknowledge(index,samples,now){
  if(this.#cancelled)throw Error('SENTENCE_RECEIPTS_CANCELLED');
  if(!Number.isSafeInteger(index)||index<0||index>=this.#rows.length
    ||index<this.#lastAcked||index>this.#lastAcked+1
    ||!validSamples(samples)||!validClock(now))
   throw Error('INVALID_SENTENCE_RECEIPT_ACK');
  const row=this.#rows[index];
  if(row.claimedSamples+samples>row.deliveredSamples
    ||row.framesClaimed>=row.framesDelivered)
   throw Error('SENTENCE_RECEIPT_ACK_OVERFLOW');
  row.framesClaimed++;row.claimedSamples+=samples;
  row.firstClaimedAt??=now;row.lastClaimedAt=now;
  this.#lastAcked=index;
 }
 snapshot(){
  const rows=this.#rows.map(({index,framesDelivered,framesClaimed,
   deliveredSamples,claimedSamples,firstDeliveredAt,firstClaimedAt,lastClaimedAt})=>({
   index,framesDelivered,framesClaimed,deliveredSamples,claimedSamples,
   // Clock intervals are local server measurements, not acoustic gaps.
   firstDeliveredAt,firstClaimedAt,lastClaimedAt
  }));
  return structuredClone({sentenceCount:rows.length,
   deliveredSentenceIndex:this.#lastDelivered,
   claimedSentenceIndex:this.#lastAcked,
   cancelled:this.#cancelled,playbackProof:'client-claimed-only',
   sentences:rows});
 }
 cancel(){
  this.#cancelled=true;
  this.#rows=[];this.#lastDelivered=-1;this.#lastAcked=-1;
 }
}
