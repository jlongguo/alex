import {createHash} from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeCore,CompatibleAgentProvider,RuleAgentProvider,validateProposal } from '../dist/index.js';
import {JsonStateStore} from './state-store.mjs';
import {FamilyAuth,AuditLog} from './family-security.mjs';
import {FamilyMemory} from './family-memory.mjs';
import {DeviceRegistry} from './device-registry.mjs';
import {FamilyProfiles} from './family-profiles.mjs';
import {LearnerCredentials} from './learner-credentials.mjs';
import {DeviceGateway} from './device-gateway.mjs';
import {MAP} from '../dist/robot/map.js';
import {WorkflowOrchestrator,WORKFLOW_RECIPES,parseWorkflowCommand} from './workflow-orchestrator.mjs';
import {PlanOrchestrator} from './plan-orchestrator.mjs';
import {ExecutionTraceProjector} from './execution-trace-projector.mjs';
import {SkillGovernance} from './skill-governance.mjs';
import {SkillPackageRegistry} from './skill-package-registry.mjs';
import {SkillPackageTrust} from './skill-package-trust.mjs';
import {projectSkillUsage} from './skill-usage-audit.mjs';
import {PlanProposals,RulePlanProvider,CompatiblePlanProvider} from './plan-proposals.mjs';
import {CompanionConversations} from './companion-conversations.mjs';
import {CompatibleCompanionProvider} from './companion-provider.mjs';
import {courseCatalog,resolveCourse} from './skill-curriculum.mjs';
import {LearningPlans} from './learning-plans.mjs';
import {LearnerPrivacy} from './learner-privacy.mjs';
import {CompatibleAudioProvider,MAX_AUDIO_UPLOAD_BYTES,MAX_AUDIO_MS} from './audio-provider.mjs';
import {AudioTurnGate,readAudioUpload} from './audio-transport.mjs';
import {AudioIngressSessions,readAudioChunk} from './audio-ingress-sessions.mjs';
import {RealtimeTranscriptionProvider} from './realtime-transcription-provider.mjs';
import {RealtimePcmSessions,readRealtimePcmFrame} from './realtime-pcm-sessions.mjs';
import {StreamingPcmSpeechProvider} from './streaming-speech-provider.mjs';
import {StreamingSpeechSessions} from './streaming-speech-sessions.mjs';
import {SegmentedPcmSpeechProvider} from './segmented-pcm-speech-provider.mjs';
import {VoiceTurnOrchestrator} from './voice-turn-orchestrator.mjs';
import {SpeechDeliveryBudget} from './speech-delivery-budget.mjs';
import {DurableSpeechDeliveryBudget} from './durable-speech-delivery-budget.mjs';
import {ProviderUsageJournal,MeteredStreamingSpeechProvider} from './provider-usage-journal.mjs';
import {ProviderBillingStatementStore,ProviderBillingReconciler} from './provider-billing-reconciliation.mjs';
import {ProviderBillingCsvImporter} from './provider-billing-csv-importer.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(appDir, 'public');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '4317');
if (!['127.0.0.1','::1','localhost'].includes(host)) throw new Error('LOOPBACK_HOST_ONLY');
const auth=new FamilyAuth({mode:process.env.AUTH_MODE??'demo',parentPassword:process.env.ALEX_PARENT_PASSWORD,childPin:process.env.ALEX_CHILD_PIN});
if(auth.mode==='demo')console.warn('INSECURE DEMO MODE: no authentication; loopback access only. Set AUTH_MODE=local for family use.');
const audit=new AuditLog(process.env.AUDIT_FILE??resolve(appDir,'.local','audit.jsonl'));
const memory=new FamilyMemory(process.env.MEMORY_FILE??resolve(appDir,'.local','memory.json'));
const devices=new DeviceRegistry(process.env.DEVICES_FILE??resolve(appDir,'.local','devices.json'));
const profiles=new FamilyProfiles(process.env.PROFILES_FILE??resolve(appDir,'.local','profiles.json'));
const learnerCredentials=new LearnerCredentials(
  process.env.LEARNER_CREDENTIALS_FILE??resolve(appDir,'.local','learner-credentials.json'));
const learnerPrivacy=new LearnerPrivacy(
  process.env.ALEX_LEARNER_PRIVACY_FILE??resolve(appDir,'.local','learner-privacy.json'));
const audioGate=new AudioTurnGate();
const audioIngress=new AudioIngressSessions();
const audioMode=process.env.ALEX_AUDIO_PROVIDER??'disabled';
if(!['disabled','compatible'].includes(audioMode))throw new Error('INVALID_AUDIO_PROVIDER_MODE');
const audioProvider=audioMode==='compatible'?new CompatibleAudioProvider({
  baseUrl:process.env.ALEX_AUDIO_BASE_URL,apiKey:process.env.ALEX_AUDIO_API_KEY,
  transcriptionModel:process.env.ALEX_AUDIO_ASR_MODEL,
  speechModel:process.env.ALEX_AUDIO_TTS_MODEL,
  voice:process.env.ALEX_AUDIO_VOICE??'alloy'
}):null;
// Real upstream PCM16/24k WSS transcription is an independent opt-in
// provider. The R6/R7 batch provider remains the default/fallback.
const realtimeMode=process.env.ALEX_REALTIME_PROVIDER??'disabled';
if(!['disabled','openai-transcription'].includes(realtimeMode))
  throw new Error('INVALID_REALTIME_PROVIDER_MODE');
const realtimeProvider=realtimeMode==='openai-transcription'
  ?new RealtimeTranscriptionProvider({
    url:process.env.ALEX_REALTIME_URL??'wss://api.openai.com/v1/realtime?intent=transcription',
    apiKey:process.env.ALEX_REALTIME_API_KEY,
    model:process.env.ALEX_REALTIME_ASR_MODEL??'gpt-live-transcribe'
  }):null;
const realtimeSessions=realtimeProvider
  ?new RealtimePcmSessions({provider:realtimeProvider}):null;
const speechStreamMode=process.env.ALEX_SPEECH_STREAM_PROVIDER??'disabled';
if(!['disabled','compatible'].includes(speechStreamMode))
 throw Error('INVALID_SPEECH_STREAM_MODE');
const speechStreamProvider=speechStreamMode==='compatible'
 ?new StreamingPcmSpeechProvider({
  baseUrl:process.env.ALEX_SPEECH_STREAM_BASE_URL,
  apiKey:process.env.ALEX_SPEECH_STREAM_API_KEY,
  model:process.env.ALEX_SPEECH_STREAM_MODEL,
  voice:process.env.ALEX_SPEECH_STREAM_VOICE??'alloy'
 }):null;
// This is a local delivered-audio allowance, NOT a cloud invoice ceiling.
const speechDeliveryDailySeconds=Number(
  process.env.ALEX_SPEECH_DAILY_DELIVERY_SECONDS??120);
// Supplier response usage is an independent, opt-in operational journal.
// It stores request IDs, model, byte counts and outcome; never text/audio/keys.
const providerUsageFile=process.env.ALEX_SPEECH_PROVIDER_USAGE_FILE;
const providerUsageJournal=providerUsageFile
 ?new ProviderUsageJournal({file:providerUsageFile}):null;
const providerBillingFile=process.env.ALEX_SPEECH_PROVIDER_BILLING_FILE;
const providerBillingStore=providerBillingFile
 ?new ProviderBillingStatementStore({file:providerBillingFile}):null;
const providerBillingReconciler=providerBillingStore&&providerUsageJournal
 ?new ProviderBillingReconciler({statements:providerBillingStore,
   journal:providerUsageJournal}):null;
const providerBillingCsvImporter=providerBillingStore
 ?new ProviderBillingCsvImporter({store:providerBillingStore}):null;
const meteredSpeechStreamProvider=providerUsageJournal&&speechStreamProvider
 ?new MeteredStreamingSpeechProvider({provider:speechStreamProvider,
   journal:providerUsageJournal}):speechStreamProvider;
// Explicit opt-in: current deployments keep the R10 memory-only behavior.
// The durable ledger is a synchronous fail-closed single-process file store.
const speechDeliveryLedgerFile=process.env.ALEX_SPEECH_DELIVERY_LEDGER_FILE;
const speechDeliveryBudget=speechDeliveryLedgerFile
 ?new DurableSpeechDeliveryBudget({
   file:speechDeliveryLedgerFile,dailySeconds:speechDeliveryDailySeconds
  })
 :new SpeechDeliveryBudget({dailySeconds:speechDeliveryDailySeconds});
const speechPlayback=speechStreamProvider
 ?new StreamingSpeechSessions({provider:new SegmentedPcmSpeechProvider({provider:meteredSpeechStreamProvider}),
   budget:speechDeliveryBudget,
   authorizeDelivery:principal=>audioAllowed(principal,'tts')}):null;
const learningPlans=new LearningPlans(
  process.env.ALEX_LEARNING_PLANS_FILE??resolve(appDir,'.local','learning-plans.json'));
