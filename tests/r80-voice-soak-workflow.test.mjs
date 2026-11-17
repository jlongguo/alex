import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('R80 soak workflow 只允许 <=4h segment，避免伪造单 Job 8/24/72h',async()=>{
 const source=await readFile(new URL('../.github/workflows/voice-runtime-soak.yml',import.meta.url),'utf8');
 assert.match(source,/segment_hours:/);
 assert.match(source,/options: \['1','2','4'\]/);
 assert.match(source,/timeout-minutes: 300/);
 assert.match(source,/runs-on: \[self-hosted, linux, x64, alex-acoustic\]/);
 assert.match(source,/--interval-ms 60000/);
 assert.doesNotMatch(source,/options: \['8','24','72'\]/);
 assert.match(source,/actions\/checkout@[0-9a-f]{40}/);
 assert.match(source,/actions\/setup-node@[0-9a-f]{40}/);
 assert.match(source,/actions\/upload-artifact@[0-9a-f]{40}/);
});
