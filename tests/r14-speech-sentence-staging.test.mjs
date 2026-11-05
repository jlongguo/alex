import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechSentenceSegmenter} from '../scripts/speech-sentence-segmenter.mjs';
import {CommittedSpeechQueue} from '../scripts/committed-speech-queue.mjs';

test('R14 segments English and Chinese sentence endings across arbitrary chunks',()=>{
 const s=new SpeechSentenceSegmenter();
 assert.deepEqual(s.push('Hello wor'),[]);
 assert.deepEqual(s.push('ld! 你好'),['Hello world!']);
 assert.deepEqual(s.push('。Next?'),['你好。','Next?']);
 assert.deepEqual(s.commit(),[]);
});
test('R14 flushes final sentence only on explicit commit and rejects post-commit deltas',()=>{
 const s=new SpeechSentenceSegmenter();
 s.push('A final thought without punctuation');
 assert.equal(s.pendingChars,34);
 assert.deepEqual(s.commit(),['A final thought without punctuation']);
 assert.throws(()=>s.push('late'),/SPEECH_SEGMENTER_CLOSED/);
});
test('R14 enforces total and per-segment bounds and can discard provisional data',()=>{
 const s=new SpeechSentenceSegmenter({maxSegment:20,maxTotal:100});
 assert.throws(()=>s.push('x'.repeat(101)),/INVALID_SPEECH_SEGMENT_INPUT/);
 const parts=s.push('word '.repeat(8));
 assert.ok(parts.every(x=>x.length<=20));
 s.discard();
 assert.equal(s.pendingChars,0);
 assert.throws(()=>s.commit(),/SPEECH_SEGMENTER_CLOSED/);
});
test('R14 committed queue refuses provisional speech and drains in order',async()=>{
 const q=new CommittedSpeechQueue();
 q.stage(['First sentence.','Second sentence.']);
 await assert.rejects(q.drain(async()=>{}),/SPEECH_QUEUE_NOT_COMMITTED/);
 q.commit();
 const spoken=[];
 const result=await q.drain(async(text,{index})=>spoken.push([index,text]));
 assert.deepEqual(spoken,[[0,'First sentence.'],[1,'Second sentence.']]);
 assert.equal(result.phase,'complete');
 assert.equal(result.remaining,0);
});
test('R14 committed queue rejects overflow and cancellation erases staged text',()=>{
 const q=new CommittedSpeechQueue({maxSegments:2,maxChars:100});
 assert.throws(()=>q.stage(['a'.repeat(60),'b'.repeat(60)]),/SPEECH_QUEUE_LIMIT_EXCEEDED/);
 q.stage(['sensitive staged sentence']);
 q.cancel();
 assert.equal(q.snapshot().total,0);
 assert.equal(q.snapshot().phase,'cancelled');
 assert.throws(()=>q.commit(),/SPEECH_QUEUE_NOT_STAGING/);
});
test('R14 abort during sentence drain stops before the next segment',async()=>{
 const q=new CommittedSpeechQueue();
 q.stage(['one.','two.','three.']);q.commit();
 const controller=new AbortController(),spoken=[];
 await assert.rejects(q.drain(async(text)=>{
  spoken.push(text);controller.abort();
 },{signal:controller.signal}),/SPEECH_QUEUE_CANCELLED/);
 assert.deepEqual(spoken,['one.']);
 assert.equal(q.snapshot().total,0);
});
