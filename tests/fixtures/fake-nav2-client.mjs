// Deterministic JSONL action peer for testing the adapter; NOT ROS 2.
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
let started=false,lastGoal=null;
for await(const line of lines){
  let msg;try{msg=JSON.parse(line);}catch{continue;}
  if(msg.type==='cancel'){
    const mode=process.env.ALEX_TEST_NAV2_MODE;
    if(mode==='ignore-cancel')continue;
    if(mode==='success-after-cancel'){
      // 复现 Python/Nav2 成功终态与取消请求发生竞争的情况。
      process.stdout.write(JSON.stringify({
        type:'feedback',distance_remaining:0,
        pose:{x:lastGoal.x,y:lastGoal.y,yaw:0}
      })+'\n');
      process.stdout.write(JSON.stringify({type:'result',status:'succeeded'})+'\n');
      break;
    }
    if(mode==='cancel-rejected'){
      process.stdout.write(JSON.stringify({
        type:'result',status:'failed',reason:'NAV2_CANCEL_NOT_ACKNOWLEDGED'
      })+'\n');
      break;
    }
    if(mode==='cancel-terminal-mismatch'){
      process.stdout.write(JSON.stringify({
        type:'result',status:'failed',reason:'NAV2_CANCEL_TERMINAL_NOT_CANCELED'
      })+'\n');
      break;
    }
    process.stdout.write(JSON.stringify({type:'result',status:'cancelled'})+'\n');
    break;
  }
  if(msg.type==='navigate'&&!started){
    started=true;lastGoal=msg.goal;
    process.stdout.write(JSON.stringify({type:'ready'})+'\n');
    const mode=process.env.ALEX_TEST_NAV2_MODE??'success';
    // 故障注入时可以选择不回复取消请求，验证宿主端有界超时。
    if(['hold','ignore-cancel','success-after-cancel','cancel-rejected','cancel-terminal-mismatch'].includes(mode))continue;
    if(mode==='reject'){
      process.stdout.write(JSON.stringify({type:'result',status:'rejected'})+'\n');
      break;
    }
    const pose=mode==='far'?{x:0.7,y:2.8,yaw:0}:{x:msg.goal.x,y:msg.goal.y,yaw:0};
    process.stdout.write(JSON.stringify({type:'feedback',distance_remaining:mode==='far'?2:0,pose})+'\n');
    process.stdout.write(JSON.stringify({type:'result',status:'succeeded'})+'\n');
    break;
  }
}
