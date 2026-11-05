// R16 provisional text staging: accumulation is NOT speech authorization.
// Only the authoritative committed response can release sentence text to TTS.
import {SpeechSentenceSegmenter} from './speech-sentence-segmenter.mjs';
const MAX_CHARS=1200;
export class ProvisionalTurnText {
 #buffer='';#closed=false;#received=0;#chunks=0;
 constructor({maxChars=MAX_CHARS}={}){
  if(!Number.isSafeInteger(maxChars)||maxChars<500||maxChars>MAX_CHARS)
   throw Error('INVALID_TURN_TEXT_LIMIT');
  this.maxChars=maxChars;
 }
 push(delta){
  if(this.#closed)throw Error('TURN_TEXT_STAGING_CLOSED');
  if(typeof delta!=='string'||this.#buffer.length+delta.length>this.maxChars
   ||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(delta))
   throw Error('INVALID_TURN_TEXT_DELTA');
  this.#buffer+=delta;this.#received+=delta.length;this.#chunks++;
  return this.snapshot();
 }
 commit(authoritative){
  if(this.#closed)throw Error('TURN_TEXT_STAGING_CLOSED');
  if(typeof authoritative!=='string'||!authoritative.trim()
   ||authoritative.length>this.maxChars)
   throw Error('INVALID_COMMITTED_TURN_TEXT');
  // Providers may normalize spaces in the authoritative result; never
  // substitute staged text when its content differs from the final reply.
  const matched=this.#buffer.length>0
    &&this.#buffer.trim()===authoritative.trim();
  const accumulatedChars=this.#received,chunkCount=this.#chunks;
  this.discard();
  const segmenter=new SpeechSentenceSegmenter();
  segmenter.push(authoritative);
  return Object.freeze({segments:segmenter.commit(),matched,
   stagedChars:accumulatedChars,chunkCount,
   source:'authoritative-commit-only'});
 }
 discard(){
  this.#closed=true;
  this.#buffer='';this.#received=0;this.#chunks=0;
 }
 snapshot(){
  return Object.freeze({phase:this.#closed?'discarded':'provisional',
   stagedChars:this.#received,chunks:this.#chunks,speechPermitted:false});
 }
}
