import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectCompanionSse} from '../scripts/companion-stream.mjs';
import {CompatibleCompanionProvider} from '../scripts/companion-provider.mjs';
import {CompanionConversations} from '../scripts/companion-conversations.mjs';

const encode=new TextEncoder();
const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
const delta=text=>frame({choices:[{delta:{content:text}}]});
const DONE='data: [DONE]\n\n';
function fakeBody(chunks) {
 return new ReadableStream({start(ctrl){
  for(const chunk of chunks)ctrl.enqueue(typeof chunk==='string'?encode.encode(chunk):chunk);
  ctrl.close();
 }});
}
function response(chunks){
 return new Response(fakeBody(chunks),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
}

test('SSE parser survives fragment boundaries and UTF-8 split inside a character',async()=>{
 const bytes=encode.encode(delta('Hello ')+delta('猫咪')+DONE);
 const offset=bytes.indexOf(0xe7);
 assert.ok(offset>0);
 const chunks=[bytes.slice(0,5),bytes.slice(5,17),bytes.slice(17,offset+1),
   bytes.slice(offset+1,offset+2),bytes.slice(offset+2)];
 const updates=[];
 const actual=await collectCompanionSse(fakeBody(chunks),{onDelta:text=>updates.push(text)});
 assert.equal(actual,'Hello 猫咪');
 assert.deepEqual(updates,['Hello ','猫咪']);
});

test('SSE parser rejects truncated, oversized, malformed and tool-calling responses',async()=>{
 const bad=[
  [delta('preview')], // no DONE: cannot accept partial response
  ['data: {"broken_json":\n\n'],
  [frame({choices:[{delta:{tool_calls:[{id:'fake'}]}}]}),DONE],
  [delta('a'.repeat(1201)),DONE],
  [delta('okay'), 'x'.repeat(140000), DONE],
  [DONE], // no assistant text
 ];
 for(const chunks of bad)await assert.rejects(
  collectCompanionSse(fakeBody(chunks)),/CHAT_(STREAM|PROVIDER)/);
});

test('OpenAI-compatible provider requests real streaming tokens with no tools',async()=>{
 let seen;
 const provider=new CompatibleCompanionProvider({
  baseUrl:'https://fake.example/v1',apiKey:'test-secret',model:'test-model',
  fetchFn:async(url,options)=>{
   seen={url:String(url),options,request:JSON.parse(options.body)};
   return response([delta('Hello'),delta('!'),DONE]);
  }
 });
 const preview=[];
 const text=await provider.streamReply({mode:'chat',actor:'child',
  messages:[{role:'user',text:'Hi'}],onDelta:part=>preview.push(part)});
 assert.equal(text,'Hello!');
 assert.deepEqual(preview,['Hello','!']);
 assert.equal(seen.url,'https://fake.example/v1/chat/completions');
 assert.equal(seen.request.stream,true);
 assert.ok(!('tools' in seen.request));
 assert.equal(seen.options.redirect,'error');
 assert.ok(!JSON.stringify(seen.request).includes('test-secret'));
 await assert.rejects(async()=>{
  const nonStream=new CompatibleCompanionProvider({
   baseUrl:'https://fake.example/v1',apiKey:'key',model:'test',
   fetchFn:async()=>new Response('not SSE',{headers:{'Content-Type':'text/plain'}})
  });
  await nonStream.streamReply({mode:'chat',actor:'child',messages:[{role:'user',text:'Hi'}]});
 },/CHAT_STREAM_UNAVAILABLE/);
});

test('cancelled streamed model turn rolls back full user+assistant pair',async()=>{
 const cancel=new AbortController();
 const provider={streamReply:async({onDelta,signal})=>{
  await onDelta('an incomplete draft');
  cancel.abort();
  assert.equal(signal.aborted,true);
  throw new Error('COMPANION_TURN_CANCELLED');
 }};
 const hub=new CompanionConversations({provider});
 const session=await hub.open('child','chat');
 await assert.rejects(async()=>hub.streamTurn('child',session.id,'Hi',{signal:cancel.signal,
  onDelta:part=>assert.equal(part,'an incomplete draft')}),/COMPANION_TURN_CANCELLED/);
 assert.equal(hub.get('child',session.id).messages.length,1);
 assert.equal(hub.get('child',session.id).step,0);
});

test('offline SSE turn commits once and produces only deterministic text evidence',async()=>{
 const service=new CompanionConversations();
 const opened=await service.open('child','english');
 const parts=[];
 const out=await service.streamTurn('child',opened.id,'Sun',{onDelta:value=>parts.push(value)});
 assert.equal(parts.join(''),out.assistant.text);
 assert.equal(out.source,'offline');
 assert.equal(out.session.step,1);
 assert.equal(out.session.messages.length,3);
 assert.equal(out.milestone,null);
});

test('text-only practice milestones are role-scoped, idempotent and erase with conversations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-learning-'));
 const path=join(dir,'sessions.json');
 try {
  const service=new CompanionConversations({persist:true,file:path});
  const english=await service.open('child','english');
  for(const text of ['Sunny','I like apples','I like green','I can sing','I am fine'])
   await service.turn('child',english.id,text);
  assert.equal(service.progress('child').englishTextExercisesCompleted,1);
  assert.equal(service.progress('child').storyBranchesCompleted,0);
  assert.equal(service.progress('parent','child').englishTextExercisesCompleted,1);
  assert.throws(()=>service.progress('child','parent'),/PARENT_REQUIRED/);
  await service.turn('child',english.id,'thanks'); // do not count repeatedly
  assert.equal(service.progress('child').englishTextExercisesCompleted,1);
  await service.turn('child',english.id,'restart');
  for(const text of ['Panda','I like rice','I like yellow','I can play','I am happy'])
   await service.turn('child',english.id,text);
  assert.equal(service.progress('child').englishTextExercisesCompleted,2);
  const story=await service.open('child','story');
  for(const text of ['A','B','A'])await service.turn('child',story.id,text);
  assert.equal(service.progress('child').storyBranchesCompleted,1);
  assert.deepEqual(service.get('child',story.id).milestones.map(x=>x.kind),['story_choice']);
  const loaded=new CompanionConversations({persist:true,file:path});
  await loaded.load();
  assert.equal(loaded.progress('child').englishTextExercisesCompleted,2);
  assert.equal(loaded.progress('parent','child').storyBranchesCompleted,1);
  await loaded.remove('child',english.id);
  assert.equal(loaded.progress('child').englishTextExercisesCompleted,0);
  await loaded.erase('parent','child');
  assert.equal(loaded.progress('parent','child').storyBranchesCompleted,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('model replies never count as certified learning or pronunciation evidence',async()=>{
 const service=new CompanionConversations({provider:{reply:async()=> 'Great! Lesson finished!'}});
 const opened=await service.open('child','english');
 for(let i=0;i<6;i++)await service.turn('child',opened.id,'I like blue');
 assert.equal(service.progress('child').englishTextExercisesCompleted,0);
 assert.equal(service.progress('parent','child').recent.length,0);
});
