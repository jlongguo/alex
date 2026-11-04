import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';

const COOKIE = 'alex_session';
const MAX_AGE_SECONDS = 8 * 60 * 60;
const SESSION_LIMIT = 128;
function stableSecret(value) { return scryptSync(value, 'alex-v03-comparison', 32); }
function validSecret(input, expected) {
  const supplied = typeof input === 'string' && input.length <= 256 ? input : '';
  return timingSafeEqual(stableSecret(supplied), expected);
}
function parseCookies(req) {
  const value = req.headers.cookie;
  if (typeof value !== 'string' || value.length > 2048) return null;
  const item = value.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE}=`));
  const token = item?.slice(COOKIE.length + 1) ?? null;
  return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
}
export class FamilyAuth {
  constructor({mode='demo',parentPassword,childPin}={}) {
    if (!['demo','local'].includes(mode)) throw new Error('INVALID_AUTH_MODE');
    this.mode = mode;
    if (mode === 'local') {
      if (typeof parentPassword!=='string' || parentPassword.length<12) throw new Error('PARENT_PASSWORD_REQUIRED_MIN_12');
      if (childPin !== undefined && !/^\d{6,12}$/.test(childPin)) throw new Error('INVALID_CHILD_PIN');
      this.parentDigest = stableSecret(parentPassword);
      this.childDigest = childPin === undefined ? null : stableSecret(childPin);
    }
    this.sessions = new Map();
    this.failures = new Map();
  }
  current(req) {
    if (this.mode === 'demo') return {authenticated:true,actor:null,mode:'demo'};
    const token = parseCookies(req);
    const session = token && this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (token) this.sessions.delete(token);
      return {authenticated:false,actor:null,mode:'local'};
    }
    return {...(session.learnerId?{learnerId:session.learnerId}:{}),
      authenticated:true,actor:session.actor,mode:'local'};
  }
  actor(req, claimedActor) {
    const session = this.current(req);
    if (!session.authenticated) throw new Error('UNAUTHENTICATED');
    if (this.mode === 'local') return session.actor; // Untrusted actor supplied by client is ignored.
    if (claimedActor !== 'parent' && claimedActor !== 'child') throw new Error('INVALID_ACTOR');
    return claimedActor;
  }
  login(req,{role,secret,code}={},verifyLearner) {
    if (this.mode !== 'local') throw new Error('AUTH_NOT_ENABLED');
    if (!['parent','child','learner'].includes(role)) throw new Error('INVALID_ROLE');
    if(role==='learner'&&typeof verifyLearner!=='function')
      throw new Error('LEARNER_LOGIN_NOT_CONFIGURED');
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const record = this.failures.get(ip) ?? {count:0,until:0};
    if (record.until > now) throw new Error('TOO_MANY_ATTEMPTS');
    const expected=role==='parent'?this.parentDigest:
      role==='child'?this.childDigest:null;
    const learnerId=role==='learner'?verifyLearner(code,secret):null;
    // Parent/legacy child comparisons remain constant-time. The optional
    // learner verifier runs scrypt even for unknown codes.
    const correct=role==='learner'?!!learnerId:
      validSecret(secret,expected??this.parentDigest);
    if ((role==='learner'&&!learnerId)||(role!=='learner'&&(!expected||!correct))) {
      record.count++;
      if (record.count >= 5) { record.until = now + 5 * 60_000; record.count=0; }
      this.failures.set(ip,record);
      throw new Error('INVALID_CREDENTIALS');
    }
    this.failures.delete(ip);
    if (this.sessions.size >= SESSION_LIMIT) {
      for (const [key,value] of this.sessions) {if(value.expiresAt < now)this.sessions.delete(key);}
      if(this.sessions.size >= SESSION_LIMIT) throw new Error('SESSION_LIMIT_REACHED');
    }
    const token = randomBytes(32).toString('hex');
    const actor=role==='learner'?'child':role;
    this.sessions.set(token,{actor, ...(learnerId?{learnerId}:{}),
      expiresAt:now+MAX_AGE_SECONDS*1000});
    return {actor, ...(learnerId?{learnerId}:{}),cookie:`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`};
  }
  revokeLearner(profileId) {
    let count=0;
    for(const [token,session] of this.sessions)
      if(session.learnerId===profileId){this.sessions.delete(token);count++;}
    return count;
  }
  logout(req) {
    const token = parseCookies(req);
    if(token)this.sessions.delete(token);
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

/** Records command metadata only; no raw voice, user utterance or passwords. */
export class AuditLog {
  constructor(file) {this.file=resolve(file);this.queue=Promise.resolve();}
  async record(entry) {
    const learnerId=typeof entry.learnerId==='string'
      && /^profile-[0-9a-f-]{36}$/.test(entry.learnerId)?entry.learnerId:null;
    const event={timestamp:new Date().toISOString(),actor:entry.actor ?? 'anonymous',
      learnerId,action:String(entry.action).slice(0,100),outcome:entry.outcome,
      requestId:entry.requestId ?? null};
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      await mkdir(dirname(this.file),{recursive:true,mode:0o700});
      await appendFile(this.file,JSON.stringify(event)+'\n',{encoding:'utf8',mode:0o600});
    });
    await this.queue;
    return event;
  }
  async recent(limit=100) {
    await this.queue;
    let raw;
    try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return [];throw e;}
    return raw.trim().split('\n').filter(Boolean).slice(-Math.min(Math.max(1,limit),200)).map(x=>JSON.parse(x));
  }
}
