import test from 'node:test';
import assert from 'node:assert/strict';
import {listVoiceFaultDrills,runVoiceFaultDrill} from '../scripts/voice-fault-drill-coordinator.mjs';
const env={ALEX_VOICE_FAULT_DRILL_TEST_MODE:'1'};
function adapter({fault='CHAT_PROVIDER_HTTP_503',healthy=true,events=[]}={}){
 return {
  async prepare(){events.push('prepare');},async inject(){events.push('inject');},
  async observeFault(){events.push('observe');return {code:fault};},
  async recover(){events.push('recover');},async verifyHealthyTurn(){events.push('healthy');return healthy;},
  async cleanup(){events.push('cleanup');}
 };
}
test('R81 只公开四种明确故障场景并在健康 turn 后清理',async()=>{
 assert.deepEqual(listVoiceFaultDrills().map(x=>x.id),
  ['provider-503','provider-timeout','capture-device-unavailable','playback-device-unavailable']);
 const events=[];const result=await runVoiceFaultDrill({scenarioId:'provider-503',adapter:adapter({events}),env});
 assert.equal(result.status,'passed');assert.equal(result.recovered,true);
 assert.deepEqual(events,['prepare','inject','observe','recover','healthy','cleanup']);
});
test('R81 错误码不匹配或恢复后不健康必须失败，但仍执行 cleanup',async()=>{
 const events=[];
 await assert.rejects(runVoiceFaultDrill({scenarioId:'provider-503',adapter:adapter({fault:'OTHER',events}),env}),
  /VOICE_FAULT_DRILL_UNEXPECTED_FAULT/);
 assert.equal(events.at(-1),'cleanup');
 const second=[];
 await assert.rejects(runVoiceFaultDrill({scenarioId:'provider-503',adapter:adapter({healthy:false,events:second}),env}),
  /VOICE_FAULT_DRILL_POST_RECOVERY_UNHEALTHY/);
 assert.equal(second.at(-1),'cleanup');
});
test('R81 未批准的真实执行不能触发 adapter',async()=>{
 let invoked=false;const a=adapter();
 a.prepare=async()=>{invoked=true;};
 await assert.rejects(runVoiceFaultDrill({scenarioId:'provider-503',adapter:a,env:{}}),
  /VOICE_FAULT_DRILL_APPROVAL_REQUIRED/);
 assert.equal(invoked,false);
});
