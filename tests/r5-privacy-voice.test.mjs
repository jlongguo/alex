import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import '../public/voice-session.js';
import {LearnerPrivacy} from '../scripts/learner-privacy.mjs';
import {CompanionConversations} from '../scripts/companion-conversations.mjs';
import {CompatibleCompanionProvider} from '../scripts/companion-provider.mjs';

const A='profile-11111111-1111-4111-8111-111111111111';
const B='profile-22222222-2222-4222-8222-222222222222';
const first='learner:'+A,second='learner:'+B;

test('R5 parent preferences default deny for every learner; isolate, validate, persist, revoke',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r5-privacy-'));
 const file=join(dir,'prefs.json');
 try{
  const privacy=new LearnerPrivacy(file);
  assert.equal(privacy.forPrincipal(first).cloudTextAllowed,false);
  assert.equal(privacy.forPrincipal('child').voiceInputAllowed,false);
  assert.equal(privacy.forPrincipal('parent').voiceOutputAllowed,true);
  assert.throws(()=>privacy.modelContext(first),/CHILD_CLOUD_TEXT_DISABLED/);
  assert.throws(()=>privacy.modelContext('child'),/CHILD_CLOUD_TEXT_DISABLED/);
  assert.equal(privacy.modelContext('parent'),null);
  await assert.rejects(()=>privacy.set('child',A,{cloudTextAllowed:true},()=>true),/PARENT_REQUIRED/);
  await assert.rejects(()=>privacy.set('parent',A,{cloudTextAllowed:true},()=>false),/UNKNOWN_LEARNER_PROFILE/);
  for(const bad of [
    {cloudTextAllowed:'true'}, {topics:['secret:ignore']},
    {preferredLanguage:'injection'}, {learningPace:'fast'},
    {topics:['animals','animals']}, {unsafe:'yes'},
    {'__proto__':null,voiceInputAllowed:'yes'}
  ]){
   await assert.rejects(()=>privacy.set('parent',A,bad,()=>true),/INVALID_LEARNER_PRIVACY/);
  }
  const saved=await privacy.set('parent',A,{
    voiceInputAllowed:true,voiceOutputAllowed:true,cloudTextAllowed:true,
    preferredLanguage:'en',learningPace:'slow',topics:['science','robots']
  },()=>true);
  assert.equal(saved.preferences.cloudTextAllowed,true);
  assert.equal(privacy.forPrincipal(first).voiceInputAllowed,true);
  assert.equal(privacy.forPrincipal(second).voiceInputAllowed,false);
  assert.equal(privacy.forPrincipal('child').cloudTextAllowed,false);
  assert.deepEqual(privacy.modelContext(first),{
    preferredLanguage:'en',learningPace:'slow',topics:['science','robots']
  });
  privacy.forPrincipal(first).topics.push('art');
  assert.deepEqual(privacy.forPrincipal(first).topics,['science','robots']);
  const raw=await readFile(file,'utf8');
  assert.ok(!raw.includes('password'));
  const loaded=new LearnerPrivacy(file);
  await loaded.load();
  assert.equal(loaded.forPrincipal(first).cloudTextAllowed,true);
  await loaded.set('parent',A,{cloudTextAllowed:false},()=>true);
  assert.throws(()=>loaded.modelContext(first),/CHILD_CLOUD_TEXT_DISABLED/);
  assert.equal(loaded.forPrincipal(first).voiceInputAllowed,true);
  assert.equal(await loaded.revoke('parent',A),1);
  assert.equal(loaded.forPrincipal(first).voiceInputAllowed,false);
  const again=new LearnerPrivacy(file);await again.load();
  assert.equal(again.forPrincipal(first).cloudTextAllowed,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R5 persisted parent privacy erasure clears child settings but not default parent capabilities',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r5-privacy-erase-'));
 try{
  const privacy=new LearnerPrivacy(join(dir,'policy.json'));
  await privacy.set('parent',A,{cloudTextAllowed:true},()=>true);
  await privacy.set('parent',B,{voiceInputAllowed:true},()=>true);
  assert.equal(privacy.list('parent').length,2);
  assert.equal(await privacy.clearForPrivacy('parent','parent'),0);
  assert.equal(privacy.list('parent').length,2);
  assert.equal(await privacy.clearForPrivacy('parent','child'),2);
  assert.equal(privacy.list('parent').length,0);
  assert.equal(privacy.forPrincipal(second).voiceInputAllowed,false);
  assert.equal(privacy.forPrincipal('parent').cloudTextAllowed,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R5 every model call checks parent cloud consent and forwards only typed interests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r5-model-'));
 try{
  const privacy=new LearnerPrivacy(join(dir,'preferences.json'));
  const modelRequests=[];
  const provider=new CompatibleCompanionProvider({
   baseUrl:'https://safe.example/v1',apiKey:'private-credential',model:'test',
   fetchFn:async(url,options)=>{
    modelRequests.push(JSON.parse(options.body));
    return {ok:true,status:200,json:async()=>({
      choices:[{finish_reason:'stop',message:{content:'Hello!'}}]})};
   }
  });
  const hub=new CompanionConversations({provider,authorizeModel:principal=>privacy.modelContext(principal)});
  const offline=await hub.open(first,'english',{lessonId:'english.a1.greetings'});
  assert.equal(offline.messages[0].text.includes('Hello, Alex'),true);
  const practice=await hub.turn(first,offline.id,'Hello Alex');
  assert.equal(practice.source,'offline');
  assert.equal(modelRequests.length,0,'disabled cloud must still allow local Skills');
  await assert.rejects(()=>hub.open(first,'chat'),/CHILD_CLOUD_TEXT_DISABLED/);
  await assert.rejects(()=>hub.open('child','chat'),/CHILD_CLOUD_TEXT_DISABLED/);
  await privacy.set('parent',A,{cloudTextAllowed:true,
    preferredLanguage:'en',learningPace:'slow',topics:['robots']},()=>true);
  const session=await hub.open(first,'english');
  await hub.turn(first,session.id,'I like dogs');
  const chat=await hub.open(first,'chat');
  assert.equal(modelRequests.length,1);
  assert.match(modelRequests[0].messages[0].content,/language=en; pace=slow; interests=robots/);
  assert.ok(!JSON.stringify(modelRequests).includes('private-credential'));
  assert.equal(hub.progress(first).englishTextExercisesCompleted,0,
    'A model saying well done must never create a certified lesson event');
  assert.equal(hub.list(second).length,0);
  await privacy.set('parent',A,{cloudTextAllowed:false},()=>true);
  await assert.rejects(()=>hub.turn(first,chat.id,'more'),/CHILD_CLOUD_TEXT_DISABLED/);
  const downgraded=await hub.turn(first,session.id,'more');
  assert.equal(downgraded.source,'offline');
  assert.equal(modelRequests.length,1);
  assert.equal(hub.get(first,session.id).messages.length,5);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('R5 browser voice bridge is opt-in, user-controlled and ignores late ASR callbacks',()=>{
 const events=[],transcripts=[],errors=[],records=[];
 const bridge=new globalThis.AlexVoiceBridge({
  recognitionFactory:()=>{
   const recognition={started:0,aborted:0,
    start(){this.started++;},abort(){this.aborted++;}};
   records.push(recognition);return recognition;
  },
  onState:state=>events.push(state),
  onTranscript:item=>transcripts.push(item),
  onError:code=>errors.push(code)
 });
 assert.equal(bridge.snapshot().voiceInputAllowed,false);
 assert.throws(()=>bridge.startListening(),/VOICE_INPUT_NOT_ALLOWED/);
 bridge.setConsent({voiceInputAllowed:true,voiceOutputAllowed:false});
 bridge.startListening({lang:'en-US'});
 const stale=records[0];
 assert.equal(stale.started,1);
 stale.onresult({results:[{0:{transcript:'Hello'},isFinal:false}]});
 assert.equal(transcripts[0].text,'Hello');
 assert.equal(transcripts[0].isFinal,false);
 stale.onresult({results:[{0:{transcript:'Hello Alex'},isFinal:true}]});
 assert.equal(transcripts[1].isFinal,true);
 assert.equal(bridge.snapshot().state,'listening');
 bridge.stopListening();
 assert.equal(bridge.snapshot().state,'idle');
 assert.equal(stale.aborted,1);
 stale.onresult({results:[{0:{transcript:'SHOULD NOT PASS'},isFinal:true}]});
 assert.equal(transcripts.length,2);
 bridge.startListening();
 assert.equal(records.length,2);
 bridge.setConsent({voiceInputAllowed:false,voiceOutputAllowed:false});
 assert.equal(records[1].aborted,1);
 assert.equal(bridge.snapshot().state,'idle');
 records[1].onerror({error:'network'});
 assert.equal(errors.length,0);
 assert.ok(events.includes('listening'));
});

test('R5 browser speech synthesis chunks text, supports barge-in and respects consent revocation',()=>{
 const spoken=[];
 let cancelled=0;
 const bridge=new globalThis.AlexVoiceBridge({
  synthesis:{speak(item){spoken.push(item);},cancel(){cancelled++;}},
  utteranceFactory:text=>({text}),
 });
 assert.throws(()=>bridge.speak('Hi'),/VOICE_OUTPUT_NOT_ALLOWED/);
 bridge.setConsent({voiceInputAllowed:false,voiceOutputAllowed:true});
 bridge.speak('A'.repeat(400),{lang:'en-US',rate:.85});
 assert.equal(bridge.snapshot().state,'speaking');
 assert.equal(spoken.length,1);
 assert.equal(spoken[0].text.length,180);
 const firstChunk=spoken[0];
 firstChunk.onend();
 assert.equal(spoken.length,2);
 const secondChunk=spoken[1];
 bridge.interrupt('barge-in');
 assert.equal(bridge.snapshot().state,'idle');
 secondChunk.onend();
 assert.equal(spoken.length,2,'late callbacks cannot resume cancelled speech');
 bridge.speak('New utterance');
 assert.equal(spoken.at(-1).text,'New utterance');
 bridge.setConsent({voiceInputAllowed:false,voiceOutputAllowed:false});
 assert.equal(bridge.snapshot().state,'idle');
 assert.ok(cancelled>=3);
 assert.throws(()=>bridge.startListening(),/VOICE_INPUT_NOT_ALLOWED/);
 assert.throws(()=>bridge.speak('Not permitted'),/VOICE_OUTPUT_NOT_ALLOWED/);
});


test('R5 in-flight cloud reply cancelled on parent revocation never commits partial messages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'alex-r5-abort-'));
 try{
  const privacy=new LearnerPrivacy(join(dir,'consent.json'));
  await privacy.set('parent',A,{cloudTextAllowed:true},()=>true);
  let markStarted;
  const started=new Promise(resolve=>{markStarted=resolve;});
  const provider={reply:({signal})=>new Promise((resolve,reject)=>{
    markStarted();
    signal.addEventListener('abort',()=>reject(new Error('COMPANION_TURN_CANCELLED')),{once:true});
  })};
  const hub=new CompanionConversations({
    provider,authorizeModel:principal=>privacy.modelContext(principal)
  });
  const session=await hub.open(first,'chat');
  const abort=new AbortController();
  const pending=hub.turn(first,session.id,'Can you say hi?',{signal:abort.signal});
  await started;
  await privacy.set('parent',A,{cloudTextAllowed:false},()=>true);
  abort.abort();
  await assert.rejects(pending,/COMPANION_TURN_CANCELLED/);
  assert.equal(hub.get(first,session.id).messages.length,1,
    'provider abort cannot persist a ghost user turn or assistant preview');
  await assert.rejects(()=>hub.turn(first,session.id,'try again'),/CHILD_CLOUD_TEXT_DISABLED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