const gateway=new DeviceGateway(process.env.GATEWAY_FILE??resolve(appDir,'.local','gateway.json'),devices);
const deviceStreamClients=new Set();
const agentMemoryEnabled=process.env.AGENT_MEMORY_CONTEXT==='1';
// Real AI requires explicit model, endpoint, key; default remains offline deterministic rules.
const useAgent=process.env.AGENT_PROVIDER==='compatible';
if(useAgent && (!process.env.AGENT_BASE_URL||!process.env.AGENT_API_KEY||!process.env.AGENT_MODEL))throw new Error('INVALID_AGENT_CONFIG');
const provider=useAgent?new CompatibleAgentProvider({baseUrl:process.env.AGENT_BASE_URL,apiKey:process.env.AGENT_API_KEY,model:process.env.AGENT_MODEL}):new RuleAgentProvider();
const core = new HomeCore(provider);
const skillGovernance=new SkillGovernance({
 file:process.env.ALEX_SKILL_GOVERNANCE_FILE??resolve(appDir,'.local','skill-governance.json'),
 registry:core.skills
});
const skillPackageTrust=new SkillPackageTrust({
 file:process.env.ALEX_SKILL_TRUST_FILE??resolve(appDir,'.local','skill-trust.json')
});
const skillPackages=new SkillPackageRegistry({
 file:process.env.ALEX_SKILL_PACKAGES_FILE??resolve(appDir,'.local','skill-packages.json'),
 authorizePackage:manifest=>skillPackageTrust.assertTrusted(manifest)
});
const workflows=new WorkflowOrchestrator(process.env.WORKFLOW_FILE??resolve(appDir,'.local','workflows.json'),{gateway,registry:devices,skills:core.skills,busyDevice:id=>plans.list().some(p=>p.deviceId===id&&p.status==='running')});
const plans=new PlanOrchestrator(process.env.PLAN_FILE??resolve(appDir,'.local','plans.json'),{gateway,registry:devices,skills:core.skills,busyDevice:id=>workflows.list().some(w=>w.deviceId===id&&['dispatching','navigating','speaking'].includes(w.status))});
if(!['rules','compatible'].includes(process.env.ALEX_PLAN_PROVIDER??'rules'))throw new Error('INVALID_PLAN_PROVIDER');
const proposalProvider=process.env.ALEX_PLAN_PROVIDER==='compatible'
  ?new CompatiblePlanProvider({baseUrl:process.env.AGENT_BASE_URL,apiKey:process.env.AGENT_API_KEY,model:process.env.AGENT_MODEL})
  :new RulePlanProvider();
const proposals=new PlanProposals(process.env.PROPOSAL_FILE??resolve(appDir,'.local','proposals.json'),{plans,provider:proposalProvider});
const executionTraces=new ExecutionTraceProjector({plans,workflows,gateway});
const companionSkillId={english:'learning.english',story:'story.interactive',quiz:'quiz.science'};
function requireEnabledCompanionSkill(mode){
  const id=companionSkillId[mode];
  if(id&&core.skills.list().find(s=>s.id===id)?.enabled!==true)
    throw Error('SKILL_DISABLED');
}

// New companion text product lane. Never reuse the intent classifier as a
// free-form chat engine; each provider is opt-in and completely tool-free.
// Conversation APIs require verified local family auth (not insecure demo).
const chatMode=process.env.ALEX_CHAT_PROVIDER??'offline';
if(!['offline','compatible'].includes(chatMode))throw new Error('INVALID_CHAT_PROVIDER');
if(process.env.ALEX_CONVERSATION_PERSIST==='1' && auth.mode!=='local')
  throw new Error('LOCAL_AUTH_REQUIRED_FOR_CONVERSATION_PERSISTENCE');
const chatProvider=chatMode==='compatible'
  ?new CompatibleCompanionProvider({
      baseUrl:process.env.AGENT_BASE_URL,
      apiKey:process.env.AGENT_API_KEY,
      model:process.env.AGENT_MODEL})
  :null;
const conversations=new CompanionConversations({
  provider:chatProvider,
  persist:process.env.ALEX_CONVERSATION_PERSIST==='1',
  file:process.env.ALEX_CONVERSATION_FILE??resolve(appDir,'.local','conversations.json'),
  authorizeMode:(actor,mode)=>{
    if(mode==='chat')return;
    const id=mode==='english'?'learning.english':
      mode==='quiz'?'quiz.science':'story.interactive';
    const skill=core.skills.list().find(entry=>entry.id===id && entry.conversationMode===mode);
    if(!skill||!skill.enabled||!skill.allowedActors.includes(actor))
      throw new Error('COMPANION_SKILL_UNAVAILABLE');
  },
  authorizeModel:principal=>learnerPrivacy.modelContext(principal)
});
const voiceTurns=speechPlayback?new VoiceTurnOrchestrator({
  conversations,speech:speechPlayback,
  authorize:principal=>{
    audioAllowedForVoice(principal);
  }
}):null;
function audioAllowedForVoice(principal){
 const prefs=learnerPrivacy.forPrincipal(principal);
 if(!prefs.voiceOutputAllowed||!prefs.cloudAudioOutputAllowed)
  throw Error('CHILD_CLOUD_AUDIO_DISABLED');
}
const store=new JsonStateStore(process.env.STATE_FILE??resolve(appDir,'.local','state.json'));
const saved=await store.load();
if(saved)core.restore(saved);
await memory.load();
await devices.load();
await profiles.load();
await learnerCredentials.load();
await learnerPrivacy.load();
await skillGovernance.load();
await skillPackageTrust.load();
await skillPackages.load();
await learningPlans.load();
await gateway.load();
await workflows.load();
await plans.load();
await proposals.load();
await conversations.load();
await store.save(core.snapshot());
let persistTimer=null;
const schedulePersist=()=>{
  clearTimeout(persistTimer);
  persistTimer=setTimeout(()=>store.save(core.snapshot()).catch(err=>{console.error('Persistence failure:',err.message);process.exitCode=1;}),200);
};
const clients = new Set();
const send = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
};
const errorStatus = (message) => ['CHAT_MODEL_REQUIRED','COMPANION_TURN_CANCELLED','AUDIO_PROVIDER_NOT_CONFIGURED',
  'AUDIO_ALREADY_ACTIVE','AUDIO_REQUEST_CANCELLED','AUDIO_ALREADY_FINISHING',
  'AUDIO_TURN_NOT_RECORDING','AUDIO_REALTIME_NOT_READY',
  'AUDIO_REALTIME_BACKPRESSURE','AUDIO_REALTIME_CONNECTION_CLOSED',
  'VOICE_TURN_ALREADY_ACTIVE','VOICE_TURN_CANCELLED',
  'AUDIO_REALTIME_FINAL_TIMEOUT','AUDIO_REQUEST_CANCELLED',
  'SPEECH_SESSION_NOT_READY','SPEECH_PLAYBACK_BACKPRESSURE',
  'SPEECH_PROVIDER_PCM_TOO_LARGE','PROVIDER_BILLING_STATEMENT_ID_CONFLICT',
  'SKILL_VERSION_REVIEW_REQUIRED','SKILL_INSTALL_CONFLICT',
  'SKILL_REFERENCE_CONFLICT','SKILL_REFERENCES_PINNED',
  'SKILL_DEPENDENCY_MISSING','SKILL_DEPENDENCY_IN_USE',
  'SKILL_PERMISSION_EXPANSION_REQUIRES_UNINSTALL',
  'SKILL_REVIEW_CONFLICT','SKILL_PACKAGE_EXISTS',
  'SKILL_VERSION_NOT_NEWER','SKILL_ATTESTATION_EXISTS',
  'PUBLISHER_ALREADY_EXISTS','SKILL_ROLLBACK_NOT_OLDER',
  'SKILL_ROLLBACK_REQUIRES_REVIEW'].includes(message)?409:
  ['AUDIO_SERVER_BUSY','VOICE_TURN_SERVER_BUSY','SPEECH_LEDGER_PERSIST_FAILED','PROVIDER_USAGE_JOURNAL_WRITE_FAILED','PROVIDER_USAGE_JOURNAL_FULL','PROVIDER_BILLING_STORE_WRITE_FAILED','PROVIDER_BILLING_STORE_FULL','PROVIDER_BILLING_NOT_CONFIGURED'].includes(message)?503:['CHILD_CLOUD_TEXT_DISABLED','CHILD_CLOUD_AUDIO_DISABLED',
  'AUDIO_TURN_FORBIDDEN','REALTIME_SESSION_FORBIDDEN',
  'SPEECH_SESSION_FORBIDDEN','SKILL_DISABLED','SKILL_NOT_APPROVED',
  'SKILL_NOT_INSTALLED','SKILL_PACKAGE_HISTORY_FULL','SKILL_ATTESTATION_REQUIRED',
  'PUBLISHER_NOT_ACTIVE','INVALID_SKILL_SIGNATURE'].includes(message)?403:message==='UNAUTHENTICATED'||message==='DEVICE_UNAUTHORIZED'||message==='INVALID_CREDENTIALS'?401:message==='PARENT_REQUIRED'||message==='LOCAL_AUTH_REQUIRED'||message==='LEARNING_PLANS_FORBIDDEN'||message==='LEARNING_PLANS_AUTH_REQUIRED'?403:['TOO_MANY_ATTEMPTS','AUDIO_RATE_LIMIT','SPEECH_DAILY_DELIVERY_LIMIT'].includes(message)?429:/^INVALID_|^UNKNOWN_|^CHAT_HAS_NO_LESSON|^LEARNING_PLANS_LIMIT|^AUTH_NOT_ENABLED|^MEMORY_LIMIT_|^SESSION_LIMIT_|^DEVICE_LIMIT_|^PROFILE_LIMIT_|^PROVIDER_BILLING_CSV_/.test(message)?400:500;
