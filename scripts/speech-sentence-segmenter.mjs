// R14 deterministic sentence boundary staging. Provisional text is memory-only
// and MUST NOT be spoken until the authoritative model commit is received.
const END=/[.!?。！？…]+(?:["'”’」』】）)\]]*)\s*/u;
const MAX_SEGMENT=500,MAX_TOTAL=1200;
export class SpeechSentenceSegmenter {
 #pending='';#segments=[];#total=0;#closed=false;
 constructor({maxSegment=MAX_SEGMENT,maxTotal=MAX_TOTAL}={}){
  if(!Number.isSafeInteger(maxSegment)||maxSegment<20||maxSegment>MAX_SEGMENT
    ||!Number.isSafeInteger(maxTotal)||maxTotal<maxSegment||maxTotal>MAX_TOTAL)
   throw Error('INVALID_SPEECH_SEGMENT_LIMIT');
  this.maxSegment=maxSegment;this.maxTotal=maxTotal;
 }
 push(delta){
  if(this.#closed)throw Error('SPEECH_SEGMENTER_CLOSED');
  if(typeof delta!=='string'||this.#total+delta.length>this.maxTotal
    ||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(delta))
   throw Error('INVALID_SPEECH_SEGMENT_INPUT');
  this.#total+=delta.length;this.#pending+=delta;
  const out=[];
  while(this.#pending.length){
   const match=END.exec(this.#pending);
   if(!match)break;
   const part=this.#pending.slice(0,match.index+match[0].length).trim();
   this.#pending=this.#pending.slice(match.index+match[0].length);
   if(part){this.#accept(part);out.push(part);}
  }
  // Hard boundary prevents a malicious/provider chunk from retaining an
  // unbounded unpunctuated string. Split only at whitespace when possible.
  while(this.#pending.length>this.maxSegment){
   let cut=this.#pending.lastIndexOf(' ',this.maxSegment);
   if(cut<Math.floor(this.maxSegment*0.6))cut=this.maxSegment;
   const part=this.#pending.slice(0,cut).trim();
   this.#pending=this.#pending.slice(cut).trimStart();
   if(part){this.#accept(part);out.push(part);}
  }
  return out;
 }
 #accept(part){
  if(part.length>this.maxSegment)throw Error('SPEECH_SEGMENT_TOO_LONG');
  this.#segments.push(part);
 }
 commit(){
  if(this.#closed)throw Error('SPEECH_SEGMENTER_CLOSED');
  this.#closed=true;
  const tail=this.#pending.trim();this.#pending='';
  if(tail)this.#accept(tail);
  return Object.freeze([...this.#segments]);
 }
 discard(){
  this.#closed=true;this.#pending='';this.#segments=[];this.#total=0;
 }
 get pendingChars(){return this.#pending.length;}
}
