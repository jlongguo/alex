import {randomUUID} from 'node:crypto';
import {JsonStateStore} from './state-store.mjs';
import {COMPANION_MODES,opening,offlineReply} from './companion-dialogue.mjs';

const copy = value => structuredClone(value);
const validActor = actor => {
  if(!['parent','child'].includes(actor))throw new Error('INVALID_ACTOR');
};
const validId = id => typeof id==='string' && /^[0-9a-f-]{36}$/.test(id);
const MAX_SESSIONS_PER_ROLE = 16;
const MAX_MESSAGES = 32;
const MAX_USER_CHARS = 500;

// Conversations are separate from the motor/task/control plane. Default
// transcript storage is MEMORY ONLY; explicit opt-in is needed to write disk.
// Only a verified local-auth session may access these APIs in server.mjs.
export class CompanionConversations {
  #sessions=new Map();
  #queue=Promise.resolve();
  constructor({provider=null,persist=false,file='.local/conversations.json'}={}) {
    this.provider=provider;
    this.persist=Boolean(persist);
    this.store=this.persist?new JsonStateStore(file):null;
  }
  get providerKind(){return this.provider?'compatible':'offline';}
  async load() {
    if(!this.store)return;
    const data=await this.store.load();
    if(!data)return;
    if(data.version!==1||!Array.isArray(data.sessions)||data.sessions.length>2*MAX_SESSIONS_PER_ROLE)
      throw new Error('INVALID_CONVERSATION_FILE');
    const next=new Map();
    for(const session of data.sessions) {
      if(!validId(session?.id)||!['parent','child'].includes(session.actor)
        ||!COMPANION_MODES.includes(session.mode)||!Number.isInteger(session.step)
        ||session.step<0||session.step>5||typeof session.context!=='string'||session.context.length>50
        ||!Array.isArray(session.messages)||session.messages.length>MAX_MESSAGES
        ||session.messages.some(m=>!['user','assistant'].includes(m?.role)
          ||typeof m.text!=='string'||m.text.length>1200||typeof m.source!=='string')
        ||next.has(session.id))
        throw new Error('INVALID_CONVERSATION_FILE');
      next.set(session.id,copy(session));
    }
    for(const role of ['parent','child']) {
      if([...next.values()].filter(s=>s.actor===role).length>MAX_SESSIONS_PER_ROLE)
        throw new Error('INVALID_CONVERSATION_FILE');
    }
    this.#sessions=next;
  }
  #enqueue(task) {
    const next=this.#queue.catch(()=>{}).then(task);
    this.#queue=next;
    return next;
  }
  async #commit(next) {
    if(this.store)await this.store.save({version:1,sessions:[...next.values()]});
    this.#sessions=next;
  }
  #owned(actor,id) {
    validActor(actor);
    if(!validId(id))throw new Error('INVALID_CONVERSATION_ID');
    const session=this.#sessions.get(id);
    // Return the same response for nonexistent and other-role IDs.
    if(!session||session.actor!==actor)throw new Error('UNKNOWN_CONVERSATION');
    return session;
  }
  list(actor) {
    validActor(actor);
    return [...this.#sessions.values()].filter(s=>s.actor===actor)
      .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
      .map(s=>({id:s.id,mode:s.mode,createdAt:s.createdAt,
                 updatedAt:s.updatedAt,turns:s.messages.filter(m=>m.role==='user').length}));
  }
  get(actor,id) {return copy(this.#owned(actor,id));}
  async open(actor,mode) {
    validActor(actor);
    if(!COMPANION_MODES.includes(mode))throw new Error('INVALID_COMPANION_MODE');
    return this.#enqueue(async()=>{
      const next=new Map(this.#sessions);
      const mine=[...next.values()].filter(s=>s.actor===actor)
        .sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));
      while(mine.length>=MAX_SESSIONS_PER_ROLE)next.delete(mine.shift().id);
      const now=new Date().toISOString(),id=randomUUID();
      const session={id,actor,mode,step:0,context:'',createdAt:now,updatedAt:now,
        messages:[{role:'assistant',text:opening(mode,Boolean(this.provider)),source:'intro'}]};
      next.set(id,session);
      await this.#commit(next);
      return copy(session);
    });
  }
  async turn(actor,id,text) {
    validActor(actor);
    if(typeof text!=='string'||!text.trim()||text.length>MAX_USER_CHARS
      ||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
      throw new Error('INVALID_COMPANION_INPUT');
    return this.#enqueue(async()=>{
      const current=this.#owned(actor,id);
      const input=text.trim();
      const user={role:'user',text:input,source:'user'};
      let reply, step=current.step, context=current.context, source='offline';
      if(this.provider) {
        const history=[...current.messages,{role:'user',text:input}];
        reply=await this.provider.reply({actor,mode:current.mode,messages:history});
        source='model';
      } else {
        const response=offlineReply(current.mode,input,current.step,current.context);
        reply=response.text;step=response.step;context=response.context;
      }
      if(typeof reply!=='string'||!reply.trim()||reply.length>1200)
        throw new Error('INVALID_COMPANION_REPLY');
      const assistant={role:'assistant',text:reply.trim(),source};
      const now=new Date().toISOString();
      const updated={...current,updatedAt:now,step,context,
        messages:[...current.messages,user,assistant].slice(-MAX_MESSAGES)};
      const next=new Map(this.#sessions);
      next.set(id,updated);
      await this.#commit(next);
      return {id,mode:current.mode,source,assistant:copy(assistant),session:copy(updated)};
    });
  }
  async remove(actor,id) {
    validActor(actor);
    return this.#enqueue(async()=>{
      this.#owned(actor,id);
      const next=new Map(this.#sessions);next.delete(id);
      await this.#commit(next);
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
      await this.#commit(next);
      return removed;
    });
  }
  // Explicit parent-only /api/privacy/export, never general GET conversations.
  exportForParent(actor) {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    return copy([...this.#sessions.values()]);
  }
}
