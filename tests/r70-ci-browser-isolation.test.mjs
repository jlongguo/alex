import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');

test('R70 Chromium 使用显式 localhost CDP 端口并直接探测 HTTP endpoint，不再依赖 DevToolsActivePort',async()=>{
 const source=await readFile(resolve(root,'scripts/browser-acceptance.mjs'),'utf8');
 assert.doesNotMatch(source,/DevToolsActivePort/);
 assert.match(source,/--remote-debugging-address=127\.0\.0\.1/);
 assert.match(source,/--remote-debugging-port='\+port/);
 assert.match(source,/http:\/\/127\.0\.0\.1:'\+port\+'\/json\/list/);
 assert.match(source,/const port=await freePort\(\)/);
});

test('R70 headless Chromium 不继承 GitHub runner 的 D-Bus session/starter 地址',async()=>{
 const source=await readFile(resolve(root,'scripts/browser-acceptance.mjs'),'utf8');
 assert.match(source,/const chromeEnv=\{\.\.\.process\.env\}/);
 assert.match(source,/delete chromeEnv\.DBUS_SESSION_BUS_ADDRESS/);
 assert.match(source,/delete chromeEnv\.DBUS_STARTER_ADDRESS/);
 assert.match(source,/delete chromeEnv\.DBUS_STARTER_BUS_TYPE/);
 assert.match(source,/spawn\(executable,args,\{[\s\S]*env:chromeEnv/);
});

test('R70 Chrome readiness 仍 fail closed：浏览器退出或 CDP endpoint 超时都不能当作通过',async()=>{
 const source=await readFile(resolve(root,'scripts/browser-acceptance.mjs'),'utf8');
 assert.match(source,/R54_CHROME_EXITED/);
 assert.match(source,/R54_CHROME_DEVTOOLS_NOT_READY/);
 assert.match(source,/for\(let i=0;i<180;i\+\+\)/);
 assert.match(source,/await stopProcess\(child\)/);
});

test('R70 npm run test:browser 自带 build，独立 Job 不依赖此前 npm test 产生的 dist',async()=>{
 const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
 assert.equal(pkg.scripts['test:browser'],
  'npm run build && node scripts/browser-acceptance.mjs');
});

test('R70 Verify workflow 保留既有 test check，并把 browser 与 sim-static 拆成独立无 needs Job',async()=>{
 const workflow=await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8');
 assert.match(workflow,/\n  test:\n/);
 assert.match(workflow,/\n  browser:\n/);
 assert.match(workflow,/\n  sim-static:\n/);

 const testBlock=workflow.slice(workflow.indexOf('\n  test:'),workflow.indexOf('\n  browser:'));
 const browserBlock=workflow.slice(workflow.indexOf('\n  browser:'),workflow.indexOf('\n  sim-static:'));
 const simBlock=workflow.slice(workflow.indexOf('\n  sim-static:'));

 assert.match(testBlock,/npm test/);
 assert.doesNotMatch(testBlock,/test:browser|sim:check|sim:preflight/);
 assert.match(browserBlock,/npm run test:browser/);
 assert.doesNotMatch(browserBlock,/npm test|sim:check|sim:preflight|\n    needs:/);
 assert.match(simBlock,/npm run sim:check/);
 assert.match(simBlock,/npm run sim:preflight/);
 assert.doesNotMatch(simBlock,/test:browser|\n    needs:/);
});

test('R70 ROS preflight Artifact 显式包含 .local 隐藏目录，避免成功检查后上传空 Artifact',async()=>{
 const workflow=await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8');
 const simBlock=workflow.slice(workflow.indexOf('\n  sim-static:'));
 assert.match(simBlock,/name: ros-preflight-not-runtime-acceptance/);
 assert.match(simBlock,/include-hidden-files: true/);
 assert.match(simBlock,/path: \.local\/ros\/preflight\.json/);
});

test('R70 三个 CI Job 都独立安装依赖且使用 Node 22，不共享可变工作区',async()=>{
 const workflow=await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8');
 assert.equal((workflow.match(/uses: actions\/checkout@v4/g)||[]).length,3);
 assert.equal((workflow.match(/uses: actions\/setup-node@v4/g)||[]).length,3);
 assert.equal((workflow.match(/node-version: '22'/g)||[]).length,3);
 assert.equal((workflow.match(/npm install --ignore-scripts --no-audit --no-fund/g)||[]).length,3);
});
