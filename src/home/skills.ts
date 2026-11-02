import type { Actor, SkillDescriptor } from '../contracts.js';
import { PolicyEngine } from './policy.js';
export class SkillRegistry {
  private readonly catalog:SkillDescriptor[]=[
    {id:'learning.english',name:'英语陪读',description:'基础跟读与学习课程（当前为演示）',capabilities:['audio.input','audio.output'],allowedActors:['parent','child']},
    {id:'story.interactive',name:'互动故事',description:'分支故事与角色互动（当前为演示）',capabilities:['audio.output','display.face'],allowedActors:['parent','child']},
    {id:'home.status',name:'家庭状态',description:'查看本地中枢和机器人状态',capabilities:[],allowedActors:['parent']}
  ];
  constructor(private readonly policy:PolicyEngine){}
  list():SkillDescriptor[]{return this.catalog.map(x=>({...x,capabilities:[...x.capabilities],allowedActors:[...x.allowedActors]}));}
  invoke(id:string,actor:Actor):{ok:boolean;message:string} {
    const skill=this.catalog.find(s=>s.id===id);
    if(!skill)return {ok:false,message:'Unknown skill.'};
    const decision=this.policy.checkSkill(actor,id);
    if(!decision.allowed)return {ok:false,message:decision.reason};
    const response:Record<string,string>={
      'learning.english':'英语陪读技能已启动（演示）：Hello! Let’s practice “I like apples.”',
      'story.interactive':'互动故事技能已启动（演示）：小机器人在星空下找到一张神秘地图……',
      'home.status':'家庭状态技能已启动（演示）：家庭中枢在线，机器人模拟器已连接。'
    };
    return {ok:true,message:response[id]!};
  }
}
