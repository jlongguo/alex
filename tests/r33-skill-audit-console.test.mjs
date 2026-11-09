import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const app=readFileSync(resolve(root,'public/app.js'),'utf8');
test('R33 package controls are parent-private with accessible status regions',()=>{
 const privateIndex=html.indexOf('id="family-private"');
 const packageIndex=html.indexOf('id="skill-package-panel"');
 assert.ok(privateIndex>=0&&packageIndex>privateIndex);
 for(const id of ['skill-package-submit-form','skill-package-manifest','skill-packages-list',
  'skill-packages-refresh','skill-usage-list','skill-usage-notice','skill-packages-notice'])
  assert.ok(html.includes('id="'+id+'"'),id);
});
test('R33 console protects package actions with verified parent, safe escaping and live audit',()=>{
 assert.ok(app.includes("fetch('/api/skills/packages'"));
 assert.ok(app.includes("fetch('/api/skills/usage'"));
 assert.ok(app.includes("api('/api/skills/packages'"));
 assert.ok(app.includes("if(authorizedActor!=='parent'"));
 assert.ok(app.includes('esc(m.name)'));
 assert.ok(app.includes('esc(m.permissions.join('));
 assert.ok(app.includes('esc(row.skillId)'));
 assert.ok(app.includes("data-package-action"));
 assert.ok(app.includes("await refreshSkillPackages()"));
 assert.ok(app.includes("window.confirm("));
});
