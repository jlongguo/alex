import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function Guard(){
 const source=await readFile(new URL('../public/voice-duplex-guard.js',import.meta.url),'utf8');
 const context={performance:{now:()=>0},setTimeout,Promise};
 context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);
 return context.AlexVoiceDuplexGuard;
}
test('R80 Duplex Guard 禁止播放/录音重叠，并执行播放尾音冷却',async()=>{
 const C=await Guard();let now=1000;
 const guard=new C({clock:()=>now,cooldownMs:260,bargeInCooldownMs:120});
 guard.playbackStarted();
 await assert.rejects(guard.beforeCapture(),/VOICE_DUPLEX_PLAYBACK_ACTIVE/);
 guard.playbackStopped();
 let slept=0;
 await guard.beforeCapture({sleep:async ms=>{slept=ms;now+=ms;}});
 assert.equal(slept,260);
 assert.equal(guard.snapshot().phase,'capture');
 guard.captureStopped();
});
test('R80 显式 barge-in 允许打断播放，但仍保留短尾音冷却',async()=>{
 const C=await Guard();let now=2000,slept=0;
 const guard=new C({clock:()=>now,cooldownMs:300,bargeInCooldownMs:100});
 guard.playbackStarted();
 await guard.beforeCapture({bargeIn:true,sleep:async ms=>{slept=ms;now+=ms;}});
 assert.equal(slept,100);
 const snap=guard.snapshot();
 assert.equal(snap.phase,'capture');assert.equal(snap.bargeIns,1);
 assert.equal(snap.blockedOverlaps,0);
});
