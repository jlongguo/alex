import type { Destination, Vec2 } from '../contracts.js';

export const MAP = {
  width: 60, height: 34, cellMeters: 0.1,
  destinations: {
    dock: { x: 7, y: 28 },
    study_desk: { x: 17, y: 16 },
    sofa: { x: 32, y: 16 },
    story_corner: { x: 49, y: 17 },
  } satisfies Record<Destination, Vec2>,
  walls: [
    {x:0,y:0,w:60,h:1}, {x:0,y:33,w:60,h:1},
    {x:0,y:0,w:1,h:34}, {x:59,y:0,w:1,h:34},
    {x:21,y:1,w:1,h:12}, {x:21,y:22,w:1,h:11},
    {x:41,y:1,w:1,h:10}, {x:41,y:21,w:1,h:12}
  ],
  furniture: [
    {x:5,y:4,w:11,h:7,label:'书桌'},
    {x:27,y:4,w:10,h:7,label:'沙发'},
    {x:47,y:4,w:9,h:8,label:'书架'},
    {x:27,y:25,w:10,h:5,label:'餐桌'}
  ]
} as const;

export function occupied(x: number, y: number, extra = false): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 2 || y < 2 || x >= MAP.width - 2 || y >= MAP.height - 2) return true;
  const obstacles = [...MAP.walls, ...MAP.furniture];
  // A cell of clearance models a small robot footprint. This is simulation only.
  if (obstacles.some(r => x >= r.x-1 && x < r.x+r.w+1 && y >= r.y-1 && y < r.y+r.h+1)) return true;
  // Optional dynamic obstacle (person or toy) near the shared corridor.
  return extra && Math.hypot(x - 26, y - 17) <= 2.5;
}

export function findPath(start: Vec2, goal: Vec2, obstaclePresent = false): Vec2[] {
  const toKey = (p: Vec2) => `${p.x},${p.y}`;
  const fromKey = (k: string): Vec2 => { const [x,y]=k.split(',').map(Number); return {x:x!,y:y!}; };
  const s = {x:Math.round(start.x),y:Math.round(start.y)};
  const g = {x:Math.round(goal.x),y:Math.round(goal.y)};
  if (occupied(s.x,s.y,obstaclePresent) || occupied(g.x,g.y,obstaclePresent)) return [];
  const startKey = toKey(s), endKey = toKey(g);
  if (startKey === endKey) return [g];
  const open = new Map<string, number>([[startKey, 0]]);
  const gScore = new Map<string, number>([[startKey, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const heuristic = (p:Vec2)=>Math.abs(p.x-g.x)+Math.abs(p.y-g.y);
  while (open.size) {
    let bestKey = '', bestScore=Infinity;
    for (const [key, score] of open) if(score<bestScore) {bestScore=score;bestKey=key;}
    open.delete(bestKey);
    if (bestKey === endKey) {
      const path:Vec2[]=[];let key=bestKey;
      while(key!==startKey) {path.push(fromKey(key));key=prev.get(key)!;}
      path.reverse();return path;
    }
    done.add(bestKey);
    const p=fromKey(bestKey);
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const n={x:p.x+dx!,y:p.y+dy!},key=toKey(n);
      if(done.has(key)||occupied(n.x,n.y,obstaclePresent))continue;
      const next=(gScore.get(bestKey)??Infinity)+1;
      if(next<(gScore.get(key)??Infinity)) {
        prev.set(key,bestKey);gScore.set(key,next);open.set(key,next+heuristic(n));
      }
    }
  }
  return [];
}
