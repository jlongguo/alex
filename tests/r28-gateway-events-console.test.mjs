import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const js=readFileSync(resolve(root,'public/app.js'),'utf8');
test('R28 event timeline lives inside the virtual-device section',()=>{
 const start=html.indexOf('id="gateway-section"');
 const end=html.indexOf('id="tasks-intro"',start);
 const panel=html.slice(start,end);
 assert.ok(start>=0&&end>start);
 assert.ok(panel.includes('id="gateway-events"'));
 assert.ok(panel.includes('id="gateway-events-notice"'));
 assert.ok(panel.includes('家长可见'));
});
test('R28 parent console queries cursor endpoint and escapes each metadata field',()=>{
 assert.ok(js.includes("fetch('/api/gateway/events?after='+gatewayEventCursor+'&limit=100'"));
 assert.ok(js.includes("if(!authorizedActor||authorizedActor!=='parent')return;"));
 for(const value of ['e.type','e.status','e.deviceId','e.jobId','e.requestId'])
  assert.ok(js.includes('esc('+value+')'),value);
 assert.ok(js.includes('timeline.cursorExpired'));
 assert.ok(js.includes('gatewayEventCache.slice(-20).reverse()'));
});