function asyncWrap(fn) {
  return async (req, res) => {
    try {await fn(req,res);} catch (err) {
      const message = err instanceof Error ? err.message : 'INTERNAL_ERROR';
      if(!res.destroyed&&!res.writableEnded)
        send(res,errorStatus(message),{ok:false,error:message});
    }
  };
}
async function body(req,maxBytes=8192) {
  if(req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('INVALID_CONTENT_TYPE');
  let raw='';
  for await (const chunk of req) { raw+=chunk; if(raw.length>maxBytes) throw new Error('INVALID_BODY_TOO_LARGE'); }
  try {const data=JSON.parse(raw); if(!data || Array.isArray(data) || typeof data!=='object') throw new Error();return data;}
  catch {throw new Error('INVALID_JSON');}
}

core.subscribe(e => {
  schedulePersist();
  const line=`id: ${e.seq}\nevent: home-event\ndata: ${JSON.stringify(e)}\n\n`;
  for(const res of clients)try{res.write(line);}catch{clients.delete(res);}
});
const tickTimer=setInterval(()=>core.tick(.1),100);
const gatewayTimer=setInterval(()=>gateway.expire().catch(err=>console.error('Gateway expiry:',err.message)),1000);
const workflowTimer=setInterval(()=>workflows.tick().catch(err=>console.error('Workflow tick:',err.message)),250);
const planTimer=setInterval(()=>plans.tick().catch(err=>console.error('Plan tick:',err.message)),250);
const audioSweepTimer=setInterval(()=>{
  audioIngress.sweep();realtimeSessions?.sweep();speechPlayback?.sweep();
},2000);
audioSweepTimer.unref?.();
const keepAliveTimer=setInterval(()=>{for(const res of clients)try{res.write(': heartbeat\n\n');}catch{clients.delete(res);}},15000);

const principalFor = req => {
  const session=auth.current(req);
  if(!session.authenticated||!session.actor)throw new Error('UNAUTHENTICATED');
  return session.learnerId?'learner:'+session.learnerId:session.actor;
};
// In-flight model requests are tracked by verified server-side principal.
const activeCompanionControllers=new Map();
function trackCompanion(principal,controller){
 const set=activeCompanionControllers.get(principal)??new Set();
 set.add(controller);activeCompanionControllers.set(principal,set);
 return ()=>{
   set.delete(controller);
   if(!set.size)activeCompanionControllers.delete(principal);
 };
}
function abortCompanion(principal){
 for(const controller of activeCompanionControllers.get(principal)??[])
   controller.abort();
}
function abortAllChildCompanion(){
 for(const principal of activeCompanionControllers.keys())
   if(principal==='child'||principal.startsWith('learner:'))abortCompanion(principal);
}
const audioAllowed=(principal,mode)=>{
  const prefs=learnerPrivacy.forPrincipal(principal);
  const allowed=mode==='asr'
    ?prefs.voiceInputAllowed&&prefs.cloudAudioInputAllowed
    :prefs.voiceOutputAllowed&&prefs.cloudAudioOutputAllowed;
  if(!allowed)throw new Error('CHILD_CLOUD_AUDIO_DISABLED');
  return prefs;
};
const server=http.createServer(asyncWrap(async(req,res)=>{
  const pathname=new URL(req.url??'/',`http://${req.headers.host ?? 'localhost'}`).pathname;
  const origin=req.headers.origin;
  const incomingHost = req.headers.host ?? '';
  // Prevent DNS rebinding: only explicit loopback Host headers are accepted.
  if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(incomingHost)){send(res,403,{ok:false,error:'LOOPBACK_HOST_REQUIRED'});return;}
  const allowedOrigin=`http://${incomingHost}`;
  if(origin && origin!==allowedOrigin){send(res,403,{ok:false,error:'CROSS_ORIGIN_FORBIDDEN'});return;}
  if(req.method==='GET' && pathname==='/api/auth/session'){send(res,200,auth.current(req));return;}
  if(req.method==='POST' && pathname==='/api/auth/login'){
    try{
      const data=await body(req);
      const login=auth.login(req,{role:data.role,secret:data.secret,code:data.code},
        (code,pin)=>{
          const id=learnerCredentials.verify(code,pin);
          return id&&profiles.list().some(p=>p.id===id)?id:null;
        });
      await audit.record({actor:login.actor,learnerId:login.learnerId,
        action:'auth.login',outcome:'allowed'});
      res.setHeader('Set-Cookie',login.cookie);
      send(res,200,{ok:true,actor:login.actor,...(login.learnerId?{learnerId:login.learnerId}:{})});
    }catch(err){
      await audit.record({action:'auth.login',outcome:'denied'});
      const message=err instanceof Error?err.message:'AUTH_FAILED';
      send(res,errorStatus(message),{ok:false,error:message});
    }
    return;
  }
  if(req.method==='POST' && pathname==='/api/auth/logout'){
    const session=auth.current(req);
    res.setHeader('Set-Cookie',auth.logout(req));
    await audit.record({actor:session.actor,action:'auth.logout',outcome:'allowed'});
    send(res,200,{ok:true});return;
  }
  // Device pairing completion and heartbeat have separate narrow credentials.
  // Neither endpoint can read family memory or submit motion commands.
  if(req.method==='POST' && pathname==='/api/devices/pair/complete'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    try{
      const result=await devices.complete(data.code,data.name);
      await audit.record({action:'device.paired',outcome:'allowed'});
      send(res,200,{ok:true,...result});
    }catch(e){await audit.record({action:'device.paired',outcome:'denied'});throw e;}
    return;
  }
  if(req.method==='POST' && pathname==='/api/devices/capabilities'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    send(res,200,await gateway.announce(data.deviceId,token,data.capabilities,data.protocolVersion));return;
  }
  if(req.method==='POST' && pathname==='/api/gateway/telemetry'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const outcome=await gateway.telemetry(data.deviceId,token,data);
    send(res,outcome.ok?200:409,outcome);return;
  }
  if(req.method==='POST' && pathname==='/api/gateway/presentation'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const result=await gateway.presentation(data.deviceId,token,data);
    await audit.record({actor:'device',action:'gateway.presentation',
      outcome:result.ok?'allowed':'denied'});
    send(res,result.ok?200:409,result);return;
  }
  if(req.method==='POST' && pathname==='/api/gateway/result'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const outcome=await gateway.result(data.deviceId,token,data);
    await audit.record({actor:'device',action:'gateway.result',outcome:outcome.ok?'allowed':'denied'});
    send(res,outcome.ok?200:409,outcome);return;
  }
  if(req.method==='GET' && (pathname==='/api/gateway/stream'||pathname==='/api/gateway/poll')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const deviceId=new URL(req.url,`http://${incomingHost}`).searchParams.get('deviceId');
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!devices.authenticate(deviceId,token)){send(res,401,{ok:false,error:'DEVICE_UNAUTHORIZED'});return;}
    if(pathname==='/api/gateway/poll'){send(res,200,{ok:true,jobs:gateway.pending(deviceId)});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const detach=gateway.attach(deviceId,token,res);deviceStreamClients.add(res);
    const keepAlive=setInterval(()=>{if(!devices.authenticate(deviceId,token)){res.end();return;}try{res.write(': heartbeat\n\n');}catch{res.end();}},10000);
    req.on('close',()=>{clearInterval(keepAlive);detach();deviceStreamClients.delete(res);});return;
  }
  if(req.method==='POST' && pathname==='/api/devices/heartbeat'){
    const data=await body(req);
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const result=await devices.heartbeat(data.deviceId,token);
    send(res,200,result);return;
  }
  // Authentication and actor binding are enforced before any private API.
  const isPrivate=pathname.startsWith('/api/') && pathname!=='/api/health';
  const session=auth.current(req);
  if(isPrivate && !session.authenticated){send(res,401,{ok:false,error:'UNAUTHENTICATED'});return;}
  // Demo remains loopback-only and must not be used as a real family security boundary.
  if(req.method==='GET' && pathname==='/api/health'){send(res,200,{ok:true,mode:'simulation',authMode:auth.mode,agentProvider:provider.kind,realAI:useAgent,agentMemoryOptIn:agentMemoryEnabled,physicalSafety:false,persistentTasks:true,virtualDeviceGateway:true,virtualPresentationProtocol:3,workflowOrchestrator:true,planOrchestrator:true,planProposals:true,planProposalProvider:proposalProvider.kind,independentLearnerIdentity:true,childCloudTextDefault:'denied',
    learnerPrivacyPolicyVersion:2,audioProvider:audioProvider?.kind??'disabled',
    audioRecordingMode:'short-clip',learningCurriculumVersion:1,learningEvidenceLedger:'session-snapshot-v1',companion:{available:auth.mode==='local',provider:conversations.providerKind,transcriptsPersisted:conversations.persist,voice:'browser_only_optional',streaming:true,learningEvidence:'text_only'},navigationTelemetry:true,simulationBridge:"grid-v1",ros2Connected:false,physicalDeviceActions:false});return;}
  if(req.method==='GET' && (pathname==='/api/proposals'||pathname.startsWith('/api/proposals/timeline/'))){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(pathname==='/api/proposals'){send(res,200,{proposals:proposals.list(),provider:proposalProvider.kind});return;}
    const id=decodeURIComponent(pathname.slice('/api/proposals/timeline/'.length));
    send(res,200,proposals.timeline(id));return;
  }
  if(req.method==='GET' && (pathname==='/api/plans'||pathname==='/api/plans/events')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(pathname==='/api/plans'){send(res,200,{plans:plans.list(),templates:plans.templates()});return;}
    const cursor=new URL(req.url,`http://${incomingHost}`).searchParams.get('after')??'0';
    if(!/^\d{1,15}$/.test(cursor)){send(res,400,{ok:false,error:'INVALID_EVENT_CURSOR'});return;}
    send(res,200,{events:plans.getEvents(Number(cursor))});return;
  }
  // R11 reviewed-text voice turn: text is committed by the existing
  // conversation pipeline before a separate PCM playback session is opened.
  // No provisional model token is spoken and no ASR result auto-submitted.
  if(pathname.startsWith('/api/voice/turn/')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const action=pathname.slice('/api/voice/turn/'.length);
    if(req.method==='GET'&&action==='capabilities'){
      const p=learnerPrivacy.forPrincipal(principal);
      send(res,200,{ok:true,available:!!voiceTurns,
        outputAllowed:!!(voiceTurns&&p.voiceOutputAllowed&&p.cloudAudioOutputAllowed),
        manualInputRequired:true,provisionalSpeech:false,
        textBeforeSpeech:true,duplex:false});return;
    }
    if(req.method==='GET'&&action==='metrics'){
      send(res,200,{ok:true,scope:'self',
        telemetry:voiceTurns?.metrics(principal)??null,
        audioStored:false,transcriptStoredByTelemetry:false,
        playbackProof:'client-claimed-only'});return;
    }
    if(req.method==='POST'&&action==='cancel'){
      const input=await body(req);
      send(res,200,{ok:true,...(voiceTurns?.cancel(principal,input.id)
        ??{cancelled:false})});return;
    }
    if(!voiceTurns)throw Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    if(req.method==='POST'&&action==='start'){
      audioAllowed(principal,'tts');
      const input=await body(req);
      const cancel=new AbortController();
      let ownTurnId=null;
      const disconnect=()=>{if(!res.writableEnded){
        cancel.abort();
        if(ownTurnId)voiceTurns.cancel(principal,ownTurnId);
      }};
      res.on('close',disconnect);
      try{
        // The existing conversation manager does its own model/text policy checks.
        const result=await voiceTurns.run(principal,{
          conversationId:input.conversationId,text:input.text,
          onCreated:id=>{
            ownTurnId=id;
            if(cancel.signal.aborted)voiceTurns.cancel(principal,id);
          }});
        if(cancel.signal.aborted||res.destroyed){
          voiceTurns.cancel(principal,result.turn.id);return;
        }
        send(res,200,{ok:true,...result});
      }finally{res.off('close',disconnect);}
      return;
    }
    if(req.method==='POST'&&action==='status'){
      const input=await body(req);
      send(res,200,{ok:true,turn:voiceTurns.status(principal,input.id)});return;
    }
    send(res,404,{ok:false,error:'UNKNOWN_VOICE_TURN_ROUTE'});return;
  }
  // SSE streamed replies have provisional token events and exactly one
  // authoritative committed event; no unfinished text is persisted. This
  // remains an authenticated local text endpoint, never a device command.
  if(req.method==='POST' && pathname==='/api/companion/stream'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const actor=principalFor(req);
    const input=await body(req);
    // Validate ownership before sending SSE headers; no other-role
    // transcript, even session metadata, may leak through error events.
    const ownedSession=conversations.get(actor,input.id);
    requireEnabledCompanionSkill(ownedSession.mode);
    const cancel=new AbortController();
    const forget=trackCompanion(actor,cancel);
    res.on('close',()=>{if(!res.writableEnded)cancel.abort();});
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-store, no-transform','Connection':'keep-alive',
      'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    const write=(event,data)=>{
      if(cancel.signal.aborted||res.destroyed)throw new Error('COMPANION_TURN_CANCELLED');
      res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');
    };
    try{
      write('ready',{id:input.id,provisional:true});
      const result=await conversations.streamTurn(actor,input.id,input.text,{
        signal:cancel.signal,onDelta:delta=>write('delta',{text:delta})
      });
      // Never interpret the model's text as a command or skill invocation.
      write('committed',{session:result.session,assistant:result.assistant,
                          source:result.source,milestone:result.milestone});
      res.end();
      await audit.record({actor:auth.actor(req),learnerId:auth.current(req).learnerId,
        action:'companion.stream',outcome:'allowed'});
    }catch(error){
      if(!cancel.signal.aborted){
        write('error',{error:error instanceof Error?error.message:'CHAT_STREAM_FAILED',
          partialDiscarded:true});
        res.end();
      }
      await audit.record({actor:auth.current(req).actor??'anonymous',
        learnerId:auth.current(req).learnerId,
        action:'companion.stream',outcome:'denied'}).catch(()=>{});
    }finally{
      forget();
      // Revocation aborts a provider but is not a client TCP disconnect.
      // End the SSE response so browser parsing fails on missing committed,
      // discarding provisional text instead of hanging indefinitely.
      if(cancel.signal.aborted&&!res.destroyed&&!res.writableEnded)res.end();
    }
    return;
  }
  // Text conversation is separate from commands, plans and device control.
  // Demo-mode actor switching is never a secure transcript boundary.
  if(req.method==='GET' && (pathname==='/api/companion/sessions'||pathname==='/api/companion/session')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const actor=principalFor(req);
    if(pathname==='/api/companion/sessions'){
      send(res,200,{sessions:conversations.list(actor),provider:conversations.providerKind,
                    transcriptsPersisted:conversations.persist});return;
    }
    const id=new URL(req.url,`http://${incomingHost}`).searchParams.get('id');
    send(res,200,{session:conversations.get(actor,id)});return;
  }
  if(req.method==='GET' && pathname==='/api/audio/playback/capabilities'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req),prefs=learnerPrivacy.forPrincipal(principal);
    send(res,200,{ok:true,provider:speechStreamProvider?.kind??'disabled',
      outputAllowed:!!(speechPlayback&&prefs.voiceOutputAllowed&&prefs.cloudAudioOutputAllowed),
      sampleRate:24000,format:'pcm16-mono-24khz',maxChunkBytes:4800,
      maxUnacknowledged:3,requiresExplicitPlay:true,
      playbackProof:'client-claimed',audioNotPersisted:true,
      deliveryBudgetSeconds:speechDeliveryDailySeconds,
      deliveryBudgetKind:speechDeliveryLedgerFile
       ?'alex-reserved-for-delivery-not-vendor-billed'
       :'alex-delivered-not-vendor-billed',
      deliveryBudgetPersistence:speechDeliveryLedgerFile?'single-process-file':'memory-only',
      providerUsageJournal:!!providerUsageJournal,
      duplex:false});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/playback/start'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'tts');
    if(!speechPlayback)throw Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    // Never cancel the learner's *current* session on an old HTTP close:
    // only the session created by this request can be terminated.
    let ownSessionId=null,disconnected=false;
    const onDisconnect=()=>{
      if(!res.writableEnded){
        disconnected=true;
        if(ownSessionId)speechPlayback.cancel(principal,ownSessionId);
      }
    };
    res.on('close',onDisconnect);
    try{
      const params=await body(req);
      if(disconnected||res.destroyed)return;
      const started=await speechPlayback.start(principal,{text:params.text});
      ownSessionId=started.id;
      if(disconnected||res.destroyed){
        speechPlayback.cancel(principal,ownSessionId);return;
      }
      try{audioAllowed(principal,'tts');}
      catch(error){speechPlayback.cancel(principal,ownSessionId);throw error;}
      if(disconnected||res.destroyed){
        speechPlayback.cancel(principal,ownSessionId);return;
      }
      send(res,200,{ok:true,session:started});
      await audit.record({actor:auth.current(req).actor,
        learnerId:auth.current(req).learnerId,
        action:'audio.playback.start',outcome:'allowed'});return;
    }finally{res.off('close',onDisconnect);}
  }
  if(req.method==='POST' && pathname==='/api/audio/playback/next'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'tts');
    if(!speechPlayback)throw Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    speechPlayback.status(principal,params.id);
    res.on('close',()=>{if(!res.writableEnded)
      speechPlayback.cancel(principal,params.id);});
    const block=await speechPlayback.next(principal,params.id,params.seq);
    if(block.done){
      if(!res.destroyed){res.writeHead(204,{'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff'});res.end();}
      return;
    }
    try{audioAllowed(principal,'tts');}
    catch(error){speechPlayback.cancel(principal,params.id);block.pcm.fill(0);throw error;}
    if(res.destroyed){block.pcm.fill(0);return;}
    res.on('finish',()=>block.pcm.fill(0));
    res.writeHead(200,{
      'Content-Type':'application/octet-stream',
      'Content-Length':block.pcm.byteLength,
      'X-Alex-Speech-Seq':String(block.seq),
      'X-Alex-Speech-Samples':String(block.samples),
      'X-Alex-Speech-Sentence-Index':String(block.sentenceIndex),
      'X-Alex-Speech-Sentence-Count':String(block.sentenceCount),
      'Cache-Control':'no-store, no-transform',
      'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'"
    });
    res.end(block.pcm);return;
  }
  if(req.method==='POST' && pathname==='/api/audio/playback/ack'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'tts');
    if(!speechPlayback)throw Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    const confirmed=speechPlayback.ack(principal,params.id,params.seq);
    send(res,200,{ok:true,...confirmed});
    if(confirmed.completed)await audit.record({
      actor:auth.current(req).actor,learnerId:auth.current(req).learnerId,
      action:'audio.playback.completed',outcome:'allowed'});
    return;
  }
  if(req.method==='POST' && pathname==='/api/audio/playback/status'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'tts');
    if(!speechPlayback)throw Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    send(res,200,{ok:true,session:speechPlayback.status(principal,params.id)});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/playback/cancel'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const params=await body(req);
    const result=speechPlayback?.cancel(principal,params.id)??{cancelled:false};
    send(res,200,{ok:true,...result});
    if(result.cancelled)await audit.record({
      actor:auth.current(req).actor,learnerId:auth.current(req).learnerId,
      action:'audio.playback.cancel',outcome:'allowed'});
    return;
  }
  if(req.method==='GET' && pathname==='/api/audio/playback/metrics'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    send(res,200,{ok:true,scope:'self',
      metrics:speechPlayback?.metrics(principal)??null,
      latency:speechPlayback?.latencyMetrics(principal)??null,
      deliveryBudget:speechPlayback?.deliveryBudget(principal)??null,
      rawAudioStored:false,textStored:false,
      playbackProof:'client-claimed'});return;
  }
  if(req.method==='GET' && pathname==='/api/audio/provider-usage'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{ok:true,usage:providerUsageJournal?.summary()??null,
      configured:!!providerUsageJournal,
      note:'Provider response PCM is not an invoice; learner content and credentials are not recorded.'});return;
  }
  if(pathname.startsWith('/api/audio/provider-billing/')){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(req.method==='POST'&&pathname==='/api/audio/provider-billing/csv'){
      if(!providerBillingCsvImporter)throw Error('PROVIDER_BILLING_NOT_CONFIGURED');
      const params=await body(req,1100000);
      const result=providerBillingCsvImporter.importCsv(params);
      send(res,result.duplicate?200:201,{ok:true,...result});return;
    }
    if(req.method==='POST'&&pathname==='/api/audio/provider-billing/statements'){
      if(!providerBillingStore)throw Error('PROVIDER_BILLING_NOT_CONFIGURED');
      const params=await body(req,1024*1024);
      const statement=params.statement??params;
      const result=providerBillingStore.importStatement(statement,{provenance:{
        source:'json',importedAt:new Date().toISOString(),
        sourceDigest:createHash('sha256').update(JSON.stringify(statement)).digest('hex'),
        mappingDigest:null
      }});
      send(res,result.duplicate?200:201,{ok:true,...result});return;
    }
    if(req.method==='GET'&&pathname==='/api/audio/provider-billing/statements'){
      send(res,200,{ok:true,configured:!!providerBillingStore,
        statements:providerBillingStore?.list()??[]});return;
    }
    if(req.method==='GET'&&pathname==='/api/audio/provider-billing/reconciliation'){
      const url=new URL(req.url,`http://${incomingHost}`);
      const fromText=url.searchParams.get('from'),toText=url.searchParams.get('to');
      if((fromText===null)!==(toText===null))
        throw Error('INVALID_PROVIDER_BILLING_REPORT_WINDOW');
      const parseWindow=value=>{
        const timestamp=Date.parse(value);
        if(!Number.isSafeInteger(timestamp)||new Date(timestamp).toISOString()!==value)
          throw Error('INVALID_PROVIDER_BILLING_REPORT_WINDOW');
        return timestamp;
      };
      const options=fromText===null?{}:{
        from:parseWindow(fromText),to:parseWindow(toText),
        ...(url.searchParams.has('provider')?{provider:url.searchParams.get('provider')}: {})
      };
      if(fromText===null&&url.searchParams.has('provider'))
        options.provider=url.searchParams.get('provider');
      send(res,200,{ok:true,configured:!!providerBillingReconciler,
        reports:providerBillingReconciler?.report(options)??[],
        summary:providerBillingReconciler?.summary(options)??null,
        note:'Only pcm_bytes is currently comparable with R20. Request counts and other billing units remain explicitly unverified until supplier billing semantics are established.'});return;
    }
    send(res,404,{ok:false,error:'NOT_FOUND'});return;
  }
  if(req.method==='GET' && pathname==='/api/audio/realtime/capabilities'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req),p=learnerPrivacy.forPrincipal(principal);
    send(res,200,{ok:true,provider:realtimeProvider?.kind??'disabled',
      inputAllowed:!!(realtimeProvider&&p.voiceInputAllowed&&p.cloudAudioInputAllowed),
      format:'pcm16-mono-24khz',maxFrameBytes:9600,
      maxAudioBytes:720000,maxDurationMs:15000,
      upstreamStreaming:!!realtimeProvider,
      transcriptMode:'manual-submit-preview',
      serverAudioStorage:false});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/realtime/start'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!realtimeSessions)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    const started=await realtimeSessions.start(principal,{
      language:params.language??'zh'});
    // Consent can change during the external WSS handshake: do not retain
    // a live upstream session if the second authorization check fails.
    try{audioAllowed(principal,'asr');}
    catch(error){realtimeSessions.cancel(principal,started.id);throw error;}
    send(res,200,{ok:true,session:started});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/realtime/frame'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!realtimeSessions)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const id=req.headers['x-alex-realtime-id'];
    // Validate signed-in session owner before receiving any PCM bytes.
    realtimeSessions.status(principal,id);
    const data=await readRealtimePcmFrame(req);
    try{
      const seq=Number(req.headers['x-alex-frame-seq']);
      const receipt=await realtimeSessions.append(principal,id,{seq,data});
      send(res,200,{ok:true,...receipt});
    }finally{data.fill(0);}
    return;
  }
  if(req.method==='GET' && pathname==='/api/audio/realtime/status'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!realtimeSessions)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const id=new URL(req.url,`http://${incomingHost}`).searchParams.get('id');
    send(res,200,{ok:true,session:realtimeSessions.status(principal,id)});return;
  }
  if(req.method==='GET' && pathname==='/api/audio/realtime/metrics'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    send(res,200,{ok:true,scope:'self',
      metrics:realtimeSessions?.metrics(principal)??null,
      transcriptStored:false,rawAudioStored:false});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/realtime/commit'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!realtimeSessions)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    realtimeSessions.status(principal,params.id);
    res.on('close',()=>{if(!res.writableEnded)
      realtimeSessions.cancel(principal,params.id);});
    const result=await realtimeSessions.commit(principal,params.id,{
      authorized:()=>audioAllowed(principal,'asr')
    });
    if(!res.destroyed)send(res,200,{ok:true,...result});
    await audit.record({actor:auth.current(req).actor,
      learnerId:auth.current(req).learnerId,
      action:'audio.realtime.commit',outcome:'allowed'});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/realtime/cancel'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const params=await body(req);
    send(res,200,{ok:true,cancelled:realtimeSessions?.cancel(principal,params.id)??false});
    return;
  }
  if(req.method==='GET' && pathname==='/api/audio/capabilities'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req),prefs=learnerPrivacy.forPrincipal(principal);
    send(res,200,{provider:audioProvider?'compatible':'disabled',
      inputAllowed:Boolean(audioProvider&&prefs.voiceInputAllowed&&prefs.cloudAudioInputAllowed),
      outputAllowed:Boolean(audioProvider&&prefs.voiceOutputAllowed&&prefs.cloudAudioOutputAllowed),
      maxAudioBytes:MAX_AUDIO_UPLOAD_BYTES,maxDurationMs:MAX_AUDIO_MS,
      supportedMimeTypes:['audio/webm','audio/ogg','audio/mp4','audio/wav','audio/mpeg'],
      recordingMode:'short-clip',incrementalTransport:true,
      upstreamASRMode:'batch-after-finish',uploadsPersisted:false,
      cloudVendorProcessing:!!audioProvider});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/turn/start'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!audioProvider)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    const started=audioIngress.open(principal,{
      mime:params.mime,language:params.language??'zh'});
    send(res,200,{ok:true,turn:started});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/turn/chunk'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!audioProvider)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const id=req.headers['x-alex-turn-id'];
    const seq=Number(req.headers['x-alex-chunk-seq']);
    // Validate identity/ownership before buffering any uploaded bytes.
    audioIngress.status(principal,id);
    const {mime,bytes}=await readAudioChunk(req);
    const result=audioIngress.append(principal,id,{seq,mime,data:bytes});
    send(res,200,{ok:true,...result});return;
  }
  if(req.method==='GET' && pathname==='/api/audio/turn/status'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const id=new URL(req.url,`http://${incomingHost}`).searchParams.get('id');
    send(res,200,{ok:true,turn:audioIngress.status(principal,id)});return;
  }
  if(req.method==='GET' && pathname==='/api/audio/turn/metrics'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    send(res,200,{ok:true,scope:'self',metrics:audioIngress.metrics(principal),
      rawAudioStored:false,textStored:false});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/turn/finish'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr');
    if(!audioProvider)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    const params=await body(req);
    audioIngress.status(principal,params.id);
    res.on('close',()=>{if(!res.writableEnded){
      audioIngress.cancel(principal,params.id);audioGate.cancel(principal);
    }});
    const result=await audioIngress.finish(principal,params.id,{
      authorized:()=>audioAllowed(principal,'asr'),
      transcribe:input=>audioGate.run(principal,'asr',async gateSignal=>
        audioProvider.transcribe({...input,
          signal:AbortSignal.any([gateSignal,input.signal])}))
    });
    if(!res.destroyed)send(res,200,{ok:true,...result,
      streamBoundary:'browser-to-Alex-only',upstream:'batch-asr-after-finish'});
    await audit.record({actor:auth.current(req).actor,
      learnerId:auth.current(req).learnerId,action:'audio.turn.finish',outcome:'allowed'});
    return;
  }
  if(req.method==='POST' && pathname==='/api/audio/turn/cancel'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const params=await body(req);
    const cancelled=audioIngress.cancel(principal,params.id);
    if(cancelled)audioGate.cancel(principal);
    send(res,200,{ok:true,cancelled});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/cancel'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    // Cancellation only applies to this authenticated identity.
    const stopped=audioIngress.cancel(principal);
    const live=realtimeSessions?.cancel(principal)??false;
    const playback=speechPlayback?.cancel(principal).cancelled??false;
    const upstream=audioGate.cancel(principal);
    send(res,200,{ok:true,cancelled:stopped||live||playback||upstream});return;
  }
  if(req.method==='POST' && pathname==='/api/audio/transcribe'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'asr'); // before receiving a child's binary audio
    if(!audioProvider)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    res.on('close',()=>{if(!res.writableEnded)audioGate.cancel(principal);});
    req.on('aborted',()=>audioGate.cancel(principal));
    const clip=await readAudioUpload(req);
    const result=await audioGate.run(principal,'asr',async signal=>{
      audioAllowed(principal,'asr');
      const transcript=await audioProvider.transcribe({
        audio:clip.audio,mime:clip.mime,
        language:req.headers['x-alex-language']==='en'?'en':
          req.headers['x-alex-language']==='zh'?'zh':undefined,
        signal
      });
      audioAllowed(principal,'asr');
      return transcript;
    });
    if(!res.destroyed)send(res,200,{ok:true,...result,
      requiresManualSubmit:true,clipDurationClaimMs:clip.durationClaimMs});
    await audit.record({actor:auth.current(req).actor,
      learnerId:auth.current(req).learnerId,action:'audio.transcribe',outcome:'allowed'});
    return;
  }
  if(req.method==='POST' && pathname==='/api/audio/speak'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    audioAllowed(principal,'tts');
    if(!audioProvider)throw new Error('AUDIO_PROVIDER_NOT_CONFIGURED');
    res.on('close',()=>{if(!res.writableEnded)audioGate.cancel(principal);});
    req.on('aborted',()=>audioGate.cancel(principal));
    const params=await body(req);
    if(typeof params.text!=='string'||params.text.length>500||!params.text.trim())
      throw new Error('INVALID_AUDIO_TEXT');
    if(!['zh','en'].includes(params.language??'zh'))
      throw new Error('INVALID_AUDIO_LANGUAGE');
    const result=await audioGate.run(principal,'tts',async signal=>{
      audioAllowed(principal,'tts');
      const output=await audioProvider.synthesize({
        text:params.text,language:params.language??'zh',signal});
      audioAllowed(principal,'tts');
      return output;
    });
    if(!res.destroyed){
      res.writeHead(200,{'Content-Type':result.mime,
        'Content-Length':result.audio.byteLength,
        'Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'"});
      res.end(result.audio);
    }
    await audit.record({actor:auth.current(req).actor,
      learnerId:auth.current(req).learnerId,action:'audio.speak',outcome:'allowed'});
    return;
  }
  if(req.method==='GET' && pathname==='/api/learner/privacy'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const requested=new URL(req.url,`http://${incomingHost}`).searchParams.get('profileId');
    if(requested!==null){
      if(principal!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
      if(!profiles.list().some(p=>p.id===requested))throw new Error('UNKNOWN_LEARNER_PROFILE');
      send(res,200,{profileId:requested,preferences:learnerPrivacy.forProfile(requested)});return;
    }
    send(res,200,{preferences:learnerPrivacy.forPrincipal(principal)});return;
  }
  if(req.method==='GET' && pathname==='/api/learning/catalog'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    auth.actor(req);
    send(res,200,{version:1,courses:courseCatalog()});return;
  }
  if(req.method==='GET' && pathname==='/api/learning/plans'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const owner=principalFor(req);
    const requested=new URL(req.url,`http://${incomingHost}`).searchParams.get('profileId');
    const plansForOwner=owner==='child'?[]:
      learningPlans.list(owner,requested??undefined);
    send(res,200,{plans:plansForOwner});return;
  }
  if(req.method==='GET' && pathname==='/api/learning/overview'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const principal=principalFor(req);
    const profileId=new URL(req.url,`http://${incomingHost}`).searchParams.get('profileId');
    if(principal==='child'&&profileId!==null)
      throw new Error('LEARNING_PLANS_FORBIDDEN');
    const plans=principal==='child'?[]:learningPlans.list(principal,profileId??undefined);
    const overview=plans.map(plan=>{
      const owner='learner:'+plan.profileId;
      const progress=conversations.progress(principal==='parent'?'parent':principal,
        owner);
      const completed=progress.byCourse[plan.courseId]??0;
      return {...plan,completed,
        remaining:Math.max(0,plan.targetCompletions-completed),
        goalReached:completed>=plan.targetCompletions,
        textExerciseOnly:true};
    });
    send(res,200,{overview});return;
  }
  if(req.method==='GET' && pathname==='/api/companion/progress'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    const actor=principalFor(req);
    const requested=new URL(req.url,`http://${incomingHost}`).searchParams.get('scope');
    const scope=requested===null||requested==='self'?actor:requested;
    send(res,200,{progress:conversations.progress(actor,scope)});return;
  }
  if(req.method==='GET' && pathname==='/api/workflows'){
    const actor=auth.actor(req);if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    send(res,200,{workflows:workflows.list(),recipes:WORKFLOW_RECIPES});return;
  }
  if(req.method==='GET' && (pathname==='/api/executions'
    ||pathname.startsWith('/api/executions/'))){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(pathname==='/api/executions'){
      const params=new URL(req.url,`http://${incomingHost}`).searchParams;
      const limit=params.get('limit')??'25';
      if(!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100){
        send(res,400,{ok:false,error:'INVALID_EXECUTION_TRACE_FILTER'});return;
      }
      const kind=params.get('kind')??undefined;
      const deviceId=params.get('deviceId')??undefined;
      if(kind!==undefined&&!['plan','workflow'].includes(kind)
       ||deviceId!==undefined&&!/^dev-[0-9a-f-]{36}$/.test(deviceId)){
        send(res,400,{ok:false,error:'INVALID_EXECUTION_TRACE_FILTER'});return;
      }
      const cursor=params.get('cursor')??undefined;
      if(cursor!==undefined&&(cursor.length>350||! /^[A-Za-z0-9_-]{12,350}$/.test(cursor))){
        send(res,400,{ok:false,error:'INVALID_EXECUTION_TRACE_CURSOR'});return;
      }
      let page;
      try{page=executionTraces.page({limit:Number(limit),kind,deviceId,cursor});}
      catch(error){
        if(error?.message!=='INVALID_EXECUTION_TRACE_CURSOR')throw error;
        send(res,400,{ok:false,error:'INVALID_EXECUTION_TRACE_CURSOR'});return;
      }
      send(res,200,{ok:true,...page,simulationOnly:true});return;
    }
    const id=pathname.slice('/api/executions/'.length);
    if(!/^(plan|wf)-[0-9a-f-]{36}$/.test(id)){
      send(res,400,{ok:false,error:'INVALID_EXECUTION_TRACE_ID'});return;
    }
    const trace=executionTraces.get(id);
    if(!trace){send(res,404,{ok:false,error:'UNKNOWN_EXECUTION_TRACE'});return;}
    send(res,200,{ok:true,trace});return;
  }
  if(req.method==='GET' && pathname==='/api/gateway/events'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    const query=new URL(req.url,`http://${incomingHost}`).searchParams;
    const after=query.get('after')??'0',limit=query.get('limit')??'100';
    if(!/^\d{1,15}$/.test(after)||!/^\d{1,3}$/.test(limit)
     ||Number(limit)<1||Number(limit)>500){
      send(res,400,{ok:false,error:'INVALID_GATEWAY_EVENT_CURSOR'});return;
    }
    send(res,200,{ok:true,...gateway.getEvents(Number(after),{limit:Number(limit)})});return;
  }
  if(req.method==='GET' && pathname==='/api/gateway/navigation-map'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{map:{width:MAP.width,height:MAP.height,cellMeters:MAP.cellMeters,destinations:MAP.destinations,walls:MAP.walls,furniture:MAP.furniture},version:'alex-home-grid-v1',simulationOnly:true});return;
  }
  if(req.method==='GET' && pathname==='/api/gateway/jobs'){
    const actor=auth.actor(req,new URL(req.url,`http://${incomingHost}`).searchParams.get('actor'));
    if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    send(res,200,{jobs:gateway.list()});return;
  }
  if(req.method==='GET' && pathname==='/api/state'){send(res,200,core.state());return;}
  if(req.method==='GET' && pathname==='/api/devices'){send(res,200,{devices:[...core.listDevices(),...devices.list()]});return;}
  if(req.method==='GET' && pathname==='/api/profiles'){
    const session=auth.current(req);
    const visible=session.actor==='parent'?profiles.list():
      session.learnerId?profiles.list().filter(p=>p.id===session.learnerId):[];
    send(res,200,{profiles:visible});return;
  }
  if(req.method==='GET' && pathname==='/api/learners/access'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{learners:learnerCredentials.listForParent('parent')});return;
  }
  if(req.method==='GET' && pathname==='/api/privacy/export'){const actor=auth.actor(req);if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}send(res,200,{version:1,profiles:profiles.list(),learnerLoginCodes:learnerCredentials.listForParent(actor),
      learnerPrivacy:learnerPrivacy.list(actor),
      learningPlans:learningPlans.exportForParent(actor),
      learningEvidence:conversations.exportEvidenceForParent(actor),
      memory:memory.exportForParent(actor),devices:devices.list(),
      companionConversations:conversations.exportForParent(actor),
      transcriptsPersisted:conversations.persist});return;}
  if(req.method==='GET' && pathname==='/api/skills'){send(res,200,{skills:core.skills.list()});return;}
  if(req.method==='GET' && pathname==='/api/skills/governance'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{ok:true,skills:skillGovernance.list(),trustedOnly:true});return;
  }
  if(req.method==='GET' && pathname==='/api/skills/usage'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{ok:true,...projectSkillUsage({
      skills:core.skills,plans,workflows,learningPlans,
      packages:skillPackages.list('parent')
    })});return;
  }
  if(req.method==='GET' && pathname==='/api/skills/trust'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    const state=skillPackageTrust.list('parent');
    send(res,200,{ok:true,publishers:state.publishers.map(({id,fingerprint,revoked})=>({id,fingerprint,revoked})),
      attestations:state.attestations.map(({id,version,publisherId,manifestSha256,artifactSha256})=>({
        id,version,publisherId,manifestSha256,artifactSha256
      })),events:state.events});return;
  }
  if(req.method==='GET' && pathname==='/api/skills/packages'){
    if(auth.mode!=='local'){send(res,403,{ok:false,error:'LOCAL_AUTH_REQUIRED'});return;}
    if(auth.actor(req)!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{ok:true,...skillPackages.list('parent'),metadataOnly:true});return;
  }
  if(req.method==='GET' && pathname==='/api/memory'){
    const actor=auth.actor(req,new URL(req.url,`http://${incomingHost}`).searchParams.get('actor'));
    send(res,200,{entries:memory.list(actor)});return;
  }
  if(req.method==='GET' && pathname==='/api/audit'){
    const actor=auth.actor(req,new URL(req.url,`http://${incomingHost}`).searchParams.get('actor'));
    if(actor!=='parent'){send(res,403,{ok:false,error:'PARENT_REQUIRED'});return;}
    send(res,200,{events:await audit.recent()});return;
  }
  if(req.method==='GET' && pathname==='/api/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(': connected\n\n');clients.add(res);
    req.on('close',()=>clients.delete(res));return;
  }
  if(req.method==='POST' && pathname.startsWith('/api/')){
    const data=await body(req);
    const actor=auth.actor(req,data.actor);
    let result;
    try {
      if(pathname==='/api/skills/governance'){
        if(auth.mode!=='local')throw Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,...await skillGovernance.set(actor,{
          id:data.id,enabled:data.enabled,expectedVersion:data.expectedVersion
        })};
        if(result.changed&&!result.skill.enabled){
          for(const principal of activeCompanionControllers.keys())abortCompanion(principal);
        }
      }else if(pathname==='/api/skills/trust'){
        if(auth.mode!=='local')throw Error('LOCAL_AUTH_REQUIRED');
        if(actor!=='parent')throw Error('PARENT_REQUIRED');
        if(data.action==='enroll')result={ok:true,...await skillPackageTrust.enroll(actor,data)};
        else if(data.action==='revoke')result={ok:true,...await skillPackageTrust.revoke(actor,data)};
        else if(data.action==='attest'){
          const found=skillPackages.list('parent').packages.find(p=>
            p.manifest.id===data.id&&p.manifest.version===data.version);
          if(!found)throw Error('UNKNOWN_SKILL_PACKAGE');
          result={ok:true,...await skillPackageTrust.attest(actor,{
            manifest:found.manifest,artifactBase64:data.artifactBase64,
            publisherId:data.publisherId,signature:data.signature
          })};
        }else throw Error('INVALID_SKILL_TRUST_ACTION');
      }else if(pathname==='/api/skills/packages'){
        if(auth.mode!=='local')throw Error('LOCAL_AUTH_REQUIRED');
        if(actor!=='parent')throw Error('PARENT_REQUIRED');
        const action=data.action;
        if(action==='submit')result={ok:true,...await skillPackages.submit(actor,data.manifest)};
        else if(action==='review')result={ok:true,...await skillPackages.review(actor,data)};
        else if(action==='install')result={ok:true,...await skillPackages.install(actor,data)};
        else if(action==='preview')result={ok:true,preview:skillPackages.preview(actor,data)};
        else if(action==='rollback')result={ok:true,...await skillPackages.rollback(actor,data)};
        else if(action==='uninstall')result={ok:true,...await skillPackages.uninstall(actor,data)};
        else if(action==='reference')result={ok:true,...await skillPackages.setReference(actor,data)};
        else throw Error('INVALID_SKILL_PACKAGE_ACTION');
      }else if(pathname==='/api/learner/privacy'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,privacy:await learnerPrivacy.set(actor,data.profileId,data.preferences,
          id=>profiles.list().some(p=>p.id===id))};
        // Best-effort live revocation of already-open SSE and JSON calls.
        // The server remains authoritative on every subsequent model turn.
        if(!result.privacy.preferences.cloudTextAllowed)
          abortCompanion('learner:'+data.profileId);
        if(!result.privacy.preferences.cloudAudioInputAllowed||
          !result.privacy.preferences.cloudAudioOutputAllowed){
          audioGate.cancel('learner:'+data.profileId);
          audioIngress.cancel('learner:'+data.profileId);
          realtimeSessions?.cancel('learner:'+data.profileId);
        }
        if(!result.privacy.preferences.cloudAudioOutputAllowed||
          !result.privacy.preferences.voiceOutputAllowed)
          speechPlayback?.cancel('learner:'+data.profileId);
        if(!result.privacy.preferences.cloudAudioOutputAllowed||
           !result.privacy.preferences.voiceOutputAllowed||
           !result.privacy.preferences.cloudTextAllowed)
          voiceTurns?.cancel('learner:'+data.profileId);
      }else if(pathname==='/api/learning/assign'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,plan:await learningPlans.assign(actor,{
          profileId:data.profileId,courseId:data.courseId,
          targetCompletions:data.targetCompletions},
          profileId=>profiles.list().some(profile=>profile.id===profileId))};
      }else if(pathname==='/api/learning/change'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,plan:await learningPlans.changeStatus(actor,data.id,data.status)};
      }else if(pathname==='/api/learning/delete'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:await learningPlans.remove(actor,data.id)};
      }else if(pathname==='/api/companion/open'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        requireEnabledCompanionSkill(data.mode);
        result={ok:true,session:await conversations.open(principalFor(req),data.mode,{lessonId:data.lessonId})};
      }else if(pathname==='/api/companion/turn'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        const principal=principalFor(req),controller=new AbortController();
        requireEnabledCompanionSkill(conversations.get(principal,data.id).mode);
        const forget=trackCompanion(principal,controller);
        try{
          result={ok:true,...await conversations.turn(principal,data.id,data.text,
            {signal:controller.signal})};
        }finally{forget();}
      }else if(pathname==='/api/companion/delete'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await conversations.remove(principalFor(req),data.id);
      }else if(pathname==='/api/companion/erase'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,deletedConversations:await conversations.erase(actor,data.scope)};
      }else if(pathname==='/api/devices/pair/start'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,...devices.start(actor)};
      }else if(pathname==='/api/devices/revoke'){
        result={ok:await devices.revoke(actor,data.deviceId),message:'Device revoke processed'};
        if(result.ok)await gateway.disconnect(data.deviceId);
      }else if(pathname==='/api/devices/capabilities/approve'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await gateway.approve(actor,data.deviceId,data.capabilities);
      }else if(pathname==='/api/gateway/dispatch'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await gateway.dispatch(actor,data);
      }else if(pathname==='/api/proposals/create'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await proposals.propose(actor,data);
        await audit.record({actor,action:'proposal.create',outcome:result.ok?'allowed':'denied',requestId:data.requestId});
      }else if(pathname==='/api/proposals/approve'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await proposals.approve(actor,data.proposalId);
        await audit.record({actor,action:'proposal.approve',outcome:result.ok?'allowed':'denied'});
      }else if(pathname==='/api/proposals/reject'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await proposals.reject(actor,data.proposalId);
        await audit.record({actor,action:'proposal.reject',outcome:result.ok?'allowed':'denied'});
      }else if(pathname==='/api/plans/start'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await plans.start(actor,data);
      }else if(pathname==='/api/plans/command'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await plans.command(actor,data);
      }else if(pathname==='/api/plans/cancel'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await plans.cancel(actor,data.planId);
      }else if(pathname==='/api/workflows/start'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await workflows.start(actor,data);
      }else if(pathname==='/api/workflows/command'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await workflows.startCommand(actor,data);
      }else if(pathname==='/api/workflows/cancel'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await workflows.cancel(actor,data.workflowId);
      }else if(pathname==='/api/gateway/cancel'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result=await gateway.cancel(actor,data.jobId);
      }else if(pathname==='/api/profiles'){
        result={ok:true,profile:await profiles.add(actor,data)};
      }else if(pathname==='/api/learners/set-pin'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:true,learner:await learnerCredentials.setPin(actor,data.profileId,data.pin,
          profileId=>profiles.list().some(p=>p.id===profileId))};
        auth.revokeLearner(data.profileId);
      }else if(pathname==='/api/learners/revoke'){
        if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
        result={ok:await learnerCredentials.revoke(actor,data.profileId)};
        auth.revokeLearner(data.profileId);
      }else if(pathname==='/api/profiles/delete'){
        const deleted=await profiles.remove(actor,data.id);
        if(deleted){
          // The profile cannot authenticate after deletion, even if cleanup
          // subsequently fails. Delete related transcript evidence as well.
          auth.revokeLearner(data.id);
          abortCompanion('learner:'+data.id);
          audioGate.cancel('learner:'+data.id);
          audioIngress.erasePrincipal('learner:'+data.id);
          realtimeSessions?.erasePrincipal('learner:'+data.id);
          speechPlayback?.erasePrincipal('learner:'+data.id);
          voiceTurns?.erasePrincipal('learner:'+data.id);
          await learnerCredentials.revoke(actor,data.id);
          await conversations.eraseLearner(actor,data.id);
          await learningPlans.removeProfile(actor,data.id);
          await learnerPrivacy.revoke(actor,data.id);
        }
        result={ok:deleted,message:'Profile deletion processed'};
      }else if(pathname==='/api/privacy/erase'){
        const removed=await memory.erase(actor,data.scope);
        // Family erasure must cover the opt-in conversation transcript store,
        // not merely the legacy manually entered memory entries.
        let deletedConversations=0;
        if(['child','parent','all'].includes(data.scope))
          deletedConversations=await conversations.erase(actor,data.scope);
        const deletedLearningPlans=await learningPlans.eraseForPrivacy(actor,data.scope);
        const clearedLearnerPrivacy=await learnerPrivacy.clearForPrivacy(actor,data.scope);
        if(['child','all'].includes(data.scope)){
          abortAllChildCompanion();audioGate.cancelChild();
          audioIngress.cancelAllChildren();realtimeSessions?.cancelChildren();
          speechPlayback?.cancelChildren();voiceTurns?.cancelChildren();
        }
        const erasedAudioMetricsPrincipals=audioIngress.eraseScope(data.scope);
        const erasedRealtimeAudioPrincipals=realtimeSessions?.eraseScope(data.scope)??0;
        const erasedSpeechPlaybackPrincipals=speechPlayback?.eraseScope(data.scope)??0;
        voiceTurns?.eraseScope(data.scope);
        result={ok:true,deletedMemoryEntries:removed,deletedConversations,deletedLearningPlans,
          clearedLearnerPrivacy,erasedAudioMetricsPrincipals,
          erasedRealtimeAudioPrincipals,erasedSpeechPlaybackPrincipals,
          note:'Audit metadata, profiles and remote model provider data are not erased by this operation.'};
      }else if(pathname==='/api/memory'){
        const entry=await memory.add(actor,data.scope,data.text);
        result={ok:true,message:'Memory saved',entry};
      }else if(pathname==='/api/memory/delete'){
        const deleted=await memory.remove(actor,data.id);
        result={ok:deleted,message:deleted?'Memory deleted':'Memory not found'};
      }else {
        const trusted={...data,actor};
        switch(pathname){
          case '/api/command': {
            // Recognize a small allowlist of composite commands before the legacy single-action classifier.
            // Role binding comes from the verified session; no model-generated workflow JSON is trusted.
            if(parseWorkflowCommand(data.text)){
              if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
              result=await workflows.startCommand(actor,{text:data.text,deviceId:data.deviceId,requestId:data.requestId});
              break;
            }
            if(data.deviceId!==undefined){
              if(auth.mode!=='local')throw new Error('LOCAL_AUTH_REQUIRED');
              // Routing external virtual devices is a separate, parent-authorized action.
              // The model only proposes an intent; it never controls arbitrary hardware.
              if(actor!=='parent')throw new Error('PARENT_REQUIRED');
              if(typeof data.text!=='string'||!data.text.trim()||data.text.length>500)throw new Error('INVALID_COMMAND');
              let proposal;
              try{proposal=validateProposal(await provider.propose(data.text,agentMemoryEnabled?memory.forAgent(actor):[]));}
              catch{result={ok:false,message:'Agent proposal invalid; no device action issued'};break;}
              if(proposal.type!=='navigate'){result={ok:false,message:'Only virtual navigation is supported for remote simulated devices'};break;}
              result=await gateway.dispatch(actor,{deviceId:data.deviceId,capability:'sim.navigation.goto',params:{destination:proposal.destination},requestId:data.requestId});
              break;
            }
            result=await core.commandAsync(data.text,actor,data.requestId,agentMemoryEnabled?memory.forAgent(actor):[]);break;
          }
          case '/api/tasks': result=core.navigate(trusted);break;
          case '/api/tasks/cancel': result=core.cancel(data.taskId,actor);break;
          case '/api/safety/stop': result=core.emergencyStop(actor);break;
          case '/api/safety/reset': result=core.resetEmergencyStop(actor);break;
          case '/api/environment': result=core.setObstacle(data.obstaclePresent,actor);break;
          case '/api/skills/invoke': {
            result=core.invokeSkill(data.id,actor);
            // Existing SkillRegistry remains the source of permissions.
            // Authorized local invocations of interactive built-ins now
            // return a real conversation session instead of a static message.
            if(result.ok&&auth.mode==='local'){
              const manifest=core.skills.list().find(skill=>skill.id===data.id);
              if(manifest?.conversationMode){
                const course=resolveCourse(manifest.conversationMode,data.lessonId);
                const session=await conversations.open(principalFor(req),manifest.conversationMode,
                  {lessonId:course.id});
                result={...result,session};
              }
            }
            break;
          }
          default:send(res,404,{ok:false,error:'NOT_FOUND'});return;
        }
        // Persist the command before returning success. Device motion is simulated only.
        await store.save(core.snapshot());
      }
      await audit.record({actor,learnerId:auth.current(req).learnerId,
        action:pathname,outcome:result.ok?'allowed':'denied',
        requestId:typeof data.requestId==='string'?data.requestId:undefined});
      send(res,result.ok?200:409,result);
    }catch(err){
      await audit.record({actor,action:pathname,outcome:'error'});
      throw err;
    }
    return;
  }
  const assets={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/navigation.js':'navigation.js','/terminal-runtime.js':'terminal-runtime.js','/voice-session.js':'voice-session.js','/audio-session.js':'audio-session.js',
    '/audio-vad.js':'audio-vad.js',
    '/audio-stream-session.js':'audio-stream-session.js',
    '/realtime-pcm-session.js':'realtime-pcm-session.js',
    '/speech-playback-session.js':'speech-playback-session.js',
    '/pcm-capture-processor.js':'pcm-capture-processor.js'};
  if(req.method!=='GET'||!(pathname in assets)){send(res,404,{ok:false,error:'NOT_FOUND'});return;}
  const file=assets[pathname];
  const bytes=await readFile(resolve(publicDir,file));
  const mime=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
  res.writeHead(200,{
    'Content-Type':`${mime}; charset=utf-8`,
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'"
  });
  res.end(bytes);
}));
server.listen(port,host,()=>console.log(`Home Agent OS ready → http://${host}:${port}`));
function shutdown(){
  voiceTurns?.eraseScope('all');
  speechPlayback?.cancelChildren();speechPlayback?.cancel('parent');
  realtimeSessions?.cancelChildren();
  realtimeSessions?.cancel('parent');
  clearInterval(audioSweepTimer);clearInterval(gatewayTimer);clearInterval(workflowTimer);clearInterval(planTimer);for(const r of deviceStreamClients)try{r.end();}catch{}clearInterval(tickTimer);clearInterval(keepAliveTimer);clearTimeout(persistTimer);for(const res of clients)res.end();server.close(async()=>{try{await store.save(core.snapshot());}catch(err){console.error(err);}process.exit(process.exitCode??0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
