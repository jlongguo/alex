import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');

test('R71 CI evidence-summary 在三个独立验证域结束后始终运行，但不改变原 Job 结论',async()=>{
 const workflow=await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8');
 const summary=workflow.slice(workflow.indexOf('\n  evidence-summary:'));
 assert.match(summary,/if: \$\{\{ always\(\) \}\}/);
 assert.match(summary,/needs: \[test, browser, sim-static\]/);
 assert.match(summary,/ALEX_CI_TEST_RESULT: \$\{\{ needs\.test\.result \}\}/);
 assert.match(summary,/ALEX_CI_BROWSER_RESULT: \$\{\{ needs\.browser\.result \}\}/);
 assert.match(summary,/ALEX_CI_SIM_STATIC_RESULT: \$\{\{ needs\['sim-static'\]\.result \}\}/);
 assert.doesNotMatch(summary,/continue-on-error:/);
});

test('R71 CI evidence-summary 只写固定 JSON 并显式上传隐藏 .local 路径',async()=>{
 const workflow=await readFile(resolve(root,'.github/workflows/ci.yml'),'utf8');
 const summary=workflow.slice(workflow.indexOf('\n  evidence-summary:'));
 assert.match(summary,/node scripts\/ci-evidence\.mjs write \.local\/ci\/evidence\.json/);
 assert.match(summary,/node scripts\/ci-evidence\.mjs verify \.local\/ci\/evidence\.json/);
 assert.match(summary,/name: alex-ci-evidence/);
 assert.match(summary,/include-hidden-files: true/);
 assert.match(summary,/path: \.local\/ci\/evidence\.json/);
 assert.doesNotMatch(summary,/secrets\./);
});

test('R71 package 暴露 release matrix 与 CI evidence CLI，不替换既有 runtime verifier',async()=>{
 const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
 assert.equal(pkg.scripts['release:matrix'],'node scripts/release-readiness-matrix.mjs');
 assert.equal(pkg.scripts['ci:evidence'],'node scripts/ci-evidence.mjs');
 assert.equal(pkg.scripts['release:runtime-evidence'],
  'python3 scripts/runtime-acceptance-gate.py');
});

test('R71 家长 readiness API 只用本次静态 report 生成在线 matrix，不读取任意外部证据文件',async()=>{
 const server=await readFile(resolve(root,'scripts/server.mjs'),'utf8');
 const at=server.indexOf("pathname==='/api/release/readiness'");
 assert.ok(at>0);
 const code=server.slice(at,at+2200);
 assert.match(code,/composeReleaseReadinessMatrix\(\{staticReadiness:report\}\)/);
 assert.match(code,/send\(res,200,\{ok:true,report,matrix\}\)/);
 assert.doesNotMatch(code,/runtimeGate:|ciEvidence:|RUNTIME_ACCEPTANCE.*FILE|CI_EVIDENCE.*FILE/);
});

test('R71 家长面板分别展示静态检查与证据矩阵，不提供自动批准按钮',async()=>{
 const html=await readFile(resolve(root,'public/index.html'),'utf8');
 const app=await readFile(resolve(root,'public/app.js'),'utf8');
 for(const id of ['release-readiness-matrix-status','release-readiness-matrix'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(app,/Object\.entries\(matrix\.domains\)/);
 assert.match(app,/matrix\.targets\.robotCandidate/);
 assert.match(app,/真实麦克风\/扬声器/);
 assert.doesNotMatch(html,/id="release-readiness-approve"/);
 assert.doesNotMatch(app,/releaseApproved\s*=\s*true/);
});
