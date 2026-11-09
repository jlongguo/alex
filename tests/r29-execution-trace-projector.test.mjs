import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ExecutionTraceProjector} from '../scripts/execution-trace-projector.mjs';

const UUID=()=>randomUUID(),dev=()=> 'dev-'+UUID(),job=()=> 'job-'+UUID();
function fixture(){
 const deviceId=dev(),planId='plan-'+UUID(),workflowId='wf-'+UUID();
 const planNav=job(),planAudio=job(),workflowNav=job(),workflowAudio=job();
 const at='2026-11-09T00:00:00.000Z';
 const plans=[{id:planId,requestId:'plan_request_1234',status:'succeeded',
  deviceId,templateId:'learn.at.desk',createdAt:at,updatedAt:at,reason:null,
  steps:[
   {id:'move',kind:'device',status:'succeeded',dependsOn:[],jobId:planNav},
   {id:'teach',kind:'skill',status:'succeeded',dependsOn:['move'],jobId:null},
   {id:'say',kind:'device',status:'succeeded',dependsOn:['teach'],jobId:planAudio}
  ]}];
 const workflows=[{id:workflowId,requestId:'wf_request_1234',status:'succeeded',
  deviceId,recipe:'story.corner',createdAt:at,updatedAt:at,reason:null,
  navigationJobId:workflowNav,audioJobId:workflowAudio,steps:[
   {name:'navigation',status:'succeeded',jobId:workflowNav},
   {name:'skill',status:'succeeded',skillId:'story.interactive'},
   {name:'audio',status:'succeeded',jobId:workflowAudio}
  ]}];
 const tasks=[
  [planNav,planId+'-move','sim.navigation.goto'],
  [planAudio,planId+'-say','audio.output'],
  [workflowNav,workflowId+'-nav','sim.navigation.goto'],
  [workflowAudio,workflowId+'-audio','audio.output']
 ].map(([id,requestId,capability])=>({id,requestId,deviceId,capability,
  status:'succeeded',createdAt:at,updatedAt:at,reason:null,
  params:capability==='audio.output'?{text:'VERY PRIVATE CHILD OUTPUT'}:
   {destination:'study_desk'}}));
 const events=tasks.map((task,i)=>({seq:i+1,deviceId,jobId:task.id,
  requestId:task.requestId,type:'job.updated',at,status:'succeeded'}));
 const projector=new ExecutionTraceProjector({
  plans:{list:()=>plans,getEvents:()=>[
   {seq:1,type:'plan.created',planId,stepId:null,status:'running',at},
   {seq:2,type:'step.succeeded',planId,stepId:'teach',status:'running',at},
   {seq:3,type:'plan.succeeded',planId,stepId:null,status:'succeeded',at}
  ]},
  workflows:{list:()=>workflows},
  gateway:{list:()=>tasks,getEvents:(after,{limit=500}={})=>({
   latestSeq:events.at(-1)?.seq??0,oldestSeq:events[0]?.seq??null,
   events:events.filter(e=>e.seq>after).slice(0,limit)
  })}
 });
 return {projector,plans,workflows,tasks,events,deviceId,planId,workflowId};
}
test('R29 correlates Plan steps, skill evidence and gateway request/event IDs without prompts',()=>{
 const f=fixture(),result=f.projector.get(f.planId);
 assert.equal(result.kind,'plan');
 assert.deepEqual(result.steps.map(s=>s.correlation),[
  'matched','local-skill-step','matched']);
 assert.equal(result.steps[0].job.requestId,f.planId+'-move');
 assert.equal(result.steps[1].skillId,'learning.english');
 assert.equal(result.steps[1].job,null);
 assert.equal(result.steps[2].events[0].jobId,result.steps[2].job.jobId);
 assert.equal(result.planEvents.length,3);
 assert.equal(result.simulationOnly,true);
 assert.ok(!JSON.stringify(result).includes('VERY PRIVATE CHILD OUTPUT'));
});
test('R29 workflow has separate navigation, local skill, and audio event identities',()=>{
 const f=fixture(),result=f.projector.get(f.workflowId);
 assert.equal(result.kind,'workflow');
 assert.deepEqual(result.steps.map(s=>s.dispatchRequestId),[
  f.workflowId+'-nav',null,f.workflowId+'-audio']);
 assert.deepEqual(result.steps.map(s=>s.correlation),[
  'matched','local-skill-step','matched']);
 assert.equal(result.steps[1].skillId,'story.interactive');
 assert.equal(result.planEvents.length,0);
});
test('R29 trace denies attaching a wrong-device or wrong-request gateway job',()=>{
 const f=fixture();
 f.tasks[0].requestId='unrelated_req_12345';
 const result=f.projector.get(f.planId);
 assert.equal(result.steps[0].correlation,'conflict');
 assert.equal(result.steps[0].job,null);
 assert.equal(result.steps[0].events.length,0);
});
test('R29 limited list filters by kind and device; records are immutable copies',()=>{
 const f=fixture();
 assert.equal(f.projector.list().length,2);
 assert.equal(f.projector.list({kind:'plan'}).length,1);
 assert.equal(f.projector.list({deviceId:'dev-'+UUID()}).length,0);
 const first=f.projector.list({limit:1});
 first[0].status='tampered';
 assert.equal(f.projector.list({limit:1})[0].status,'succeeded');
 for(const opts of [{limit:0},{limit:101},{kind:'tool'},{deviceId:'secret'}])
  assert.throws(()=>f.projector.list(opts),/INVALID_EXECUTION_TRACE_FILTER/);
 assert.throws(()=>f.projector.get('../bad'),/INVALID_EXECUTION_TRACE_ID/);
 assert.equal(f.projector.get('plan-'+UUID()),null);
});
test('R29 retained-window gaps are explicit, not fabricated as complete evidence',()=>{
 const f=fixture();
 f.events.splice(0,3);
 const result=f.projector.get(f.planId);
 assert.equal(result.retention.gatewayHistoryMayBeTruncated,true);
 assert.equal(result.steps[0].events.length,0);
 assert.equal(result.steps[0].eventHistoryTruncated,true);
});
test('R29 projection never invokes gateway dispatch, skills or mutations',()=>{
 const f=fixture();
 f.projector.gateway.dispatch=()=>{throw Error('FORBIDDEN_SIDE_EFFECT')};
 f.projector.plans.start=()=>{throw Error('FORBIDDEN_SIDE_EFFECT')};
 f.projector.workflows.start=()=>{throw Error('FORBIDDEN_SIDE_EFFECT')};
 f.projector.get(f.planId);
 f.projector.get(f.workflowId);
 assert.equal(f.projector.list().length,2);
});
