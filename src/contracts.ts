export type Actor = 'parent' | 'child';
export type Capability = 'navigation.goto' | 'navigation.dock' | 'audio.input' | 'audio.output' | 'display.face';
export type Destination = 'dock' | 'study_desk' | 'sofa' | 'story_corner';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped';
export interface Vec2 { x: number; y: number }
export interface MotionUpdate {status: 'moving' | 'arrived' | 'blocked' | 'idle' | 'stopped'; progress: number}
export interface RobotRuntime {
  readonly id: string;
  getState(): RobotState;
  getPath(): Vec2[];
  navigate(destination: Destination, maxSpeed?: number): void;
  tick(seconds: number): MotionUpdate;
  stop(): void;
  emergencyStop(): void;
  resetEmergencyStop(): void;
  setObstacle(present: boolean): void;
}
export interface RobotState {
  deviceId: string;
  x: number;
  y: number;
  heading: number;
  battery: number;
  online: boolean;
  emergencyStopped: boolean;
  obstaclePresent: boolean;
  movement: 'idle' | 'moving' | 'stopped';
}
export interface NavigationCommand {
  capability: 'navigation.goto' | 'navigation.dock';
  params: { destination: Destination };
  actor: Actor;
}
export interface RobotTask {
  id: string;
  capability: Capability;
  destination: Destination;
  actor: Actor;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  reason?: string;
}
export interface DeviceDescriptor {
  id: string;
  name: string;
  type: string;
  capabilities: Capability[];
  online: boolean;
}
export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  allowedActors: Actor[];
}
export interface HomeEvent {
  seq: number;
  timestamp: string;
  type: 'robot.state' | 'task.updated' | 'skill.invoked' | 'policy.denied' | 'system.message';
  message: string;
  data?: unknown;
}
export type CommandResult = {
  ok: boolean;
  message: string;
  task?: RobotTask;
  skill?: string;
};
export const destinations: Destination[] = ['dock', 'study_desk', 'sofa', 'story_corner'];
export const actors: Actor[] = ['parent', 'child'];
