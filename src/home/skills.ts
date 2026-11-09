import type { Actor, Capability, SkillDescriptor } from '../contracts.js';
import { PolicyEngine } from './policy.js';

export type SkillResult = {ok:boolean;message:string};
export interface SkillManifest extends SkillDescriptor {
  version: string;
  enabled: boolean;
  /** Optional interactive companion UI mode, never a device capability. */
  conversationMode?: 'english' | 'story' | 'quiz';
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
    this.register({manifest:{id:'learning.english',version:'0.2.0',enabled:true,name:'英语陪读',description:'互动式 A1 文字英语练习（本地会话）；语音为可选浏览器能力',conversationMode:'english',capabilities:['audio.input','audio.output'],allowedActors:['parent','child']},execute:()=>({ok:true,message:'英语技能已授权。请在 Alex 互动终端开启 A1 练习会话；此调用不会自动播放声音。'})});
    this.register({manifest:{id:'story.interactive',version:'0.2.0',enabled:true,name:'互动故事',description:'可选择剧情的多轮互动故事（本地会话）',conversationMode:'story',capabilities:['audio.output','display.face'],allowedActors:['parent','child']},execute:()=>({ok:true,message:'互动故事技能已授权。请在 Alex 互动终端开启分支剧情会话。'})});
    this.register({manifest:{id:'quiz.science',version:'0.1.0',enabled:true,name:'科学小问答',
      description:'日常科学与生活安全基础知识文字测验',conversationMode:'quiz',
      capabilities:[],allowedActors:['parent','child']},
      execute:()=>({ok:true,message:'科学小问答已授权，请在 Alex 互动终端回答三个问题。'})});
    this.register({manifest:{id:'home.status',version:'0.2.0',enabled:true,name:'家庭状态',description:'本地设备状态（演示）',capabilities:[],allowedActors:['parent']},execute:()=>({ok:true,message:'家庭状态技能已启动（演示）：家庭中枢在线，机器人模拟器已连接。'})});
  }
  register(plugin: SkillPlugin): void {
    const m=plugin.manifest;
    if(!/^[a-z][a-z0-9.-]{2,79}$/.test(m.id) || !/^\d+\.\d+\.\d+$/.test(m.version) || typeof plugin.execute!=='function' || this.plugins.has(m.id) || typeof m.name!=='string' || !m.name.trim() || typeof m.description!=='string' || typeof m.enabled!=='boolean' || (m.conversationMode!==undefined&&!['english','story','quiz'].includes(m.conversationMode)) || !Array.isArray(m.allowedActors) || !Array.isArray(m.capabilities) || !m.allowedActors.length || m.allowedActors.some(x=>x!=='parent'&&x!=='child') || m.capabilities.some(x=>!['audio.input','audio.output','display.face','navigation.goto','navigation.dock'].includes(x)))throw new Error('INVALID_SKILL_MANIFEST');
    this.plugins.set(m.id,{manifest:{...m,capabilities:[...m.capabilities],allowedActors:[...m.allowedActors]},execute:plugin.execute});
  }
  /** Parent-controlled state change; no untrusted source or executable upload. */
  setEnabled(id:string,enabled:boolean,actor:Actor):SkillManifest {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    if(typeof enabled!=='boolean')throw new Error('INVALID_SKILL_STATE');
    const plugin=this.plugins.get(id);
    if(!plugin)throw new Error('UNKNOWN_SKILL');
    // Copy before mutation: the built-in manifest is the executable identity.
    plugin.manifest={...plugin.manifest,enabled};
    return {...plugin.manifest,
      capabilities:[...plugin.manifest.capabilities],
      allowedActors:[...plugin.manifest.allowedActors]};
  }
  /** A trusted in-process code upgrade is not a remote plugin install. */
  upgradeTrusted(plugin:SkillPlugin,actor:Actor):SkillManifest {
    if(actor!=='parent')throw new Error('PARENT_REQUIRED');
    const incoming=plugin?.manifest;
    const previous=incoming?.id&&this.plugins.get(incoming.id);
    if(!previous)throw new Error('UNKNOWN_SKILL');
    const semver=(v:string)=>/^\\d+\\.\\d+\\.\\d+$/.test(v)?v.split('.').map(Number):null;
    const oldVersion=semver(previous.manifest.version);
    const nextVersion=semver(incoming.version);
    if(!nextVersion||!oldVersion
      ||nextVersion.every((v,i)=>v===oldVersion[i])
      ||nextVersion[0]<oldVersion[0]
      ||nextVersion[0]===oldVersion[0]&&nextVersion[1]<oldVersion[1]
      ||nextVersion[0]===oldVersion[0]&&nextVersion[1]===oldVersion[1]
        &&nextVersion[2]<=oldVersion[2])
      throw new Error('SKILL_VERSION_NOT_NEWER');
    if(typeof plugin.execute!=='function')throw new Error('INVALID_SKILL_MANIFEST');
    // Validate the full manifest through the existing registration path.
    this.plugins.delete(incoming.id);
    try{this.register({...plugin,manifest:{...incoming,enabled:previous.manifest.enabled}});}
    catch(error){this.plugins.set(incoming.id,previous);throw error;}
    return this.list().find(s=>s.id===incoming.id)!;
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
