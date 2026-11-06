import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DurableSpeechDeliveryBudget} from '../scripts/durable-speech-delivery-budget.mjs';
import {StreamingSpeechSessions} from '../scripts/streaming-speech-sessions.mjs';

const A='learner:a',B='learner:b',id='11111111-1111-4111-8111-111111111111';
function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'alex-r19-ledger-'));
 try{return fn(join(dir,'subdir','speech.json'),dir);}
 finally{rmSync(dir,{recursive:true,force:true});}
}
test('R19 reservations persist across restart and reject overspend',()=>fixture(file=>{
 const clock=()=>Date.UTC(2026,10,6,15,30);
 const budget=new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock});
 for(let i=0;i<10;i++)budget.consume(A,2400);
 const reopened=new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock});
 assert.equal(reopened.snapshot(A).deliveredSamples,24000);
 assert.equal(reopened.snapshot(A).remainingMs,0);
 assert.throws(()=>reopened.consume(A,1),/SPEECH_DAILY_DELIVERY_LIMIT/);
 assert.equal(reopened.snapshot(B).remainingMs,1000);
 assert.equal(reopened.snapshot(A).persistence,'single-process-durable');
 assert.equal(reopened.snapshot(A).measurement,
  'alex-reserved-for-delivery-not-vendor-billed');
 const disk=readFileSync(file,'utf8');
 assert.ok(!disk.includes('audio')&&!disk.includes('transcript'));
 assert.deepEqual(JSON.parse(disk).rows,[['learner:a',20763,24000]]);
}));
test('R19 same-file readers cannot bypass atomic quota through stale state',()=>fixture(file=>{
 const clock=()=>Date.UTC(2026,10,6);
 const first=new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock});
 const second=new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock});
 first.consume(A,14400);
 second.consume(A,9600); // must reload under lock
 assert.throws(()=>first.consume(A,2400),/SPEECH_DAILY_DELIVERY_LIMIT/);
 assert.equal(new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock})
  .snapshot(A).deliveredSamples,24000);
}));
test('R19 stale file lock refuses delivery rather than risking double spend',()=>fixture((file,dir)=>{
 const budget=new DurableSpeechDeliveryBudget({file,dailySeconds:1});
 mkdirSync(join(dir,'subdir','speech.json.lock'),{recursive:true});
 assert.throws(()=>budget.consume(A,2400),/SPEECH_LEDGER_BUSY/);
 assert.equal(budget.snapshot(A).deliveredSamples,0);
}));
test('R19 corrupt persisted data fails startup closed',()=>fixture(file=>{
 mkdirSync(dirname(file),{recursive:true});
 writeFileSync(file,'{"version":1,"rows":[["learner:a",1,-5]]}');
 assert.throws(()=>new DurableSpeechDeliveryBudget({file}),
  /SPEECH_LEDGER_INVALID_FILE/);
}));
test('R19 UTC day rollover resets allowance and survives a restart',()=>fixture(file=>{
 let now=Date.UTC(2026,10,6,23,59,59);
 const clock=()=>now;
 const budget=new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock});
 for(let i=0;i<10;i++)budget.consume(A,2400);
 assert.equal(budget.snapshot(A).remainingSamples,0);
 now+=2000;
 const restarted=new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock});
 assert.equal(restarted.snapshot(A).deliveredSamples,0);
 restarted.consume(A,2400);
 assert.equal(restarted.snapshot(A).deliveredSamples,2400);
 assert.equal(new DurableSpeechDeliveryBudget({file,dailySeconds:1,now:clock})
   .snapshot(A).deliveredSamples,2400);
}));
test('R19 parent erase does not clear learner accounting; learner erase is durable',()=>fixture(file=>{
 const b=new DurableSpeechDeliveryBudget({file,dailySeconds:1});
 b.consume(A,2400);b.consume(B,2400);b.consume('parent',2400);
 assert.equal(b.eraseScope('parent'),1);
 assert.equal(b.snapshot(A).deliveredSamples,2400);
 assert.equal(b.erasePrincipal(A),true);
 const after=new DurableSpeechDeliveryBudget({file,dailySeconds:1});
 assert.equal(after.snapshot(A).deliveredSamples,0);
 assert.equal(after.snapshot(B).deliveredSamples,2400);
 assert.equal(after.snapshot('parent').deliveredSamples,0);
 assert.equal(after.eraseScope('child'),1);
 assert.equal(new DurableSpeechDeliveryBudget({file,dailySeconds:1})
   .snapshot(B).deliveredSamples,0);
}));
test('R19 provider delivery reserves before returning PCM, and fail-closed lock prevents bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alex-r19-stream-'));
 const file=join(dir,'speech.json');
 try{
  const budget=new DurableSpeechDeliveryBudget({file,dailySeconds:1});
  const provider={open:async()=>({async read(){return {
   done:false,pcm:Buffer.alloc(4800,23),samples:2400
  };},async close(){}})};
  const manager=new StreamingSpeechSessions({provider,budget,makeId:()=>id});
  const s=await manager.start(A,{text:'hello'});
  const first=await manager.next(A,s.id,0);
  assert.equal(first.pcm.length,4800);
  assert.equal(budget.snapshot(A).deliveredSamples,2400);
  manager.ack(A,s.id,0);
  mkdirSync(file+'.lock');
  await assert.rejects(manager.next(A,s.id,1),/SPEECH_LEDGER_BUSY/);
  assert.equal(manager.activeCount(),0);
  assert.equal(new DurableSpeechDeliveryBudget({file,dailySeconds:1})
   .snapshot(A).deliveredSamples,2400);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
