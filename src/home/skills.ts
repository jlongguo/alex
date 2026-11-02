import type { Actor, Capability, SkillDescriptor } from '../contracts.js';
import { PolicyEngine } from './policy.js';

export type SkillResult = {ok:boolean;message:string};
export interface SkillManifest extends SkillDescriptor {
  version: string;
  enabled: boolean;
}
export interface SkillContext {
  readonly actor: Actor;
  readonly capabilities: readonly Capability[];
}
export interface SkillPlugin {
  readonly manifest: SkillManifest;
  execute(context: Readonly<SkillContext>): SkillResult;
}

/** Trusted, in-process plugins only. Third-party JS must NOT be loaded into this runtime. */
export class SkillRegistry {
  private readonly plugins = new Map<string, SkillPlugin>();
  constructor(private readonly policy:PolicyEngine, private readonly availableCapabilities: readonly Capability[] = ['audio.input','audio.output','display.face']) {
    this.register({manifest:{id:'learning.english',version:'0.2.0',enabled:true,name:'英语陪读',description:'基础跟读（演示）',capabilities:['audio.input','audio.output'],allowedActors:['parent','child']},execute:()=>({ok:true,message:'英语陪读技能已启动（演示）：Hello! Let’s practice “I like apples.”'})});
    this.register({manifest:{id:'story.interactive',version:'0.2.0',enabled:true,name:'互动故事',description:'分支故事（演示）',capabilities:['audio.output','display.face'],allowedActors:['parent','child']},execute:()=>({ok:true,message:'互动故事技能已启动（演示）：小机器人在星空下找到一张神秘地图……'})});
    this.register({manifest:{id:'home.status',version:'0.2.0',enabled:true,name:'家庭状态',description:'本地设备状态（演示）',capabilities:[],allowedActors:['parent']},execute:()=>({ok:true,message:'家庭状态技能已启动（演示）：家庭中枢在线，机器人模拟器已连接。'})});
  }
  register(plugin: SkillPlugin): void {
    const m=plugin.manifest;
    if(!/^[a-z][a-z0-9.-]{2,79}$/.test(m.id) || !/^\d+\.\d+\.\d+$/.test(m.version) || typeof plugin.execute!=='function' || this.plugins.has(m.id) || typeof m.name!=='string' || !m.name.trim() || typeof m.description!=='string' || typeof m.enabled!=='boolean' || !Array.isArray(m.allowedActors) || !Array.isArray(m.capabilities) || !m.allowedActors.length || m.allowedActors.some(x=>x!=='parent'&&x!=='child') || m.capabilities.some(x=>!['audio.input','audio.output','display.face','navigation.goto','navigation.dock'].includes(x)))throw new Error('INVALID_SKILL_MANIFEST');
    this.plugins.set(m.id,{manifest:{...m,capabilities:[...m.capabilities],allowedActors:[...m.allowedActors]},execute:plugin.execute});
  }
  unregister(id:string):boolean {return this.plugins.delete(id);}
  list():SkillManifest[]{return [...this.plugins.values()].map(x=>({...x.manifest,capabilities:[...x.manifest.capabilities],allowedActors:[...x.manifest.allowedActors]}));}
  invoke(id:string,actor:Actor):SkillResult {
    const plugin=this.plugins.get(id);
    if(!plugin)return {ok:false,message:'Unknown skill.'};
    const m=plugin.manifest;
    if(!m.enabled)return {ok:false,message:'Skill is disabled.'};
    if(!m.allowedActors.includes(actor))return {ok:false,message:'Skill is not permitted for this actor.'};
    const decision=this.policy.checkSkill(actor,id);
    if(!decision.allowed)return {ok:false,message:decision.reason};
    if(m.capabilities.some(c=>!this.availableCapabilities.includes(c)))return {ok:false,message:'Required device capability is unavailable.'};
    try {
      const result=plugin.execute(Object.freeze({actor,capabilities:Object.freeze([...m.capabilities])}));
      if(typeof result?.ok!=='boolean'||typeof result?.message!=='string')return {ok:false,message:'Skill returned invalid result.'};
      return {ok:result.ok,message:result.message.slice(0,2000)};
    }catch{return {ok:false,message:'Skill execution failed.'};}
  }
}
