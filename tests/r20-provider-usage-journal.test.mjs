import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderUsageJournal,MeteredStreamingSpeechProvider} from '../scripts/provider-usage-journal.mjs';

async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'alex-r20-usage-'));
 mkdirSync(join(dir,'nested'),{recursive:true});
 try{return await fn(join(dir,'nested','usage.jsonl'),dir);}
 finally{rmSync(dir,{recursive:true,force:true});}
}
const uuid=()=> '11111111-1111-4111-8111-111111111111';
test('R20 journal reconstructs provider bytes, outcomes and inflight after restart',()=>fixture(file=>{
 let now=1000,n=0;const clock=()=>now;
 const journal=new ProviderUsageJournal({file,now:clock,
  makeId:()=> '11111111-1111-4111-8111-11111111111'+(++n)});
 const id=journal.begin({provider:'compatible-pcm-stream',model:'voice-v1'});
 now++;journal.frame(id,4800);now++;
 journal.begin({provider:'compatible-pcm-stream',model:'voice-v1'});
 now++;journal.finish(id,'completed');
 const restarted=new ProviderUsageJournal({file,now:clock,makeId:uuid});
 const summary=restarted.summary();
 assert.deepEqual({requests:summary.requests,completed:summary.completed,
  inflight:summary.inflight,responseBytes:summary.responseBytes,
  responseSamples:summary.responseSamples,frames:summary.frames},
  {requests:2,completed:1,inflight:1,responseBytes:4800,
   responseSamples:2400,frames:1});
 assert.equal(summary.measurement,'provider-response-pcm-not-invoice');
 assert.equal(summary.providers[0].provider,'compatible-pcm-stream');
 const raw=readFileSync(file,'utf8');
 assert.ok(!raw.includes('transcript')&&!raw.includes('secret'));
 assert.ok(!raw.includes('hello')&&!raw.includes('audio text'));
}));
test('R20 failed and cancelled upstream requests remain distinct',()=>fixture(file=>{
 let now=10,n=0;const j=new ProviderUsageJournal({file,now:()=>now++,
  makeId:()=> '00000000-0000-4000-8000-00000000000'+(++n)});
 const failed=j.begin({provider:'p',model:'m'});j.frame(failed,2);
 j.finish(failed,'failed','SPEECH_PROVIDER_HTTP_503');
 const cancelled=j.begin({provider:'p',model:'m'});j.finish(cancelled,'cancelled');
 const summary=j.summary();
 assert.equal(summary.failed,1);assert.equal(summary.cancelled,1);
 assert.equal(summary.completed,0);assert.equal(summary.responseBytes,2);
}));
test('R20 finish is idempotent and cannot change a completed outcome',()=>fixture(file=>{
 const j=new ProviderUsageJournal({file,makeId:uuid});
 const id=j.begin({provider:'p',model:'m'});
 assert.equal(j.finish(id,'completed'),true);
 assert.equal(j.finish(id,'failed','ERR'),false);
 assert.equal(j.summary().completed,1);assert.equal(j.summary().failed,0);
}));
test('R20 corrupt journal fails startup closed',()=>fixture((file)=>{
 writeFileSync(file,'{"version":1,"id":"bad","event":"open","at":1}\n');
 assert.throws(()=>new ProviderUsageJournal({file}),
  /PROVIDER_USAGE_JOURNAL_INVALID/);
}));
test('R20 metered provider records upstream PCM frames and completed lifecycle',async()=>fixture(async file=>{
 const journal=new ProviderUsageJournal({file,makeId:uuid});
 let read=0,closed=0;
 const provider={kind:'fixture-provider',model:'fixture-model',open:async()=>({
  async read(){return read++===0?{done:false,pcm:Buffer.alloc(4800),samples:2400}:{done:true};},
  async close(){closed++;}
 })};
 const metered=new MeteredStreamingSpeechProvider({provider,journal});
 const source=await metered.open({text:'DO NOT STORE THIS'});
 const block=await source.read();assert.equal(block.pcm.length,4800);
 assert.equal((await source.read()).done,true);
 await source.close();
 assert.equal(closed,1);
 const summary=new ProviderUsageJournal({file}).summary();
 assert.equal(summary.completed,1);assert.equal(summary.responseBytes,4800);
 assert.equal(summary.responseSamples,2400);
 assert.ok(!readFileSync(file,'utf8').includes('DO NOT STORE THIS'));
}));
test('R20 provider open failures are journaled without exposing provider error text',async()=>fixture(async file=>{
 const journal=new ProviderUsageJournal({file,makeId:uuid});
 const provider={kind:'p',model:'m',open:async()=>{throw Error('private provider response secret');}};
 const metered=new MeteredStreamingSpeechProvider({provider,journal});
 await assert.rejects(metered.open({text:'private input'}));
 const summary=new ProviderUsageJournal({file}).summary();
 assert.equal(summary.failed,1);assert.equal(summary.inflight,0);
 const raw=readFileSync(file,'utf8');
 assert.ok(!raw.includes('private provider response secret'));
 assert.ok(!raw.includes('private input'));
}));
test('R20 invalid transitions are rejected before corrupting the append-only file',()=>fixture(file=>{
 const j=new ProviderUsageJournal({file,makeId:uuid});
 assert.throws(()=>j.frame(uuid(),4800),/PROVIDER_USAGE_JOURNAL_INVALID/);
 const id=j.begin({provider:'p',model:'m'});
 j.finish(id,'completed');
 const before=readFileSync(file,'utf8');
 assert.throws(()=>j.frame(id,4800),/PROVIDER_USAGE_JOURNAL_INVALID/);
 assert.equal(readFileSync(file,'utf8'),before);
 assert.equal(new ProviderUsageJournal({file}).summary().completed,1);
}));
test('R20 invalid frame sizes are rejected before append',()=>fixture(file=>{
 const j=new ProviderUsageJournal({file,makeId:uuid});
 const id=j.begin({provider:'p',model:'m'});
 assert.throws(()=>j.frame(id,1),/INVALID_PROVIDER_USAGE_FRAME/);
 assert.equal(j.summary().responseBytes,0);
}));
