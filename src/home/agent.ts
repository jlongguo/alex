import type { Destination } from '../contracts.js';
// Deterministic NLU for a reproducible MVP; NOT a language model.
export type Intent = {type:'navigate';destination:Destination}|{type:'skill';id:string}|{type:'stop'}|{type:'unknown'};
export function parseIntent(input:string):Intent {
  const s=input.trim().toLowerCase();
  if(!s)return {type:'unknown'};
  if(/急停|立即停止|紧急停止|emergency stop/.test(s))return {type:'stop'};
  if(/充电|回家|dock|charge/.test(s))return {type:'navigate',destination:'dock'};
  if(/书桌|学习区|study.?desk|desk/.test(s))return {type:'navigate',destination:'study_desk'};
  if(/客厅|沙发|sofa|living room/.test(s))return {type:'navigate',destination:'sofa'};
  if(/故事角|书架|story corner|bookshelf/.test(s))return {type:'navigate',destination:'story_corner'};
  if(/英语|英文|english|read aloud/.test(s))return {type:'skill',id:'learning.english'};
  if(/故事|story|童话/.test(s))return {type:'skill',id:'story.interactive'};
  if(/家庭状态|home status/.test(s))return {type:'skill',id:'home.status'};
  return {type:'unknown'};
}
