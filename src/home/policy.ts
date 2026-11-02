import type { Actor, Capability, Destination } from '../contracts.js';
export type PermissionDecision = {allowed:true}|{allowed:false;reason:string};
export class PolicyEngine {
  checkNavigation(actor:Actor, destination:Destination, emergencyStopped:boolean):PermissionDecision {
    if(emergencyStopped)return {allowed:false,reason:'Emergency stop is active; a parent must reset it.'};
    if(actor==='child' && destination==='dock')return {allowed:false,reason:'Children cannot initiate docking or override device controls.'};
    if(actor!=='child'&&actor!=='parent')return {allowed:false,reason:'Unknown actor.'};
    return {allowed:true};
  }
  checkSkill(actor:Actor, skillId:string):PermissionDecision {
    if(actor!=='child'&&actor!=='parent')return {allowed:false,reason:'Unknown actor.'};
    if(actor==='child'&&!['learning.english','story.interactive'].includes(skillId)) {
      return {allowed:false,reason:'This skill requires parental permission.'};
    }
    return {allowed:true};
  }
  checkControl(actor:Actor, capability:Capability|'environment.obstacle'|'safety.reset'):PermissionDecision {
    if(actor!=='parent')return {allowed:false,reason:`${capability} requires a parent.`};
    return {allowed:true};
  }
}
