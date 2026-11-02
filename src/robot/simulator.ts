import { destinations, type Destination, type RobotState, type RobotRuntime, type MotionUpdate, type Vec2 } from '../contracts.js';
import { findPath, MAP, occupied } from './map.js';

export class SimulatedRobot implements RobotRuntime {
  readonly id = 'robot-sim-001';
  private state: RobotState = {
    deviceId: this.id, x: MAP.destinations.dock.x, y: MAP.destinations.dock.y,
    heading: 0, battery: 98, online: true, emergencyStopped: false,
    obstaclePresent: false, movement: 'idle'
  };
  private path:Vec2[]=[];
  private initialDistance=0;
  private travelDistance=0;
  private speedMetersPerSecond=0.2;
  getState():RobotState { return {...this.state}; }
  getPath():Vec2[] {return this.path.map(p=>({...p}));}
  setObstacle(present:boolean):void {
    this.state.obstaclePresent=present;
    if(present && this.state.movement==='moving') this.stop();
  }
  navigate(destination: Destination, maxSpeed=0.2): void {
    if(!destinations.includes(destination))throw new Error('UNKNOWN_DESTINATION');
    if(!this.state.online)throw new Error('DEVICE_OFFLINE');
    if(this.state.emergencyStopped)throw new Error('EMERGENCY_STOP_ACTIVE');
    if(!Number.isFinite(maxSpeed)||maxSpeed<=0||maxSpeed>0.25)throw new Error('INVALID_SPEED');
    const route=findPath({x:this.state.x,y:this.state.y},MAP.destinations[destination],this.state.obstaclePresent);
    if(!route.length)throw new Error('NO_SAFE_ROUTE');
    this.path=route;
    this.speedMetersPerSecond=maxSpeed;
    this.initialDistance=route.length;
    this.travelDistance=0;
    this.state.movement=route.length?'moving':'idle';
  }
  tick(seconds:number):MotionUpdate {
    if(this.state.emergencyStopped) return {status:'stopped',progress:0};
    if(this.state.movement!=='moving')return {status:'idle',progress:100};
    // The simulator checks its simplified occupancy model on every move.
    // A real robot must implement collision protection independently in hardware.
    if(!Number.isFinite(seconds)||seconds<=0) return {status:'moving',progress:this.progress()};
    let remaining=Math.min(seconds,0.5)*this.speedMetersPerSecond/MAP.cellMeters;
    while(remaining>0&&this.path.length){
      const next=this.path[0]!;
      if(occupied(next.x,next.y,this.state.obstaclePresent)){
        this.stop();return {status:'blocked',progress:this.progress()};
      }
      const dx=next.x-this.state.x,dy=next.y-this.state.y;
      const dist=Math.hypot(dx,dy);
      if(dist<1e-8){this.path.shift();continue;}
      const step=Math.min(dist,remaining);
      this.state.x+=dx/dist*step;this.state.y+=dy/dist*step;
      this.state.heading=Math.atan2(dy,dx);
      this.travelDistance+=step;
      remaining-=step;
      this.state.battery=Math.max(0,this.state.battery-step*0.001);
      if(step>=dist-1e-8)this.path.shift();
    }
    if(!this.path.length){this.state.movement='idle';return {status:'arrived',progress:100};}
    return {status:'moving',progress:this.progress()};
  }
  progress():number {return this.initialDistance===0?100:Math.max(0,Math.min(99,Math.round(this.travelDistance/this.initialDistance*100)));}
  stop():void {this.path=[];this.state.movement='stopped';}
  emergencyStop():void {this.stop();this.state.emergencyStopped=true;}
  resetEmergencyStop():void {this.state.emergencyStopped=false;this.state.movement='idle';}
  setOnline(online:boolean):void {this.state.online=online;if(!online)this.stop();}
}
