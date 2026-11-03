import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const [html,css,js,nav]=await Promise.all(['public/index.html','public/styles.css','public/app.js','public/navigation.js'].map(p=>readFile(join(root,p),'utf8')));
const routes=['overview','tasks','devices','skills','events','family'];

test('Console v2 has six live workspaces while preserving v0.2–v0.8 task and device controls',()=>{
 for(const route of routes){
  assert.match(html,new RegExp(`href="#${route}" data-page-link="${route}"`));
  assert.match(html,new RegExp(`data-nav-view="${route}"`));
  assert.match(nav,new RegExp(`${route}:\\s*\\{`));
 }
 for(const id of ['command-form','floorplan','gateway-pair-form','gateway-command-form','workflow-form','plan-form','proposal-form','proposal-list','plan-events','gateway-tasks','skills-list','events','auth-form'])assert.ok(html.includes(`id="${id}"`),`${id} missing`);
 assert.equal((html.match(/id="skills-list"/g)||[]).length,1,'single interactive skill view');
 assert.match(html,/<section id="global-safety"[^>]*aria-label="全局模拟安全控制"/);
 assert.equal((html.match(/id="btn-stop"/g)||[]).length,1);
 assert.ok(html.indexOf('id="global-safety"')<html.indexOf('data-nav-view="overview"'));
});

test('Console v2 route CSS cannot override explicit authorization and interrupted workflow states',()=>{
 assert.match(css,/body \[data-nav-view\]\.hidden/);
 assert.match(css,/\.hidden\[data-nav-view\]\{display:none!important\}/);
 assert.match(js,/\$\('gateway-section'\)\.classList\.toggle\('hidden',!parent\)/);
 assert.match(js,/\$\('proposal-review-panel'\)\.classList\.toggle\('hidden',!parent\)/);
 assert.match(js,/\$\('family-private'\)\.classList\.toggle\('hidden',!parent\)/);
 assert.match(js,/session\.mode==='local'&&session\.authenticated\?session\.actor:null/);
});

test('Console v2 shows action results across all workspaces, and urgent stop bypasses ordinary action lock',()=>{
 assert.match(js,/el\.classList\.remove\('hidden'\)/);
 assert.match(js,/refreshInFlight=true/);
 assert.match(js,/const emergency=path==='\/api\/safety\/stop'/);
 assert.match(js,/if\(busy&&!emergency\)return/);
 assert.match(js,/\$\('skills-list'\)\.addEventListener\('click'/);
 assert.match(js,/\$\('events-filter'\)\.addEventListener\('input'/);
 assert.match(css,/\.global-safety/);
});

test('Console v2 has one authenticated lifecycle, no repeated console-wrapper timers',()=>{
 assert.doesNotMatch(js,/(oldLaunchConsole|previousLaunchForWorkflows|previousLaunchForPlans|previousLaunchForProposals)/);
 assert.equal((js.match(/function launchConsole\(/g)||[]).length,1);
 assert.equal((js.match(/new EventSource\('/g)||[]).length,1);
 assert.equal((js.match(/setInterval\(refreshGateway|setInterval\(refreshWorkflows|setInterval\(refreshPlans|setInterval\(refreshProposals/g)||[]).length,0);
 assert.match(js,/function refreshCurrentView\(force=false\)/);
 assert.match(js,/void initAuth\(\);\s*$/);
});

test('Family workspace uses existing parent-scoped APIs and confirms irreversible operations',()=>{
 for(const url of ['/api/profiles','/api/memory','/api/privacy/export','/api/privacy/erase','/api/audit'])assert.ok(js.includes(url));
 assert.match(js,/window\.confirm\('/);
 assert.match(html,/id="privacy-erase-scope"/);
 assert.match(html,/id="family-access-note"/);
});
