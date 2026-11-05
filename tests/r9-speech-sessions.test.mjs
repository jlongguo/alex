import test from 'node:test';
import assert from 'node:assert/strict';
import {OutboundSpeechSessions} from '../scripts/outbound-speech-sessions.mjs';
const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';
const pcm=()=>new Uint8Array(4800);
const sleep=()=>new Promise(resolve=>setImmediate(resolve));
test('R9 speech sessions isolate learners, seq, completion, erase',async()=>{
  let index=0;
  const sessions=new OutboundSpeechSessions({
    makeId:()=>[a,b][index++],
    provider:{stream:async(_text,{onFrame})=>{
      await onFrame({seq:0,pcm:pcm(),sampleRate:24000});
    }}
  });
  const x=sessions.start('learner:one','hello');
  const y=sessions.start('learner:two','hello');
  await assert.rejects(()=>sessions.read('learner:two',x.id),
    /UNKNOWN_SPEECH_SESSION/);
  const f=await sessions.read('learner:one',x.id);
  assert.equal(f.seq,0);assert.equal(f.pcm.length,4800);
  const done=await sessions.read('learner:one',x.id);
  assert.equal(done.done,true);
  assert.equal(sessions.activeCount(),1);
  assert.equal(sessions.cancel('learner:two',y.id),true);
  assert.equal(sessions.activeCount(),0);
});
test('R9 cancels queued bytes, revocation blocks read, one turn per child',async()=>{
  let revoked=false;
  const sessions=new OutboundSpeechSessions({
    makeId:()=>a,authorize:()=>{if(revoked)throw Error('PARENT_REVOKED');},
    provider:{stream:async(_text,{onFrame})=>{
      await onFrame({seq:0,pcm:pcm(),sampleRate:24000});
      await new Promise(()=>{});
    }}
  });
  const s=sessions.start('child','hello');
  assert.throws(()=>sessions.start('child','again'),/SPEECH_ALREADY_ACTIVE/);
  await sleep();
  revoked=true;
  await assert.rejects(()=>sessions.read('child',s.id),/PARENT_REVOKED/);
  assert.equal(sessions.cancel('child',s.id),true);
  assert.equal(sessions.activeCount(),0);
});
test('R9 bounded producer fails closed on browser stall',async()=>{
  const sessions=new OutboundSpeechSessions({
    makeId:()=>a,
    provider:{stream:async(_text,{onFrame})=>{
      for(let i=0;i<11;i++)
        await onFrame({seq:i,pcm:pcm(),sampleRate:24000});
    }}
  });
  const s=sessions.start('child','Hello');
  await sleep();
  await assert.rejects(()=>sessions.read('child',s.id),/SPEECH_QUEUE_OVERFLOW/);
  assert.equal(sessions.activeCount(),0);
});
test('R9 end-to-end authorization during every supplier frame',async()=>{
  let allowed=true;
  const sessions=new OutboundSpeechSessions({
    makeId:()=>a,authorize:()=>{if(!allowed)throw Error('PARENT_REVOKED');},
    provider:{stream:async(_text,{onFrame})=>{
      await onFrame({seq:0,pcm:pcm(),sampleRate:24000});
      allowed=false;
      await onFrame({seq:1,pcm:pcm(),sampleRate:24000});
    }}
  });
  const s=sessions.start('child','Hello');
  await sleep();
  allowed=true; // Restore for reading original failed status
  await assert.rejects(()=>sessions.read('child',s.id),/PARENT_REVOKED/);
});
