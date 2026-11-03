// v0.9 — SIMULATION ONLY. No ROS 2 nodes, motor drivers, GPIO or physical safety system.
// Shared occupancy and A* route algorithm from the existing TypeScript simulation.
import {MAP, findPath, occupied} from '../dist/robot/map.js';

export const SIM_MAP_VERSION='alex-home-grid-v1';
export const SIM_DESTINATIONS=Object.freeze(Object.keys(MAP.destinations));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=value=>Math.round(value*100)/100;
export const initialPose=()=>({x:MAP.destinations.dock.x,y:MAP.destinations.dock.y,heading:0});

// A goal/feedback interface designed for a future replaceable ROS 2 Nav2 bridge.
export class GridNavigationBridge {
  constructor({pose=initialPose(),stepDelayMs=25,stepsPerTick=3,obstaclePresent=false}={}){
    if(!Number.isInteger(stepsPerTick)||stepsPerTick<1||stepsPerTick>10||!Number.isFinite(stepDelayMs)||stepDelayMs<0||stepDelayMs>2000)throw new Error('INVALID_SIM_SETTINGS');
    this.pose={...pose};this.stepDelayMs=stepDelayMs;this.stepsPerTick=stepsPerTick;this.obstaclePresent=obstaclePresent;
  }
  async navigate(destination,{onFeedback=async()=>{},isCancelled=()=>false}={}){
    if(!SIM_DESTINATIONS.includes(destination))throw new Error('INVALID_SIM_DESTINATION');
    const target=MAP.destinations[destination];
    if(occupied(this.pose.x,this.pose.y,this.obstaclePresent))throw new Error('INVALID_SIM_START');
    if(isCancelled())return {status:'cancelled',pose:{...this.pose}};
    const route=findPath(this.pose,target,this.obstaclePresent);
    if(!route.length && Math.hypot(this.pose.x-target.x,this.pose.y-target.y)>0.5){return {status:'blocked',pose:{...this.pose}};}
    let seq=0;
    await onFeedback({sequence:++seq,phase:'planning',progress:0,pose:{...this.pose},mapVersion:SIM_MAP_VERSION});
    const total=route.length;
    for(let offset=0;offset<total;offset+=this.stepsPerTick){
      if(isCancelled())return {status:'cancelled',pose:{...this.pose}};
      await sleep(this.stepDelayMs);
      if(isCancelled())return {status:'cancelled',pose:{...this.pose}};
      const step=route[Math.min(offset+this.stepsPerTick,total)-1];
      if(occupied(step.x,step.y,this.obstaclePresent))return {status:'blocked',pose:{...this.pose}};
      this.pose={x:step.x,y:step.y,heading:round(Math.atan2(step.y-this.pose.y,step.x-this.pose.x))};
      await onFeedback({sequence:++seq,phase:'moving',progress:Math.min(99,Math.round((offset+Math.min(this.stepsPerTick,total-offset))/Math.max(1,total)*100)),pose:{...this.pose},mapVersion:SIM_MAP_VERSION});
    }
    if(isCancelled())return {status:'cancelled',pose:{...this.pose}};
    this.pose={...this.pose,x:target.x,y:target.y};
    await onFeedback({sequence:++seq,phase:'arrived',progress:100,pose:{...this.pose},mapVersion:SIM_MAP_VERSION});
    return {status:'arrived',pose:{...this.pose}};
  }
}
