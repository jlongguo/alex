import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {COMPANION_MODES,opening,offlineReply} from './companion-dialogue.mjs';
import {resolveCourse,exerciseReply} from './skill-curriculum.mjs';

const copy = value => structuredClone(value);
const roleOf = principal => {
  if(principal==='parent')return 'parent';
  if(principal==='child'||/^learner:profile-[0-9a-f-]{36}$/.test(principal??''))return 'child';
  throw new Error('INVALID_COMPANION_PRINCIPAL');
};
const ownedKey = session => session.principal??session.actor; // v1 migration
const validId = id => typeof id==='string' && /^[0-9a-f-]{36}$/.test(id);
const MAX_SESSIONS_PER_PRINCIPAL = 16;
const MAX_TOTAL_SESSIONS = 224; // parent, legacy child, up to 12 named learners
const MAX_MESSAGES = 32;
const MAX_EVIDENCE = 1024;
const MAX_EVIDENCE_PER_PRINCIPAL = 128;
const EVIDENCE_ID=/^[0-9a-f-]{36}:\d+$/;
const validateEvidence = event => {
  if(!event||!EVIDENCE_ID.test(event.id??'')
     ||!validId(event.sessionId)
     ||!['parent','child'].includes(event.actor)
     ||roleOf(event.principal)!==event.actor
     ||!['english_a1_text','story_choice','science_quiz_text'].includes(event.kind)
     ||!Number.isInteger(event.round)||event.round<0||event.round>100000
     ||typeof event.at!=='string'||Number.isNaN(Date.parse(event.at))
     ||!Number.isInteger(event.lessonVersion)||event.lessonVersion<1||event.lessonVersion>10000
     ||!resolveCourse(event.kind==='english_a1_text'?'english':
       event.kind==='story_choice'?'story':'quiz',event.lessonId))
    throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
};
const MAX_USER_CHARS = 500;

