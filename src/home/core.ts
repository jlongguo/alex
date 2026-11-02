import { actors, destinations, type Actor, type CommandResult, type Destination, type DeviceDescriptor, type HomeEvent, type NavigationCommand, type RobotTask, type RobotRuntime } from '../contracts.js';
import { MAP } from '../robot/map.js';
import { SimulatedRobot } from '../robot/simulator.js';
import { parseIntent, type Intent } from './agent.js';
import { RuleAgentProvider, type AgentProvider, validateProposal } from './providers.js';
import { PolicyEngine } from './policy.js';
import { SkillRegistry } from './skills.js';

export class HomeCore {
  readonly robot: RobotRuntime = new SimulatedRobot();
  readonly provider: AgentProvider;
  readonly policy=new PolicyEngine();
  readonly skills=new SkillRegistry(this.policy);
  private tasks:RobotTask[]=[];
  private events:HomeEvent[]=[];
  private sequence=0;
  private taskSeq=0;
  private activeTaskId:string|null=null;
  private listeners=new Set<(e:HomeEvent)=>void>();
  constructor(provider:AgentProvider=new RuleAgentProvider()){
    this.provider=provider;
    this.emit('system.message',`Home Core started (agent: ${provider.kind}, robot: simulated).`);
  }
  subscribe(listener:(e:HomeEvent)=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private emit(type:HomeEvent['type'],message:string,data?:unknown):void {
    const event={seq:++this.sequence,timestamp:new Date().toISOString(),type,message,data};
    this.events.push(event);if(this.events.length>150)this.events.shift();
    for(const listener of this.listeners)try{listener(event);}catch{ /* a UI subscriber cannot break the core */ }
  }
  private taskEvent(task:RobotTask,message:string):void {this.emit('task.updated',message,{task:{...task}});}
  listDevices():DeviceDescriptor[]{return [{id:this.robot.id,name:'Companion Bot 01',type:'mobile_robot',capabilities:['navigation.goto','navigation.dock','audio.input','audio.output','display.face'],online:this.robot.getState().online}];}
  state(){return {robot:this.robot.getState(),path:this.robot.getPath(),map:MAP,tasks:this.tasks.map(t=>({...t})),activeTaskId:this.activeTaskId,skills:this.skills.list(),events:[...this.events]};}
  listTasks(){return this.tasks.map(t=>({...t}));}
  /** Export bounded simulated task/event state. No secret or physical motor state is persisted. */
  snapshot(){return {schemaVersion:1,taskSeq:this.taskSeq,sequence:this.sequence,tasks:this.listTasks(),events:[...this.events]};}
  /** Restores history, but NEVER automatically resumes movement after an application restart. */
  restore(value:unknown):void {
    if(!value || typeof value!=='object')throw new Error('INVALID_SNAPSHOT');
    const v=value as ReturnType<HomeCore['snapshot']>;
    if(v.schemaVersion!==1 || !Number.isSafeInteger(v.taskSeq) || v.taskSeq<0 || v.taskSeq>100000000 || !Number.isSafeInteger(v.sequence) || v.sequence<0 || !Array.isArray(v.tasks) || v.tasks.length>100 || !Array.isArray(v.events) || v.events.length>150)throw new Error('INVALID_SNAPSHOT');
    const statusOptions=['queued','running','succeeded','failed','cancelled','stopped'];
    const parsed=v.tasks.map(task=>{
      if(!task || typeof task!=='object' || !/^task-[1-9]\d*$/.test(task.id) || !destinations.includes(task.destination) || !actors.includes(task.actor) || !['navigation.goto','navigation.dock'].includes(task.capability) || !statusOptions.includes(task.status) || !Number.isFinite(task.progress) || task.progress<0 || task.progress>100 || typeof task.createdAt!=='string' || typeof task.updatedAt!=='string')throw new Error('INVALID_SNAPSHOT');
      if(task.requestId!==undefined && (typeof task.requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(task.requestId)))throw new Error('INVALID_SNAPSHOT');
      return {...task};
    });
    if(parsed.some(t=>Number(t.id.slice(5))>v.taskSeq) || new Set(parsed.map(t=>t.id)).size!==parsed.length || v.events.some(e=>!e || !Number.isSafeInteger(e.seq) || e.seq>v.sequence || typeof e.type!=='string' || typeof e.message!=='string'))throw new Error('INVALID_SNAPSHOT');
    this.tasks=parsed;
    this.events=v.events.map(e=>({...e}));
    this.taskSeq=v.taskSeq;
    this.sequence=v.sequence;
    this.activeTaskId=null;
    for(const task of this.tasks){
      if(task.status==='running'||task.status==='queued'){
        task.status='stopped';task.reason='Interrupted by application restart; manual restart required';task.updatedAt=new Date().toISOString();
        this.taskEvent(task,`Task ${task.id} stopped after restart`);
      }
    }
    this.emit('system.message','Task history restored; simulated robot reset to dock. No navigation resumed.');
  }
  private assertActor(actor:unknown): asserts actor is Actor {if(!actors.includes(actor as Actor))throw new Error('INVALID_ACTOR');}
  navigate(command:NavigationCommand):CommandResult {
    this.assertActor(command.actor);
    if(!destinations.includes(command.params?.destination))throw new Error('INVALID_DESTINATION');
    if(!['navigation.goto','navigation.dock'].includes(command.capability))throw new Error('INVALID_CAPABILITY');
    if(command.capability==='navigation.dock'&&command.params.destination!=='dock')throw new Error('INVALID_DOCK_TARGET');
    const requestId=command.requestId;
    if(requestId!==undefined && (typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)))throw new Error('INVALID_REQUEST_ID');
    const timeoutSeconds=command.timeoutSeconds ?? 180;
    if(typeof timeoutSeconds!=='number'||!Number.isFinite(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>600)throw new Error('INVALID_TIMEOUT');
    const existing=requestId && this.tasks.find(t=>t.requestId===requestId && t.actor===command.actor);
    if(existing){
      if(existing.destination!==command.params.destination||existing.capability!==command.capability)return {ok:false,message:'IDEMPOTENCY_CONFLICT'};
      return {ok:true,message:'Existing task returned for requestId',task:{...existing}};
    }
    const decision=this.policy.checkNavigation(command.actor,command.params.destination,this.robot.getState().emergencyStopped);
    if(!decision.allowed){this.emit('policy.denied',decision.reason);return {ok:false,message:decision.reason};}
    // Only one navigation task controls the robot at a time.
    // Invalid routes must NOT cancel an existing valid task.
    const destination=command.params.destination;
    // Robot.navigate checks every route before applying it; replace active task only after successful planning.
    try{this.robot.navigate(destination);}catch(err){const message=err instanceof Error?err.message:'NAVIGATION_ERROR';this.emit('system.message',message);return {ok:false,message};}
    const old=this.tasks.find(t=>t.id===this.activeTaskId);
    if(old&&old.status==='running'){
      old.status='cancelled';old.reason='Superseded by a new command';old.updatedAt=new Date().toISOString();this.taskEvent(old,`Task ${old.id} superseded`);
    }
    const now=new Date().toISOString();
    const task:RobotTask={id:`task-${++this.taskSeq}`,capability:command.capability,destination,actor:command.actor,status:'running',progress:0,createdAt:now,updatedAt:now,requestId,elapsedSeconds:0,timeoutSeconds};
    this.tasks.unshift(task);if(this.tasks.length>100)this.tasks.pop();this.activeTaskId=task.id;
    this.taskEvent(task,`Moving to ${destination}`);
    this.emit('robot.state','Robot started moving',this.robot.getState());
    if(!this.robot.getPath().length)this.finishTask('succeeded','Already at destination');
    return {ok:true,message:`Navigating to ${destination}`,task:{...task}};
  }
  tick(seconds:number):void {
    if(!this.activeTaskId)return;
    const task=this.tasks.find(t=>t.id===this.activeTaskId);
    if(!task||task.status!=='running')return;
    if(!Number.isFinite(seconds)||seconds<=0)return;
    task.elapsedSeconds=(task.elapsedSeconds??0)+seconds;
    if(task.elapsedSeconds >= (task.timeoutSeconds??180)){
      this.robot.stop();this.finishTask('failed','Navigation timed out');return;
    }
    const result=this.robot.tick(seconds);
    task.progress=result.progress;task.updatedAt=new Date().toISOString();
    if(result.status==='arrived')this.finishTask('succeeded',`Arrived at ${task.destination}`);
    else if(result.status==='blocked')this.finishTask('stopped','Motion stopped: obstacle detected');
    else if(result.status==='stopped')this.finishTask('stopped','Emergency stop active');
    // Avoid emitting task updated on every simulation tick; state is polled separately.
  }
  private finishTask(status:RobotTask['status'],reason:string):void {
    const task=this.tasks.find(t=>t.id===this.activeTaskId);
    if(!task)return;
    task.status=status;task.progress=status==='succeeded'?100:task.progress;task.reason=reason;task.updatedAt=new Date().toISOString();
    this.activeTaskId=null;this.taskEvent(task,reason);
    this.emit('robot.state',reason,this.robot.getState());
  }
  cancel(taskId:string,actor:Actor):CommandResult {
    this.assertActor(actor);
    const decision=this.policy.checkControl(actor,'navigation.goto');
    if(!decision.allowed)return {ok:false,message:decision.reason};
    if(taskId!==this.activeTaskId)return {ok:false,message:'Task is not active.'};
    this.robot.stop();this.finishTask('cancelled','Cancelled by parent');
    return {ok:true,message:'Task cancelled'};
  }
  emergencyStop(actor:Actor):CommandResult {
    this.assertActor(actor);
    // Any actor can stop physical movement. A child cannot clear the stop.
    this.robot.emergencyStop();this.finishTask('stopped',`Emergency stop by ${actor}`);
    this.emit('robot.state','Emergency stop latched',this.robot.getState());
    return {ok:true,message:'Emergency stop latched'};
  }
  resetEmergencyStop(actor:Actor):CommandResult {
    this.assertActor(actor);
    const decision=this.policy.checkControl(actor,'safety.reset');
    if(!decision.allowed)return {ok:false,message:decision.reason};
    this.robot.resetEmergencyStop();this.emit('robot.state','Emergency stop cleared by parent',this.robot.getState());
    return {ok:true,message:'Emergency stop cleared'};
  }
  setObstacle(present:boolean,actor:Actor):CommandResult {
    this.assertActor(actor);
    const decision=this.policy.checkControl(actor,'environment.obstacle');
    if(!decision.allowed)return {ok:false,message:decision.reason};
    if(typeof present!=='boolean')throw new Error('INVALID_OBSTACLE_VALUE');
    this.robot.setObstacle(present);
    if(present&&this.activeTaskId)this.finishTask('stopped','Obstacle appeared: safe stop');
    this.emit('robot.state',present?'Dynamic obstacle inserted':'Dynamic obstacle cleared',this.robot.getState());
    return {ok:true,message:present?'Obstacle inserted':'Obstacle cleared'};
  }
  invokeSkill(id:string,actor:Actor):CommandResult {
    this.assertActor(actor);
    const result=this.skills.invoke(id,actor);
    this.emit(result.ok?'skill.invoked':'policy.denied',result.message,{skillId:id,actor});
    return {...result,skill:id};
  }
  private executeIntent(intent:Intent,actor:Actor,requestId?:string):CommandResult {
    if(intent.type==='navigate')return this.navigate({actor,capability:intent.destination==='dock'?'navigation.dock':'navigation.goto',params:{destination:intent.destination},requestId});
    if(intent.type==='skill')return this.invokeSkill(intent.id,actor);
    if(intent.type==='stop')return this.emergencyStop(actor);
    return {ok:false,message:'无法识别该指令。'};
  }
  async commandAsync(text:string,actor:Actor,requestId?:string):Promise<CommandResult> {
    this.assertActor(actor);
    if(typeof text!=='string'||!text.trim()||text.length>500)throw new Error('INVALID_COMMAND');
    try {
      const proposed=await this.provider.propose(text);
      return this.executeIntent(validateProposal(proposed),actor,requestId);
    }catch(err){
      // Fail closed. Do not guess and issue motion commands when the LLM fails.
      const message=err instanceof Error?err.message:'AGENT_ERROR';
      this.emit('system.message',`Agent proposal rejected: ${message}`);
      return {ok:false,message:'Agent unavailable or returned an invalid command; no action taken.'};
    }
  }
  command(text:string,actor:Actor):CommandResult {
    this.assertActor(actor);
    if(typeof text!=='string'||text.length>500)throw new Error('INVALID_COMMAND');
    const intent=parseIntent(text);
    if(intent.type!=='unknown')return this.executeIntent(intent,actor);
    return {ok:false,message:'当前使用确定性命令解析器，请尝试“去书桌”“去客厅”“讲故事”“学英语”或“紧急停止”。尚未接入真实 LLM。'};
  }
}
export {MAP};