// Conversations are separate from the motor/task/control plane. Default
// transcript storage is MEMORY ONLY; explicit opt-in is needed to write disk.
// Only a verified local-auth session may access these APIs in server.mjs.
export class CompanionConversations {
  #sessions=new Map();
  #evidence=[];
  #queue=Promise.resolve();
  constructor({provider=null,persist=false,file='.local/conversations.json',
    authorizeMode=()=>{},authorizeModel=()=>null}={}) {
    this.provider=provider;
    this.authorizeMode=authorizeMode;
    this.authorizeModel=authorizeModel;
    this.persist=Boolean(persist);
    this.store=this.persist?new JsonStateStore(file):null;
  }
  get providerKind(){return this.provider?'compatible':'offline';}
  async load() {
    if(!this.store)return;
    const data=await this.store.load();
    if(!data)return;
    if(data.version!==1||!Array.isArray(data.sessions)||data.sessions.length>MAX_TOTAL_SESSIONS)
      throw new Error('INVALID_CONVERSATION_FILE');
    const next=new Map();
    for(const session of data.sessions) {
      if(!validId(session?.id)||!['parent','child'].includes(session.actor)
        ||(session.principal!==undefined
          &&(roleOf(session.principal)!==session.actor))
        ||!COMPANION_MODES.includes(session.mode)
        ||!(session.lessonId===undefined
          ||(session.mode!=='chat'&&resolveCourse(session.mode,session.lessonId)))
        ||!Number.isInteger(session.step)
        ||session.step<0||session.step>5||typeof session.context!=='string'||session.context.length>50
        ||!(session.round===undefined || (Number.isInteger(session.round)&&session.round>=0&&session.round<=100000))
        ||!(session.milestones===undefined || (Array.isArray(session.milestones)&&session.milestones.length<=40
          &&session.milestones.every(m=>m&&['english_a1_text','story_choice','science_quiz_text'].includes(m.kind)
             &&Number.isInteger(m.round)&&m.round>=0&&typeof m.at==='string')))
        ||!Array.isArray(session.messages)||session.messages.length>MAX_MESSAGES
        ||session.messages.some(m=>!['user','assistant'].includes(m?.role)
          ||typeof m.text!=='string'||m.text.length>1200||typeof m.source!=='string')
        ||next.has(session.id))
        throw new Error('INVALID_CONVERSATION_FILE');
      next.set(session.id,{...copy(session),round:session.round??0,milestones:session.milestones??[]});
    }
    const owners=new Set([...next.values()].map(ownedKey));
    for(const owner of owners)
      if([...next.values()].filter(s=>ownedKey(s)===owner).length>MAX_SESSIONS_PER_PRINCIPAL)
        throw new Error('INVALID_CONVERSATION_FILE');
    // v1 backfill: historical completion records were stored inside the
    // conversation object. Migrate them idempotently without keeping
    // the child's raw answers in this independent ledger.
    if(data.evidence!==undefined&&!Array.isArray(data.evidence))
      throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
    let evidence=Array.isArray(data.evidence)?structuredClone(data.evidence):[];
    if(evidence.length>MAX_EVIDENCE)throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
    const seen=new Set();
    for(const row of evidence){
      validateEvidence(row);
      const session=next.get(row.sessionId);
      // If the source transcript still exists, a ledger entry must keep the
      // same owner/mode/course. Otherwise the snapshot could reattribute
      // another child's completion metadata.
      if(session&&(ownedKey(session)!==row.principal
         ||resolveCourse(session.mode,session.lessonId)?.id!==row.lessonId))
        throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
      if(seen.has(row.id))throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
      seen.add(row.id);
    }
    // Backfill once for pre-R4 snapshots only. New snapshots include a
    // deliberate independent ledger, so retention eviction must not be
    // silently reversed by old session milestone arrays.
    if(data.evidence===undefined){
      for(const session of next.values()){
        const course=resolveCourse(session.mode,session.lessonId);
        if(!course)continue;
        for(const m of session.milestones??[]){
          const id=session.id+':'+m.round;
          if(!seen.has(id)){
            const row={id,sessionId:session.id,actor:session.actor,
              principal:ownedKey(session),lessonId:course.id,
              lessonVersion:1,kind:m.kind,round:m.round,at:m.at};
            validateEvidence(row);
            evidence.push(row);seen.add(id);
          }
        }
      }
      evidence.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
      const counters=new Map(),retained=[];
      for(const event of evidence.slice().reverse()){
        const count=counters.get(event.principal)??0;
        if(count>=MAX_EVIDENCE_PER_PRINCIPAL)continue;
        counters.set(event.principal,count+1);retained.push(event);
      }
      evidence=retained.reverse().slice(-MAX_EVIDENCE);
    }
    if(evidence.length>MAX_EVIDENCE)throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
    for(const owner of new Set(evidence.map(e=>e.principal))){
      if(evidence.filter(e=>e.principal===owner).length>MAX_EVIDENCE_PER_PRINCIPAL)
        throw new Error('INVALID_LEARNING_EVIDENCE_FILE');
    }
    this.#sessions=next;
    this.#evidence=evidence;
  }
  #enqueue(task) {
    const next=this.#queue.catch(()=>{}).then(task);
    this.#queue=next;
    return next;
  }
  async #commit(next,evidence=this.#evidence) {
    // A single atomic snapshot commits transcripts and independent evidence.
    // No split-brain updates across two JSON files.
    if(this.store)await this.store.save({
      version:1,sessions:[...next.values()],evidence});
    this.#sessions=next;
    this.#evidence=evidence;
  }
  #owned(principal,id) {
    roleOf(principal);
    if(!validId(id))throw new Error('INVALID_CONVERSATION_ID');
    const session=this.#sessions.get(id);
    // Return the same response for nonexistent and other-role IDs.
    if(!session||ownedKey(session)!==principal)throw new Error('UNKNOWN_CONVERSATION');
    return session;
  }
  list(principal) {
    roleOf(principal);
    return [...this.#sessions.values()].filter(s=>ownedKey(s)===principal)
      .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
      .map(s=>({id:s.id,mode:s.mode,createdAt:s.createdAt,
                 updatedAt:s.updatedAt,turns:s.messages.filter(m=>m.role==='user').length}));
  }
  get(principal,id) {return copy(this.#owned(principal,id));}
  async open(principal,mode,{lessonId}={}) {
    const actor=roleOf(principal);
    if(!COMPANION_MODES.includes(mode))throw new Error('INVALID_COMPANION_MODE');
    const course=resolveCourse(mode,lessonId);
    return this.#enqueue(async()=>{
      this.authorizeMode(actor,mode);
      if(this.provider)this.authorizeModel(principal);
      const next=new Map(this.#sessions);
      const mine=[...next.values()].filter(s=>ownedKey(s)===principal)
        .sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));
      while(mine.length>=MAX_SESSIONS_PER_PRINCIPAL)next.delete(mine.shift().id);
      const now=new Date().toISOString(),id=randomUUID();
      const session={id,actor,principal,mode,
        ...(course?{lessonId:course.id,lessonVersion:course.version}:{}),
        step:0,context:'',round:0,milestones:[],
        createdAt:now,updatedAt:now,
        messages:[{role:'assistant',text:!this.provider&&course?course.opening:
          opening(mode,Boolean(this.provider)),source:'intro'}]};
      next.set(id,session);
      await this.#commit(next);
      return copy(session);
    });
  }
  async turn(principal,id,text) {
    return this.#processTurn(principal,id,text,{});
  }
  async streamTurn(principal,id,text,{signal,onDelta=()=>{}}={}) {
    if(typeof onDelta!=='function')throw new Error('INVALID_COMPANION_CALLBACK');
    return this.#processTurn(principal,id,text,{signal,onDelta,stream:true});
  }
  async #processTurn(principal,id,text,{signal,onDelta,stream=false}) {
    const actor=roleOf(principal);
    if(typeof text!=='string'||!text.trim()||text.length>MAX_USER_CHARS
      ||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
      throw new Error('INVALID_COMPANION_INPUT');
    return this.#enqueue(async()=>{
      if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
      const current=this.#owned(principal,id);
      this.authorizeMode(actor,current.mode);
      // Parent may revoke cloud access while a session is open. Recheck on
      // every turn, including SSE before any model tokens can leave the host.
      const modelContext=this.provider?this.authorizeModel(principal):null;
      const input=text.trim();
      const user={role:'user',text:input,source:'user'};
      let reply,step=current.step,context=current.context,source='offline';
      if(this.provider) {
        const history=[...current.messages,{role:'user',text:input}];
        if(stream){
          if(typeof this.provider.streamReply!=='function')throw new Error('CHAT_STREAM_UNAVAILABLE');
          reply=await this.provider.streamReply({actor,mode:current.mode,messages:history,
            context:modelContext,signal,onDelta});
        }else reply=await this.provider.reply({actor,mode:current.mode,messages:history,
          context:modelContext,signal});
        source='model';
      }else{
        const course=resolveCourse(current.mode,current.lessonId);
        const response=course&&['english.a1.greetings','english.a1.daily','science.everyday.discovery'].includes(course.id)
          ?exerciseReply(course.id,input,current.step)
          :offlineReply(current.mode,input,current.step,current.context);
        reply=response.text;step=response.step;context=response.context;
        if(stream)await onDelta(reply);
      }
      if(signal?.aborted)throw new Error('COMPANION_TURN_CANCELLED');
      if(typeof reply!=='string'||!reply.trim()||reply.length>1200)
        throw new Error('INVALID_COMPANION_REPLY');
      const assistant={role:'assistant',text:reply.trim(),source};
      const now=new Date().toISOString();
      // Learning evidence is deterministic-only. No LLM can self-assert a
      // completed lesson, and text-only practice isn't voice proficiency.
      const course=resolveCourse(current.mode,current.lessonId);
      const milestoneTarget=course?.targetStep??0;
      const finished=source==='offline'&&milestoneTarget
        &&current.step<milestoneTarget&&step===milestoneTarget;
      const restarted=source==='offline'&&milestoneTarget
        &&current.step===milestoneTarget&&step===0;
      const round=(current.round??0)+(restarted?1:0);
      const milestones=[...(current.milestones??[])];
      if(finished){
        const kind=course.kind;
        if(!milestones.some(m=>m.kind===kind&&m.round===round))
          milestones.push({kind,round,at:now});
      }
      const updated={...current,updatedAt:now,step,context,round,
        milestones:milestones.slice(-40),
        messages:[...current.messages,user,assistant].slice(-MAX_MESSAGES)};
      const next=new Map(this.#sessions);
      next.set(id,updated);
      let evidence=this.#evidence;
      let completedEvent=null;
      if(finished){
        completedEvent={
          id:current.id+':'+round,sessionId:current.id,actor,
          principal,lessonId:course.id,lessonVersion:1,
          kind:course.kind,round,at:now
        };
        validateEvidence(completedEvent);
        if(!evidence.some(e=>e.id===completedEvent.id)){
          evidence=[...evidence,completedEvent];
          // Preserve bounded evidence across automatic session eviction.
          // Session deletion/erasure removes related evidence explicitly.
          const mine=evidence.filter(e=>e.principal===principal);
          if(mine.length>MAX_EVIDENCE_PER_PRINCIPAL){
            const overflow=mine.length-MAX_EVIDENCE_PER_PRINCIPAL;
            const old=new Set(mine.slice(0,overflow).map(e=>e.id));
            evidence=evidence.filter(e=>!old.has(e.id));
          }
          if(evidence.length>MAX_EVIDENCE)
            evidence=evidence.slice(-MAX_EVIDENCE);
        }
      }
      await this.#commit(next,evidence);
      return {id,mode:current.mode,source,assistant:copy(assistant),
              milestone:finished?copy(milestones.at(-1)):null,
              learningEvidence:completedEvent?copy(completedEvent):null,
              session:copy(updated)};
    });
  }
  // Independent evidence survives automatic session rotation, and is erased
  // by explicit delete/erase/learner deletion. Counts are text exercise
  // completions only; never a model-generated grade or voice proficiency.
  progress(principal,scope=principal) {
    const actor=roleOf(principal);
    if(!['parent','child','all'].includes(scope)
      && !/^learner:profile-[0-9a-f-]{36}$/.test(scope??''))
      throw new Error('INVALID_LEARNING_SCOPE');
    if(actor!=='parent'&&scope!==principal)throw new Error('PARENT_REQUIRED');
    const records=this.#evidence.filter(e=>
      scope==='all'||(scope==='child'
        ?(actor==='parent'?e.actor==='child':e.principal==='child')
        :e.principal===scope)
    ).sort((a,b)=>b.at.localeCompare(a.at));
    const byCourse={};
    for(const record of records)
      byCourse[record.lessonId]=(byCourse[record.lessonId]??0)+1;
    return {
      scope,englishTextExercisesCompleted:records.filter(r=>r.kind==='english_a1_text').length,
      storyBranchesCompleted:records.filter(r=>r.kind==='story_choice').length,
      scienceTextQuizzesCompleted:records.filter(r=>r.kind==='science_quiz_text').length,
      byCourse,retentionLimit:MAX_EVIDENCE_PER_PRINCIPAL,
      recent:copy(records.slice(0,50))
    };
  }
  async remove(principal,id) {
    roleOf(principal);
    return this.#enqueue(async()=>{
      this.#owned(principal,id);
      const next=new Map(this.#sessions);next.delete(id);
      await this.#commit(next,this.#evidence.filter(e=>e.sessionId!==id));
      return {ok:true};
    });
  }
  async erase(actor,scope) {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!['parent','child','all'].includes(scope))throw new Error('INVALID_CONVERSATION_ERASE_SCOPE');
    return this.#enqueue(async()=>{
      const next=new Map(this.#sessions);
      let removed=0;
      for(const [id,session] of next) {
        if(scope==='all'||scope===session.actor){next.delete(id);removed++;}
      }
      const evidence=this.#evidence.filter(e=>
        !(scope==='all'||scope===e.actor));
      await this.#commit(next,evidence);
      return removed; // Preserve v1 count semantics; evidence is erased too.
    });
  }
  async eraseLearner(actor,profileId) {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(!/^profile-[0-9a-f-]{36}$/.test(profileId??''))
      throw new Error('INVALID_LEARNER_PROFILE');
    const principal='learner:'+profileId;
    return this.#enqueue(async()=>{
      const next=new Map(this.#sessions);
      let count=0;
      for(const [id,session] of next)
        if(ownedKey(session)===principal){next.delete(id);count++;}
      const evidence=this.#evidence.filter(e=>e.principal!==principal);
      await this.#commit(next,evidence);
      return count;
    });
  }
  // Explicit parent-only /api/privacy/export, never general GET conversations.
  exportForParent(actor) {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return copy([...this.#sessions.values()]);
  }
  exportEvidenceForParent(actor) {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return copy(this.#evidence);
  }
}
